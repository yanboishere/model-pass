package dev.modelpass.core

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.isActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * A started cross-device link (§7). Show [qrUrl] as a QR code together with [userCode], then call
 * [awaitSession]. The QR code is a one-time credential: hide it once this completes or fails.
 */
public class PendingLink internal constructor(
    private val api: ModelPassApi,
    /** Normalized rendezvous hub URL. */
    public val rendezvous: String,
    private val clientId: String,
    authorization: DeviceAuthorizationResponse,
    secret: ByteArray,
    private val issuerPolicy: IssuerPolicy,
    walletLinkUrl: String,
    startedAtMillis: Long = System.currentTimeMillis(),
) {
    private val secret: ByteArray = secret.copyOf()
    private val deviceCode: String = authorization.deviceCode
    private val rawUserCode: String = authorization.userCode

    /** Code the user can compare in the wallet, e.g. `BCDF-GHJK`. */
    public val userCode: String = LinkCrypto.formatUserCode(authorization.userCode)

    public val verificationUri: String = authorization.verificationUri

    /** Content of the QR code: `{verification_uri}#v=1&uc=…&s=…`. */
    public val qrUrl: String = LinkCrypto.buildQrUrl(authorization.verificationUri, authorization.userCode, secret)

    /** Opens the wallet directly when it is installed on this device: `modelpass://link?rv=…&uc=…&s=…`. */
    public val walletUrl: String = LinkCrypto.buildWalletLinkUrl(rendezvous, authorization.userCode, secret, walletLinkUrl)

    /** Unix epoch seconds after which the code is no longer valid. */
    public val expiresAt: Long = startedAtMillis / 1000 + authorization.expiresIn

    public val intervalSeconds: Long = authorization.interval

    private val expiresAtMillis = startedAtMillis + authorization.expiresIn * 1000
    private val mutex = Mutex()
    private var result: ModelPassSession? = null
    private var failure: ModelPassException? = null

    @Volatile private var cancelled = false

    @Volatile private var pollJob: Job? = null

    public val isCancelled: Boolean get() = cancelled

    /**
     * Polls the rendezvous hub until the user approves in the wallet, then decrypts the sealed token
     * response and returns the session. Safe to call again: the result (or terminal error) is cached.
     *
     * @throws ModelPassException.LinkDenied, [ModelPassException.LinkExpired],
     *   [ModelPassException.Cancelled] (after [cancel]), [ModelPassException.InvalidResponse],
     *   [ModelPassException.UntrustedIssuer], [ModelPassException.Network].
     */
    public suspend fun awaitSession(): ModelPassSession = mutex.withLock {
        result?.let { return@withLock it }
        failure?.let { throw it }
        try {
            if (cancelled) throw ModelPassException.Cancelled("The link was cancelled")
            val session = coroutineScope {
                val job = async { poll() }
                pollJob = job
                if (cancelled) job.cancel()
                try {
                    job.await()
                } catch (e: CancellationException) {
                    // Our own cancel() cancels only the polling child; the caller's scope is still active.
                    if (cancelled && isActive) throw ModelPassException.Cancelled("The link was cancelled")
                    throw e
                }
            }
            result = session
            secret.fill(0)
            session
        } catch (e: ModelPassException) {
            if (e !is ModelPassException.Network) {
                failure = e
                secret.fill(0)
            }
            throw e
        } finally {
            pollJob = null
        }
    }

    /** Stops polling; a pending [awaitSession] throws [ModelPassException.Cancelled]. */
    public fun cancel() {
        cancelled = true
        pollJob?.cancel()
    }

    private suspend fun poll(): ModelPassSession {
        val sealed = api.pollDeviceToken(rendezvous, deviceCode, clientId, intervalSeconds, expiresAtMillis)
        val plaintext = LinkCrypto.open(secret, rawUserCode, sealed)
        val token = TokenResponse.parse(plaintext.decodeToString())
        val issuer = issuerPolicy.validate(
            token.issuer?.takeIf { it.isNotBlank() }
                ?: throw ModelPassException.InvalidResponse("The sealed token response has no issuer"),
        )
        val apiBase = token.apiBase?.takeIf { it.isNotBlank() } ?: (issuer + "/v1")
        return ModelPassSession.fromTokenResponse(token, issuer, apiBase, issuerPolicy)
    }

    override fun toString(): String = "PendingLink(rendezvous=$rendezvous, userCode=$userCode, expiresAt=$expiresAt)"
}
