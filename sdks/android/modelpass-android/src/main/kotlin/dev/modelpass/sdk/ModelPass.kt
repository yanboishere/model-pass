package dev.modelpass.sdk

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.util.Log
import dev.modelpass.core.AuthorizationResponse
import dev.modelpass.core.ChatCompletion
import dev.modelpass.core.ChatMessage
import dev.modelpass.core.ChatRequest
import dev.modelpass.core.ChatStreamEvent
import dev.modelpass.core.GrantInfo
import dev.modelpass.core.IssuerPolicy
import dev.modelpass.core.ModelInfo
import dev.modelpass.core.ModelPassApi
import dev.modelpass.core.ModelPassAuthorization
import dev.modelpass.core.ModelPassException
import dev.modelpass.core.ModelPassProtocol
import dev.modelpass.core.ModelPassSession
import dev.modelpass.core.PendingAuthorization
import dev.modelpass.core.Slots
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.lang.ref.WeakReference

/**
 * "Continue with ModelPass" client for Android.
 *
 * Create **one** instance per configuration, ideally in `Application.onCreate()`, so that a wallet
 * redirect arriving after process death finds it:
 *
 * ```kotlin
 * val modelPass = ModelPass(context, ModelPassConfig(
 *     clientId = "com.example.chat",
 *     redirectUri = "com.example.chat:/modelpass/callback",
 *     clientName = "Example Chat",
 * ))
 * // in an Activity / ViewModel:
 * val session = modelPass.authorize(activity)          // opens the wallet
 * val reply = modelPass.chat(listOf(ChatMessage.user("你好")))
 * ```
 *
 * Observe [session] for the connection state: it is restored from [SessionStore] on start and also
 * updated when a flow completes after the original `authorize()` call was abandoned.
 *
 * Constructing an instance reads the stored session synchronously (one small encrypted file).
 */
