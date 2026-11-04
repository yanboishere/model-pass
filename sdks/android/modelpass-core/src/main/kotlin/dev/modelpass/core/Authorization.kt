package dev.modelpass.core

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** Parameters of the wallet authorization request (§6.1). */
public data class AuthorizationRequest(
    val clientId: String,
    val redirectUri: String,
    val state: String,
    val codeChallenge: String,
    val scopes: List<String> = listOf(Scopes.CHAT),
    val slots: List<String> = listOf(Slots.DEFAULT),
    val clientName: String? = null,
    /** Suggested daily token budget; the user can change it. */
    val budgetHint: Long? = null,
) {
    /**
     * `modelpass://authorize?response_type=code&client_id=…&redirect_uri=…&scope=chat%20tools&state=…
     * &code_challenge=…&code_challenge_method=S256&slots=…&client_name=…&budget_hint=…`
     *
     * [walletAuthorizeUrl] may already contain a query string (e.g. a universal link or a dev URL).
     */
    public fun toUrl(walletAuthorizeUrl: String = ModelPassProtocol.DEFAULT_WALLET_AUTHORIZE_URL): String {
        val query = UrlCodec.encodeQuery(
            listOf(
                "response_type" to "code",
                "client_id" to clientId,
                "redirect_uri" to redirectUri,
                "scope" to scopes.joinToString(" "),
                "state" to state,
                "code_challenge" to codeChallenge,
                "code_challenge_method" to ModelPassProtocol.CODE_CHALLENGE_METHOD,
                "slots" to slots.joinToString(" "),
                "client_name" to clientName,
                "budget_hint" to budgetHint?.toString(),
            ),
        )
        return UrlCodec.appendQuery(walletAuthorizeUrl, query)
    }
}

/**
 * What the app must remember between opening the wallet and receiving the redirect. Persist it
 * (e.g. app-private storage) so the flow survives process death; it is single use.
 */
@Serializable
public data class PendingAuthorization(
    val state: String,
    @SerialName("code_verifier") val codeVerifier: String,
    @SerialName("client_id") val clientId: String,
    @SerialName("redirect_uri") val redirectUri: String,
    /** Unix epoch milliseconds. */
    @SerialName("created_at_ms") val createdAtMillis: Long,
) {
    public fun isExpired(nowMillis: Long = System.currentTimeMillis(), maxAgeMillis: Long = DEFAULT_MAX_AGE_MILLIS): Boolean =
        nowMillis - createdAtMillis > maxAgeMillis || nowMillis < createdAtMillis - 60_000

    public fun toJson(): String = ModelPassJson.encodeToString(serializer(), this)

    override fun toString(): String = "PendingAuthorization(clientId=$clientId, redirectUri=$redirectUri, createdAtMillis=$createdAtMillis)"

    public companion object {
        /** How long the user may take in the wallet before a redirect is no longer accepted. */
        public const val DEFAULT_MAX_AGE_MILLIS: Long = 15 * 60 * 1000L

        /** @throws ModelPassException.InvalidResponse */
        @JvmStatic
        public fun fromJson(json: String): PendingAuthorization = decodeJson(serializer(), json, "pending authorization", sensitive = true)
    }
}

/** A ready-to-open wallet URL plus the [pending] state to keep. */
public class PreparedAuthorization(public val url: String, public val pending: PendingAuthorization) {
    override fun toString(): String = "PreparedAuthorization(pending=$pending)"
}

