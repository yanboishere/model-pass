package dev.modelpass.core

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** JSON settings: unknown fields are ignored (protocol §15), nulls fall back to defaults. */
internal val ModelPassJson: Json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    coerceInputValues = true
    encodeDefaults = true
}

/** A slot granted to the app (§6.4). [model]/[provider] are only present if the user shares them. */
@Serializable
public data class TokenSlot(
    val id: String,
    val label: String = "",
    val model: String? = null,
    val provider: String? = null,
)

/** Token response (§6.4). In the link flow it arrives sealed (§7.3). */
@Serializable
public data class TokenResponse(
    @SerialName("access_token") val accessToken: String,
    @SerialName("token_type") val tokenType: String = "Bearer",
    @SerialName("expires_in") val expiresIn: Long? = null,
    val scope: String = "",
    @SerialName("grant_id") val grantId: String = "",
    val sub: String = "",
    val issuer: String? = null,
    @SerialName("api_base") val apiBase: String? = null,
    @SerialName("api_formats") val apiFormats: List<String> = emptyList(),
    val slots: List<TokenSlot> = emptyList(),
) {
    override fun toString(): String =
        "TokenResponse(grantId=$grantId, issuer=$issuer, apiBase=$apiBase, scope=$scope, slots=${slots.map { it.id }}, " +
            "expiresIn=$expiresIn, accessToken=<redacted>)"

    public companion object {
        /** @throws ModelPassException.InvalidResponse */
        @JvmStatic
        public fun parse(json: String): TokenResponse = decodeJson(serializer(), json, "token response", sensitive = true)
    }
}

/** `GET {issuer}/.well-known/modelpass-configuration` (§5). */
@Serializable
public data class DiscoveryDocument(
    val issuer: String,
    @SerialName("protocol_version") val protocolVersion: String? = null,
    @SerialName("wallet_authorization_endpoint") val walletAuthorizationEndpoint: String? = null,
    @SerialName("token_endpoint") val tokenEndpoint: String? = null,
    @SerialName("device_authorization_endpoint") val deviceAuthorizationEndpoint: String? = null,
    @SerialName("link_endpoint") val linkEndpoint: String? = null,
    @SerialName("revocation_endpoint") val revocationEndpoint: String? = null,
    @SerialName("grant_info_endpoint") val grantInfoEndpoint: String? = null,
    @SerialName("api_base") val apiBase: String? = null,
    @SerialName("api_formats_supported") val apiFormatsSupported: List<String> = emptyList(),
    @SerialName("scopes_supported") val scopesSupported: List<String> = emptyList(),
    @SerialName("slots_supported") val slotsSupported: List<String> = emptyList(),
    @SerialName("grant_types_supported") val grantTypesSupported: List<String> = emptyList(),
    @SerialName("code_challenge_methods_supported") val codeChallengeMethodsSupported: List<String> = emptyList(),
)

/** Response of `POST {rendezvous}/oauth/device_authorization` (§7.1). */
@Serializable
public data class DeviceAuthorizationResponse(
    @SerialName("device_code") val deviceCode: String,
    @SerialName("user_code") val userCode: String,
    @SerialName("verification_uri") val verificationUri: String,
    @SerialName("expires_in") val expiresIn: Long = 600,
    /** Seconds between polls; RFC 8628 default is 5. */
    val interval: Long = 5,
) {
    override fun toString(): String =
        "DeviceAuthorizationResponse(userCode=$userCode, verificationUri=$verificationUri, expiresIn=$expiresIn, interval=$interval, deviceCode=<redacted>)"
}

/** `GET {api_base}/modelpass/grant` (§8.6). Timestamps are Unix epoch seconds. */
@Serializable
public data class GrantInfo(
    @SerialName("grant_id") val grantId: String,
    @SerialName("client_id") val clientId: String = "",
    val scope: String = "",
    /** `active`, `paused`, `revoked` or `pending`. */
    val status: String = "active",
    val slots: List<TokenSlot> = emptyList(),
    val budget: GrantBudget? = null,
    @SerialName("created_at") val createdAt: Long? = null,
    @SerialName("expires_at") val expiresAt: Long? = null,
) {
    val scopes: List<String> get() = splitScope(scope)
    val isActive: Boolean get() = status == "active"
}

@Serializable
public data class GrantBudget(
    @SerialName("tokens_per_day") val tokensPerDay: Long? = null,
    @SerialName("requests_per_day") val requestsPerDay: Long? = null,
    @SerialName("tokens_used_today") val tokensUsedToday: Long = 0,
    @SerialName("requests_today") val requestsToday: Long = 0,
)

/** An entry of `GET {api_base}/models` (§8.2). */
@Serializable
public data class ModelInfo(
    val id: String,
    @SerialName("object") val objectType: String = "model",
    @SerialName("owned_by") val ownedBy: String? = null,
)