public class ModelPass @JvmOverloads constructor(
    context: Context,
    public val config: ModelPassConfig,
    private val sessionStore: SessionStore = KeystoreSessionStore(context),
    private val api: ModelPassApi = ModelPassApi(userAgent = defaultUserAgent()),
) {
    private val appContext: Context = context.applicationContext
    private val pendingStore = PendingAuthorizationStore(appContext)
    private val issuerPolicy = IssuerPolicy(config.trustedIssuers, config.allowLocalHttpIssuers)
    private val scope = CoroutineScope(
        SupervisorJob() + Dispatchers.IO + CoroutineExceptionHandler { _, e -> Log.w(TAG, "Unexpected ModelPass error", e) },
    )
    private val sessionState = MutableStateFlow(loadStoredSession())

    /** The current session, or null when not connected. */
    public val session: StateFlow<ModelPassSession?> = sessionState.asStateFlow()

    /** Shortcut for `session.value`. */
    public val currentSession: ModelPassSession? get() = sessionState.value

    public val isAuthorized: Boolean get() = currentSession?.isExpired() == false

    /** Wallet deep link to this app's grant (`modelpass://grants/{grant_id}`, §9), or null if not connected. */
    public val manageUri: Uri? get() = currentSession?.let { Uri.parse(it.manageUrl) }

    @Volatile
    private var inFlight: InFlightAuthorization? = null

    // ---- same-device flow (§6) ----------------------------------------------------------------

    /**
     * True if an app that handles [ModelPassConfig.walletAuthorizeUrl] is installed. The library
     * manifest declares the `<queries>` entry for the `modelpass` scheme, so this works on Android 11+.
     */
    public fun isWalletInstalled(): Boolean {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(config.walletAuthorizeUrl))
        val pm = appContext.packageManager
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            pm.queryIntentActivities(intent, PackageManager.ResolveInfoFlags.of(0L)).isNotEmpty()
        } else {
            @Suppress("DEPRECATION")
            pm.queryIntentActivities(intent, 0).isNotEmpty()
        }
    }

    /**
     * Opens the wallet ("Continue with ModelPass") and suspends until the user approves.
     *
     * The pending request (state + PKCE verifier) is persisted first, so the flow also completes if
     * the process dies while the wallet is open: [session] is then updated once the redirect arrives.
     *
     * @throws ModelPassException.WalletNotInstalled no wallet handles the request; offer [startLink].
     * @throws ModelPassException.AccessDenied the user declined.
     * @throws ModelPassException.Cancelled the user came back without approving, or a newer call superseded this one.
     * @throws ModelPassException.InvalidState, [ModelPassException.UntrustedIssuer],
     *   [ModelPassException.TokenExchangeFailed], [ModelPassException.AuthorizationFailed], [ModelPassException.Network]
     */
    public suspend fun authorize(
        activity: Activity,
        scopes: List<String> = config.scopes,
        slots: List<String> = config.slots,
        budgetHint: Long? = config.budgetHint,
    ): ModelPassSession {
        val prepared = ModelPassAuthorization.prepare(
            clientId = config.clientId,
            redirectUri = config.redirectUri,
            scopes = scopes,
            slots = slots,
            clientName = config.clientName,
            budgetHint = budgetHint,
            walletAuthorizeUrl = config.walletAuthorizeUrl,
        )
        withContext(Dispatchers.IO) { pendingStore.save(prepared.pending) }

        val attempt = InFlightAuthorization(prepared.pending)
        val returned = CompletableDeferred<Unit>()
        val watcher = withContext(Dispatchers.Main.immediate) {
            inFlight?.result?.completeExceptionally(ModelPassException.Cancelled("Superseded by a newer authorize() call"))
            inFlight = attempt
            val returnWatcher = ReturnWatcher(activity) { returned.complete(Unit) }
            try {
                activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(prepared.url)))
            } catch (e: ActivityNotFoundException) {
                returnWatcher.dispose()
                abandon(attempt)
                throw ModelPassException.WalletNotInstalled()
            } catch (e: SecurityException) {
                returnWatcher.dispose()
                abandon(attempt)
                throw ModelPassException.WalletNotInstalled()
            }
            returnWatcher
        }

        try {
            return coroutineScope {
                // If the user comes back to the app and no redirect follows shortly, report Cancelled.
                // A late approval still completes through handleRedirect() and updates [session].
                val canceller = launch {
                    returned.await()
                    delay(RETURN_GRACE_MILLIS)
                    if (!attempt.redirectReceived) {
                        attempt.result.completeExceptionally(
                            ModelPassException.Cancelled("The user returned from the wallet without approving"),
                        )
                    }
                }
                try {
                    attempt.result.await()
                } finally {
                    canceller.cancel()
                }
            }
        } finally {
            watcher.dispose()
            if (inFlight === attempt) inFlight = null
        }
    }

    /**
     * Handles the wallet's redirect. Returns true if [uri] is this client's redirect URI and an
     * authorization was pending. The code exchange runs in the background; it completes the pending
     * [authorize] call, or — after process death — just stores the session and updates [session].
     *
     * [ModelPassRedirectActivity] calls this for you; call it yourself only if the redirect is
     * delivered to your own activity (e.g. an https App Link).
     */
    public fun handleRedirect(uri: Uri): Boolean {
        val url = uri.toString()
        if (!acceptsRedirect(url)) return false
        val attempt = inFlight
        val pending: PendingAuthorization = attempt?.pending ?: pendingStore.load() ?: run {
            Log.w(TAG, "Ignoring a ModelPass redirect: no authorization is in progress")
            return false
        }
        attempt?.redirectReceived = true
        pendingStore.clear(pending.state) // single use

        val code = try {
            AuthorizationResponse.parse(url, pending.state, issuerPolicy)
        } catch (e: ModelPassException) {
            Log.w(TAG, "ModelPass authorization failed: ${e.message}")
            attempt?.result?.completeExceptionally(e)
            return true
        }
        scope.launch {
            try {
                val session = api.completeAuthorization(code, pending, issuerPolicy)
                storeSession(session)
                attempt?.result?.complete(session)
            } catch (e: CancellationException) {
                attempt?.result?.completeExceptionally(ModelPassException.Cancelled())
                throw e
            } catch (e: ModelPassException) {
                Log.w(TAG, "ModelPass token exchange failed: ${e.message}")
                attempt?.result?.completeExceptionally(e)
            } catch (e: Exception) {
                attempt?.result?.completeExceptionally(ModelPassException.InvalidResponse("Token exchange failed: ${e.message}", e))
            }
        }
        return true
    }

    /** [handleRedirect] for an incoming `Intent` (uses its data URI). */
    public fun handleRedirect(intent: Intent): Boolean {
        val data = intent.data ?: return false
        return handleRedirect(data)
    }

    // ---- cross-device link flow (§7) ----------------------------------------------------------

    /**
     * Starts the QR-code flow for devices without the wallet (tablets, TVs…). Show
     * [ModelPassLink.qrUrl] as a QR code and [ModelPassLink.userCode] as text, then call
     * [ModelPassLink.awaitSession]; the resulting session is stored and published on [session].
     *
     * @param rendezvous Hub that relays the encrypted result; defaults to [ModelPassConfig.linkRendezvous].
     */
    public suspend fun startLink(
        rendezvous: String? = config.linkRendezvous,
        scopes: List<String> = config.scopes,
        slots: List<String> = config.slots,
    ): ModelPassLink {
        val hub = rendezvous
            ?: throw IllegalStateException("No rendezvous hub: pass one or set ModelPassConfig.linkRendezvous")
        val pending = api.startLink(hub, config.clientId, scopes, slots, config.clientName, issuerPolicy)
        return ModelPassLink(pending) { session -> withContext(Dispatchers.IO) { storeSession(session) } }
    }

    // ---- grant & lifecycle (§8.6, §9) -----------------------------------------------------------

    /** `GET {api_base}/modelpass/grant`: status, slots and budget of this app's grant. */
    public suspend fun grantInfo(): GrantInfo = withSession { api.grantInfo(it) }

    /** `GET {api_base}/models`: slots (and allowed models) usable by this app. */
    public suspend fun models(): List<ModelInfo> = withSession { api.models(it) }

    /**
     * Forgets the session locally and, if [revoke] is true, revokes the token at the hub
     * (best effort, errors are ignored: the user can always revoke in the wallet).
     */
    public suspend fun signOut(revoke: Boolean = true) {
        val current = currentSession
        withContext(Dispatchers.IO) {
            clearStoredSession(expected = null)
            pendingStore.clear()
        }
        if (revoke && current != null) {
            withTimeoutOrNull(REVOKE_TIMEOUT_MILLIS) {
                try {
                    api.revoke(current)
                } catch (e: ModelPassException) {
                    Log.w(TAG, "ModelPass token revocation failed: ${e.message}")
                }
            }
        }
    }

    /** Opens this app's grant in the wallet so the user can switch models, change the budget or revoke. */
    public fun openWalletManagement(activity: Activity): Boolean {
        val uri = manageUri ?: return false
        return try {
            activity.startActivity(Intent(Intent.ACTION_VIEW, uri))
            true
        } catch (e: ActivityNotFoundException) {
            false
        }
    }

    // ---- model API (§8) -----------------------------------------------------------------------

    /**
     * Non-streaming chat completion. A 401 (`invalid_token`, `grant_revoked`, `grant_expired`) clears
     * the session before the [ModelPassException.Api] is rethrown.
     */
    public suspend fun chat(request: ChatRequest): ChatCompletion = withSession { api.chat(it, request) }

    public suspend fun chat(messages: List<ChatMessage>, model: String = Slots.DEFAULT): ChatCompletion =
        chat(ChatRequest(messages, model))

    /** Streaming chat completion (SSE). Cancel the collecting coroutine to stop generation. */
    public fun streamChat(request: ChatRequest): Flow<ChatStreamEvent> = flow {
        val current = requireSession()
        emitAll(
            api.streamChat(current, request).catch { e ->
                if (e is ModelPassException.Api && e.requiresReauthorization) {
                    withContext(Dispatchers.IO) { clearStoredSession(expected = current) }
                }
                throw e
            },
        )
    }

    public fun streamChat(messages: List<ChatMessage>, model: String = Slots.DEFAULT): Flow<ChatStreamEvent> =
        streamChat(ChatRequest(messages, model))

    // ---- internals ----------------------------------------------------------------------------

    private class InFlightAuthorization(val pending: PendingAuthorization) {
        val result = CompletableDeferred<ModelPassSession>()

        @Volatile
        var redirectReceived = false
    }

    private fun acceptsRedirect(url: String): Boolean = ModelPassAuthorization.isRedirectFor(url, config.redirectUri)

    private fun abandon(attempt: InFlightAuthorization) {
        if (inFlight === attempt) inFlight = null
        pendingStore.clear(attempt.pending.state)
    }

    private fun loadStoredSession(): ModelPassSession? {
        val stored = try {
            sessionStore.load()
        } catch (e: Exception) {
            Log.w(TAG, "Could not load the ModelPass session (${e.javaClass.simpleName})")
            null
        }
        if (stored != null && stored.isExpired()) {
            runCatching { sessionStore.clear() }
            return null
        }
        return stored
    }

    private fun storeSession(session: ModelPassSession) {
        try {
            sessionStore.save(session)
        } catch (e: Exception) {
            Log.w(TAG, "Could not persist the ModelPass session (${e.javaClass.simpleName}); keeping it in memory")
        }
        sessionState.value = session
    }

    /** Clears the session, but only if it is still [expected] (null = unconditionally). */
    private fun clearStoredSession(expected: ModelPassSession?) {
        if (expected == null) {
            sessionState.value = null
        } else if (!sessionState.compareAndSet(expected, null)) {
            return
        }
        try {
            sessionStore.clear()
        } catch (e: Exception) {
            Log.w(TAG, "Could not clear the stored ModelPass session (${e.javaClass.simpleName})")
        }
    }

    private suspend fun requireSession(): ModelPassSession {
        val current = currentSession ?: throw ModelPassException.NotAuthorized()
        if (current.isExpired()) {
            withContext(Dispatchers.IO) { clearStoredSession(expected = current) }
            throw ModelPassException.NotAuthorized("The ModelPass session has expired; authorize again")
        }
        return current
    }

    private suspend fun <T> withSession(block: suspend (ModelPassSession) -> T): T {
        val current = requireSession()
        try {
            return block(current)
        } catch (e: ModelPassException.Api) {
            if (e.requiresReauthorization) withContext(Dispatchers.IO) { clearStoredSession(expected = current) }
            throw e
        }
    }

    init {
        register(this)
        // A redirect may have arrived before this instance existed (process restarted in the wallet).
        pendingStore.takeStashedRedirect { acceptsRedirect(it) }?.let { handleRedirect(Uri.parse(it)) }
    }

    public companion object {
        private const val TAG = "ModelPass"
        private const val RETURN_GRACE_MILLIS = 1_500L
        private const val REVOKE_TIMEOUT_MILLIS = 10_000L

        private val instances = mutableListOf<WeakReference<ModelPass>>()

        private fun register(instance: ModelPass) {
            synchronized(instances) {
                instances.removeAll { it.get() == null }
                instances.add(WeakReference(instance))
            }
        }

        private fun liveInstances(): List<ModelPass> = synchronized(instances) { instances.mapNotNull { it.get() } }

        /**
         * Routes a redirect to the live [ModelPass] instance it belongs to. If none exists yet (the
         * process was restarted while the user was in the wallet), the redirect is kept for two minutes
         * and handled as soon as a matching instance is created.
         */
        @JvmStatic
        public fun dispatchRedirect(context: Context, uri: Uri): Boolean {
            val live = liveInstances()
            for (instance in live) {
                if (instance.handleRedirect(uri)) return true
            }
            val url = uri.toString()
            if (live.none { it.acceptsRedirect(url) }) PendingAuthorizationStore(context).stashRedirect(uri)
            return false
        }
    }
}

internal fun defaultUserAgent(): String =
    "modelpass-android/${ModelPassProtocol.SDK_VERSION} (Android ${Build.VERSION.RELEASE}; API ${Build.VERSION.SDK_INT})"