/** Same-device flow helpers (§6). */
public object ModelPassAuthorization {
    /**
     * Generates `state` + PKCE verifier and builds the wallet URL. `chat` is always added to [scopes]
     * and `default` to [slots], as the protocol requires.
     */
    @JvmStatic
    @JvmOverloads
    public fun prepare(
        clientId: String,
        redirectUri: String,
        scopes: List<String> = listOf(Scopes.CHAT),
        slots: List<String> = listOf(Slots.DEFAULT),
        clientName: String? = null,
        budgetHint: Long? = null,
        walletAuthorizeUrl: String = ModelPassProtocol.DEFAULT_WALLET_AUTHORIZE_URL,
        nowMillis: Long = System.currentTimeMillis(),
    ): PreparedAuthorization {
        require(clientId.isNotBlank()) { "clientId must not be blank" }
        require(redirectUri.contains(':')) { "redirectUri must be an absolute URI" }
        val verifier = Pkce.createVerifier()
        val request = AuthorizationRequest(
            clientId = clientId,
            redirectUri = redirectUri,
            state = Pkce.createState(),
            codeChallenge = Pkce.challengeS256(verifier),
            scopes = withFirst(Scopes.CHAT, scopes),
            slots = withFirst(Slots.DEFAULT, slots),
            clientName = clientName?.takeIf { it.isNotBlank() },
            budgetHint = budgetHint?.takeIf { it > 0 },
        )
        val pending = PendingAuthorization(request.state, verifier, clientId, redirectUri, nowMillis)
        return PreparedAuthorization(request.toUrl(walletAuthorizeUrl), pending)
    }

    /** True if [url] targets [redirectUri] (scheme compared case-insensitively; query/fragment ignored). */
    @JvmStatic
    public fun isRedirectFor(url: String, redirectUri: String): Boolean = redirectTarget(url) == redirectTarget(redirectUri)

    private fun redirectTarget(uri: String): Pair<String, String> {
        val base = uri.trim().substringBefore('#').substringBefore('?')
        val colon = base.indexOf(':')
        return if (colon < 0) "" to base.trimEnd('/') else base.substring(0, colon).lowercase() to base.substring(colon + 1).trimEnd('/')
    }

    private fun withFirst(required: String, values: List<String>): List<String> =
        (listOf(required) + values.map { it.trim() }.filter { it.isNotEmpty() }).distinct()
}

/** A validated successful authorization response: exchange [code] at [issuer]'s token endpoint. */
public data class AuthorizationCode(val code: String, val issuer: String, val state: String) {
    override fun toString(): String = "AuthorizationCode(issuer=$issuer, code=<redacted>)"
}

/** Parses the wallet's redirect (§6.2). */
public object AuthorizationResponse {
    /**
     * Validates `state`, maps `error` / `error_description`, and validates `iss` against [issuerPolicy].
     *
     * @throws ModelPassException.InvalidState if `state` is missing or does not match [expectedState].
     * @throws ModelPassException.AccessDenied if the user declined.
     * @throws ModelPassException.AuthorizationFailed for other OAuth errors.
     * @throws ModelPassException.UntrustedIssuer if `iss` is not acceptable.
     * @throws ModelPassException.InvalidResponse if `code` or `iss` is missing or a parameter is repeated.
     */
    @JvmStatic
    @JvmOverloads
    public fun parse(redirectUrl: String, expectedState: String, issuerPolicy: IssuerPolicy = IssuerPolicy.Default): AuthorizationCode {
        require(expectedState.isNotEmpty()) { "expectedState must not be empty" }
        val params = try {
            UrlCodec.queryParameterValues(redirectUrl)
        } catch (e: IllegalArgumentException) {
            throw ModelPassException.InvalidResponse("Malformed redirect URL", e)
        }

        fun single(name: String): String? {
            val values = params[name] ?: return null
            if (values.size > 1) throw ModelPassException.InvalidResponse("Redirect contains '$name' more than once")
            return values[0]
        }

        val state = single("state")
        if (state == null || !ModelPassCrypto.constantTimeEquals(state, expectedState)) throw ModelPassException.InvalidState()

        val error = single("error")
        if (error != null) {
            val description = single("error_description")?.takeIf { it.isNotEmpty() }
            if (error == "access_denied") throw ModelPassException.AccessDenied(description)
            throw ModelPassException.AuthorizationFailed(error, description)
        }

        val code = single("code")?.takeIf { it.isNotEmpty() }
            ?: throw ModelPassException.InvalidResponse("Redirect is missing 'code'")
        val iss = single("iss")?.takeIf { it.isNotEmpty() }
            ?: throw ModelPassException.InvalidResponse("Redirect is missing 'iss' (RFC 9207)")
        return AuthorizationCode(code = code, issuer = issuerPolicy.validate(iss), state = state)
    }
}