@Serializable
internal data class ModelList(val data: List<ModelInfo> = emptyList())

/**
 * An authorized connection to the user's hub. Use [apiBase] + [accessToken] with any
 * OpenAI-compatible client. Timestamps are Unix epoch **seconds**.
 *
 * Treat [accessToken] as a secret: store it only in encrypted storage and never log it
 * ([toString] redacts it).
 */
@Serializable
public data class ModelPassSession(
    @SerialName("access_token") val accessToken: String,
    @SerialName("token_type") val tokenType: String = "Bearer",
    val issuer: String,
    @SerialName("api_base") val apiBase: String,
    @SerialName("grant_id") val grantId: String = "",
    /** Space-separated granted scopes, e.g. `chat tools`. */
    val scope: String = "",
    /** Anonymous per-app user id (stable for the user + client_id). */
    val sub: String = "",
    val slots: List<TokenSlot> = emptyList(),
    @SerialName("expires_at") val expiresAt: Long? = null,
    @SerialName("api_formats") val apiFormats: List<String> = emptyList(),
    @SerialName("created_at") val createdAt: Long = 0,
) {
    val scopes: List<String> get() = splitScope(scope)

    public fun hasScope(scope: String): Boolean = scope in scopes

    public fun isExpired(nowMillis: Long = System.currentTimeMillis()): Boolean =
        expiresAt != null && nowMillis / 1000 >= expiresAt

    /** Value for the `Authorization` header. */
    val authorizationHeader: String get() = "Bearer $accessToken"

    /** Wallet deep link to this grant's management page (§9): `modelpass://grants/{grant_id}`. */
    val manageUrl: String get() = ModelPassProtocol.WALLET_GRANTS_URL + UrlCodec.encodeComponent(grantId)

    public fun toJson(): String = ModelPassJson.encodeToString(serializer(), this)

    override fun toString(): String =
        "ModelPassSession(issuer=$issuer, apiBase=$apiBase, grantId=$grantId, scope=$scope, sub=$sub, " +
            "slots=${slots.map { it.id }}, expiresAt=$expiresAt, accessToken=<redacted>)"

    public companion object {
        /** @throws ModelPassException.InvalidResponse */
        @JvmStatic
        public fun fromJson(json: String): ModelPassSession = decodeJson(serializer(), json, "session", sensitive = true)

        /**
         * Builds a session from a token response whose [issuer] has already been validated.
         * @throws ModelPassException.InvalidResponse if required fields are missing or unsafe.
         */
        @JvmStatic
        @JvmOverloads
        public fun fromTokenResponse(
            token: TokenResponse,
            issuer: String,
            apiBase: String,
            policy: IssuerPolicy = IssuerPolicy.Default,
            nowMillis: Long = System.currentTimeMillis(),
        ): ModelPassSession {
            if (token.accessToken.isBlank()) throw ModelPassException.InvalidResponse("Token response has no access_token")
            if (!token.tokenType.equals("Bearer", ignoreCase = true)) {
                throw ModelPassException.InvalidResponse("Unsupported token_type '${token.tokenType}'")
            }
            if (!policy.isSecureUrl(apiBase)) {
                throw ModelPassException.InvalidResponse("api_base must be an https URL (got '$apiBase')")
            }
            return ModelPassSession(
                accessToken = token.accessToken,
                tokenType = "Bearer",
                issuer = issuer,
                apiBase = apiBase.trim().trimEnd('/'),
                grantId = token.grantId,
                scope = token.scope,
                sub = token.sub,
                slots = token.slots,
                expiresAt = token.expiresIn?.takeIf { it > 0 }?.let { nowMillis / 1000 + it },
                apiFormats = token.apiFormats,
                createdAt = nowMillis / 1000,
            )
        }
    }
}

internal fun splitScope(scope: String): List<String> = scope.split(' ', '\t', '\n').filter { it.isNotEmpty() }

/**
 * Decodes JSON, mapping failures to [ModelPassException.InvalidResponse]. For [sensitive] payloads
 * (tokens, verifiers) the parser's message and cause are dropped: kotlinx-serialization quotes the
 * offending input, which must never reach logs or crash reports.
 */
internal fun <T> decodeJson(
    deserializer: kotlinx.serialization.DeserializationStrategy<T>,
    json: String,
    what: String,
    sensitive: Boolean = false,
): T =
    try {
        ModelPassJson.decodeFromString(deserializer, json)
    } catch (e: IllegalArgumentException) { // includes SerializationException
        if (sensitive) throw ModelPassException.InvalidResponse("Invalid $what")
        throw ModelPassException.InvalidResponse("Invalid $what: ${e.message}", e)
    }
