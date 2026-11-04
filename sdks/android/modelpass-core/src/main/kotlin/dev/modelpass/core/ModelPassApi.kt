package dev.modelpass.core

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap

/**
 * HTTP client for the hub-facing parts of ModelPass Connect: discovery (§5), token exchange
 * (§6.3), the link flow (§7), grant info (§8.6), revocation (§9) and OpenAI-compatible chat (§8.3).
 *
 * All functions are main-safe: blocking I/O runs on [dispatcher] (default [Dispatchers.IO]).
 * Errors are reported as [ModelPassException] subclasses.
 */
public class ModelPassApi @JvmOverloads constructor(
    connectTimeoutMillis: Int = 15_000,
    /** Read timeout for protocol calls (discovery, token, grant info…). */
    private val readTimeoutMillis: Int = 30_000,
    /** Read timeout for chat calls (time to first byte / between stream chunks). */
    private val chatReadTimeoutMillis: Int = 600_000,
    userAgent: String = DEFAULT_USER_AGENT,
    dispatcher: CoroutineDispatcher = Dispatchers.IO,
) {
    private val transport = HttpTransport(connectTimeoutMillis, userAgent, dispatcher)
    private val discoveryCache = ConcurrentHashMap<String, DiscoveryDocument>()

    // ---- discovery (§5) -------------------------------------------------------------------

    /**
     * Fetches `{issuer}/.well-known/modelpass-configuration`. Returns null if the hub does not
     * publish a (valid) document; callers then use the conventional paths. Results are cached.
     * @throws ModelPassException.Network on I/O errors.
     */
    public suspend fun discover(issuer: String): DiscoveryDocument? {
        val base = baseUrl(issuer)
        discoveryCache[base]?.let { return it }
        val response = transport.execute(
            url = base + ModelPassProtocol.DISCOVERY_PATH,
            method = "GET",
            headers = mapOf("Accept" to JSON),
            readTimeoutMillis = readTimeoutMillis,
        )
        if (!response.isSuccessful) return null
        val document = try {
            decodeJson(DiscoveryDocument.serializer(), response.text, "discovery document")
        } catch (e: ModelPassException.InvalidResponse) {
            return null
        }
        // RFC 8414 §3.3: the document must describe the issuer it was fetched from.
        if (IssuerPolicy.normalizeOrNull(document.issuer) != IssuerPolicy.normalizeOrNull(base)) return null
        discoveryCache[base] = document
        return document
    }

    private suspend fun endpoint(issuer: String, select: (DiscoveryDocument) -> String?, defaultPath: String): String {
        val base = baseUrl(issuer)
        val fromDiscovery = discover(base)?.let(select)?.takeIf { it.isNotBlank() && IssuerPolicy.Default.isSecureUrl(it) }
        return fromDiscovery ?: (base + defaultPath)
    }

    // ---- same-device flow (§6) ----------------------------------------------------------------

    /**
     * `POST {token_endpoint}` with `grant_type=authorization_code` (§6.3). The token endpoint comes
     * from discovery, falling back to `{issuer}/oauth/token`.
     * @throws ModelPassException.TokenExchangeFailed if the hub rejects the code.
     */
    public suspend fun exchangeCode(
        issuer: String,
        code: String,
        redirectUri: String,
        clientId: String,
        codeVerifier: String,
    ): TokenResponse {
        val url = endpoint(issuer, { it.tokenEndpoint }, ModelPassProtocol.TOKEN_PATH)
        val response = postForm(
            url,
            listOf(
                "grant_type" to ModelPassProtocol.AUTHORIZATION_CODE_GRANT_TYPE,
                "code" to code,
                "redirect_uri" to redirectUri,
                "client_id" to clientId,
                "code_verifier" to codeVerifier,
            ),
        )
        if (!response.isSuccessful) {
            val err = oauthError(response)
            throw ModelPassException.TokenExchangeFailed(err.error, err.description, response.status)
        }
        return TokenResponse.parse(response.text)
    }

    /**
     * Exchanges a validated redirect ([AuthorizationResponse.parse]) for a [ModelPassSession].
     * Checks that the token response's `issuer` (if present) matches `iss`.
     */
    @JvmOverloads
    public suspend fun completeAuthorization(
        code: AuthorizationCode,
        pending: PendingAuthorization,
        issuerPolicy: IssuerPolicy = IssuerPolicy.Default,
    ): ModelPassSession {
        val token = exchangeCode(code.issuer, code.code, pending.redirectUri, pending.clientId, pending.codeVerifier)
        val reported = token.issuer?.takeIf { it.isNotBlank() }
        if (reported != null && IssuerPolicy.normalizeOrNull(reported) != code.issuer) {
            throw ModelPassException.InvalidResponse("Token response issuer '$reported' does not match iss '${code.issuer}'")
        }
        val apiBase = token.apiBase?.takeIf { it.isNotBlank() }
            ?: discover(code.issuer)?.apiBase?.takeIf { it.isNotBlank() }
            ?: (code.issuer + "/v1")
        return ModelPassSession.fromTokenResponse(token, code.issuer, apiBase, issuerPolicy)
    }

    // ---- link flow (§7) -----------------------------------------------------------------------

    /** `POST {rendezvous}/oauth/device_authorization` with a `link_challenge` (§7.1). */
    public suspend fun deviceAuthorization(
        rendezvous: String,
        clientId: String,
        linkChallenge: String,
        scopes: List<String> = listOf(Scopes.CHAT),
        slots: List<String> = listOf(Slots.DEFAULT),
        clientName: String? = null,
    ): DeviceAuthorizationResponse {
        val url = endpoint(rendezvous, { it.deviceAuthorizationEndpoint }, ModelPassProtocol.DEVICE_AUTHORIZATION_PATH)
        val response = postForm(
            url,
            listOf(
                "client_id" to clientId,
                "scope" to scopes.joinToString(" "),
                "slots" to slots.joinToString(" "),
                "client_name" to clientName,
                "link_challenge" to linkChallenge,
                "link_challenge_method" to ModelPassProtocol.CODE_CHALLENGE_METHOD,
            ),
        )
        if (!response.isSuccessful) {
            val err = oauthError(response)
            throw ModelPassException.AuthorizationFailed(err.error, err.description)
        }
        return decodeJson(DeviceAuthorizationResponse.serializer(), response.text, "device authorization response")
    }

    /**
     * Polls `{token_endpoint}` with the device code until the wallet completes the link (§7.4) and
     * returns the `modelpass_sealed` payload. Handles `authorization_pending`, `slow_down` (+5 s),
     * `access_denied` ([ModelPassException.LinkDenied]) and `expired_token` ([ModelPassException.LinkExpired]).
     */
    public suspend fun pollDeviceToken(
        rendezvous: String,
        deviceCode: String,
        clientId: String,
        intervalSeconds: Long,
        expiresAtMillis: Long,
    ): String {
        val url = endpoint(rendezvous, { it.tokenEndpoint }, ModelPassProtocol.TOKEN_PATH)
        var intervalMillis = intervalSeconds.coerceIn(1, 60) * 1000
        var networkFailures = 0
        while (true) {
            delay(intervalMillis)
            if (System.currentTimeMillis() >= expiresAtMillis) throw ModelPassException.LinkExpired()
            val response = try {
                postForm(
                    url,
                    listOf(
                        "grant_type" to ModelPassProtocol.DEVICE_CODE_GRANT_TYPE,
                        "device_code" to deviceCode,
                        "client_id" to clientId,
                    ),
                )
            } catch (e: ModelPassException.Network) {
                // Transient connectivity problems should not abort a QR code the user may be scanning.
                if (++networkFailures >= MAX_POLL_NETWORK_FAILURES) throw e
                continue
            }
            networkFailures = 0
            if (response.isSuccessful) {
                val body = try {
                    ModelPassJson.parseToJsonElement(response.text) as? JsonObject
                } catch (e: kotlinx.serialization.SerializationException) {
                    null
                }
                val sealed = (body?.get("modelpass_sealed") as? JsonPrimitive)?.contentOrNull
                return sealed?.takeIf { it.isNotEmpty() }
                    ?: throw ModelPassException.InvalidResponse("Link token response has no modelpass_sealed payload")
            }
            val err = oauthError(response)
            when (err.error) {
                "authorization_pending" -> Unit
                "slow_down" -> intervalMillis += 5_000
                "access_denied" -> throw ModelPassException.LinkDenied()
                "expired_token" -> throw ModelPassException.LinkExpired()
                else -> throw ModelPassException.TokenExchangeFailed(err.error, err.description, response.status)
            }
        }
    }

    /**
     * Starts the cross-device flow (§7): creates the one-time secret, registers the link with the
     * [rendezvous] hub, and returns a [PendingLink] whose [PendingLink.qrUrl] should be shown as a
     * QR code. Call [PendingLink.awaitSession] to wait for the wallet.
     */
    @JvmOverloads
    public suspend fun startLink(
        rendezvous: String,
        clientId: String,
        scopes: List<String> = listOf(Scopes.CHAT),
        slots: List<String> = listOf(Slots.DEFAULT),
        clientName: String? = null,
        issuerPolicy: IssuerPolicy = IssuerPolicy.Default,
        walletLinkUrl: String = ModelPassProtocol.DEFAULT_WALLET_LINK_URL,
    ): PendingLink {
        val rv = IssuerPolicy.normalizeOrNull(rendezvous)?.takeIf { issuerPolicy.isSecureUrl(it) }
            ?: throw IllegalArgumentException("rendezvous must be an https URL (http only for local development hosts): $rendezvous")
        val secret = LinkCrypto.createSecret()
        val challenge = LinkCrypto.linkChallenge(LinkCrypto.linkVerifier(secret))
        val authorization = deviceAuthorization(
            rendezvous = rv,
            clientId = clientId,
            linkChallenge = challenge,
            scopes = (listOf(Scopes.CHAT) + scopes).distinct(),
            slots = (listOf(Slots.DEFAULT) + slots).distinct(),
            clientName = clientName,
        )
        return PendingLink(this, rv, clientId, authorization, secret, issuerPolicy, walletLinkUrl)
    }

    // ---- grant management (§8.6, §9) -------------------------------------------------------

    /** `GET {api_base}/modelpass/grant`. */
    public suspend fun grantInfo(session: ModelPassSession): GrantInfo {
        val response = transport.execute(
            url = UrlCodec.join(session.apiBase, ModelPassProtocol.GRANT_INFO_PATH),
            method = "GET",
            headers = authHeaders(session),
            readTimeoutMillis = readTimeoutMillis,
        )
        if (!response.isSuccessful) throw apiError(response)
        return decodeJson(GrantInfo.serializer(), response.text, "grant info")
    }

    /** `GET {api_base}/models` (§8.2): the slots (and allowed models) usable with this grant. */
    public suspend fun models(session: ModelPassSession): List<ModelInfo> {
        val response = transport.execute(
            url = UrlCodec.join(session.apiBase, "/models"),
            method = "GET",
            headers = authHeaders(session),
            readTimeoutMillis = readTimeoutMillis,
        )
        if (!response.isSuccessful) throw apiError(response)
        return decodeJson(ModelList.serializer(), response.text, "model list").data
    }

    /** `POST {revocation_endpoint}` with `token=…` (RFC 7009; falls back to `{issuer}/oauth/revoke`). */
    public suspend fun revoke(issuer: String, accessToken: String) {
        val url = endpoint(issuer, { it.revocationEndpoint }, ModelPassProtocol.REVOCATION_PATH)
        val response = postForm(url, listOf("token" to accessToken))
        if (!response.isSuccessful) throw apiError(response)
    }

    public suspend fun revoke(session: ModelPassSession): Unit = revoke(session.issuer, session.accessToken)

    // ---- chat (§8.3) --------------------------------------------------------------------------

    /** `POST {api_base}/chat/completions` (non-streaming). */
    public suspend fun chat(session: ModelPassSession, request: ChatRequest): ChatCompletion {
        val response = transport.execute(
            url = UrlCodec.join(session.apiBase, "/chat/completions"),
            method = "POST",
            headers = authHeaders(session) + ("Accept" to JSON),
            body = request.toJson(stream = false).toString().encodeToByteArray(),
            contentType = JSON,
            readTimeoutMillis = chatReadTimeoutMillis,
        )
        if (!response.isSuccessful) throw apiError(response)
        val completion = decodeJson(ChatCompletion.serializer(), response.text, "chat completion")
        return completion.copy(routing = RoutingInfo.fromHeaders(response::header))
    }

    /**
     * Streaming `POST {api_base}/chat/completions` (`stream: true`). Emits [ChatStreamEvent.Routing]
     * first, then deltas until `[DONE]`. Cancelling the collector releases it immediately and
     * disconnects the connection.
     */
    public fun streamChat(session: ModelPassSession, request: ChatRequest): Flow<ChatStreamEvent> = callbackFlow {
        val body = request.toJson(stream = true).toString().encodeToByteArray()
        val conn = transport.open(
            url = UrlCodec.join(session.apiBase, "/chat/completions"),
            method = "POST",
            headers = authHeaders(session) + ("Accept" to "text/event-stream"),
            readTimeoutMillis = chatReadTimeoutMillis,
        )
        // The blocking reader is deliberately not a child of this producer (see HttpTransport):
        // the collector must never wait for a read that cannot be interrupted.
        val reader = transport.background.launch {
            try {
                transport.writeBody(conn, body, JSON)
                val status = conn.responseCode
                if (status !in 200..299) {
                    val text = conn.errorStream?.use { HttpTransport.readLimited(it) }?.decodeToString().orEmpty()
                    throw apiError(status, text)
                }
                send(ChatStreamEvent.Routing(RoutingInfo.fromHeaders { conn.getHeaderField(it) }))
                conn.inputStream.bufferedReader(Charsets.UTF_8).use { input ->
                    val sse = SseParser()
                    while (true) {
                        val line = input.readLine()
                        val data = if (line == null) sse.flush() else sse.feed(line)
                        if (data != null) {
                            if (data.trim() == ChatStreamDecoder.DONE) break
                            for (event in ChatStreamDecoder.decode(data, status)) send(event)
                        }
                        if (line == null) break
                    }
                }
                channel.close()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                // After the collector went away, the disconnect makes reads fail: not an error.
                if (isActive) channel.close(if (e is IOException) ModelPassException.Network(e) else e)
            }
        }
        awaitClose {
            reader.cancel()
            transport.disconnectInBackground(conn)
        }
    }

    // ---- helpers ------------------------------------------------------------------------------

    private suspend fun postForm(url: String, params: List<Pair<String, String?>>): HttpResponse =
        transport.execute(
            url = url,
            method = "POST",
            headers = mapOf("Accept" to JSON),
            body = UrlCodec.encodeQuery(params).encodeToByteArray(),
            contentType = FORM,
            readTimeoutMillis = readTimeoutMillis,
        )

    private fun authHeaders(session: ModelPassSession): Map<String, String> = mapOf(
        "Authorization" to session.authorizationHeader,
        "Accept" to JSON,
    )

    private fun baseUrl(url: String): String = url.trim().trimEnd('/')

    public companion object {
        public const val DEFAULT_USER_AGENT: String = "modelpass-kotlin/${ModelPassProtocol.SDK_VERSION}"
        private const val JSON = "application/json"
        private const val FORM = "application/x-www-form-urlencoded"
        private const val MAX_POLL_NETWORK_FAILURES = 5
    }
}
