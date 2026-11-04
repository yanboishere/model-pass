package dev.modelpass.core

/** Constants of ModelPass Connect protocol v0.1 (see docs/protocol.md). */
public object ModelPassProtocol {
    public const val VERSION: String = "0.1"
    public const val SDK_VERSION: String = "0.1.0"

    /** Same-device wallet entry point (§6.1). */
    public const val DEFAULT_WALLET_AUTHORIZE_URL: String = "modelpass://authorize"

    /** Wallet deep link used to hand a link-flow QR payload to the wallet (§7.2). */
    public const val DEFAULT_WALLET_LINK_URL: String = "modelpass://link"

    /** Wallet deep link that opens the management page of a grant (§9): `modelpass://grants/{grant_id}`. */
    public const val WALLET_GRANTS_URL: String = "modelpass://grants/"

    public const val DISCOVERY_PATH: String = "/.well-known/modelpass-configuration"
    public const val TOKEN_PATH: String = "/oauth/token"
    public const val DEVICE_AUTHORIZATION_PATH: String = "/oauth/device_authorization"
    public const val REVOCATION_PATH: String = "/oauth/revoke"

    /** Relative to `api_base` (§8.6). */
    public const val GRANT_INFO_PATH: String = "/modelpass/grant"

    public const val AUTHORIZATION_CODE_GRANT_TYPE: String = "authorization_code"
    public const val DEVICE_CODE_GRANT_TYPE: String = "urn:ietf:params:oauth:grant-type:device_code"
    public const val CODE_CHALLENGE_METHOD: String = "S256"
}

/** Capability scopes (§4.1). `chat` is always requested. */
public object Scopes {
    public const val CHAT: String = "chat"
    public const val VISION: String = "vision"
    public const val TOOLS: String = "tools"
    public const val MODEL_CHOICE: String = "model_choice"
}

/** Model slots (§4.2). Pass a slot id as the `model` of a chat request. */
public object Slots {
    public const val DEFAULT: String = "default"
    public const val FAST: String = "fast"
    public const val REASONING: String = "reasoning"
    public const val VISION: String = "vision"
}

/** `error.code` values returned by the model API (§8.7). */
public object ApiErrorCodes {
    public const val INVALID_TOKEN: String = "invalid_token"
    public const val GRANT_REVOKED: String = "grant_revoked"
    public const val GRANT_EXPIRED: String = "grant_expired"
    public const val GRANT_PAUSED: String = "grant_paused"
    public const val INSUFFICIENT_SCOPE: String = "insufficient_scope"
    public const val BUDGET_EXCEEDED: String = "budget_exceeded"
    public const val NO_ROUTE: String = "no_route"
    public const val UPSTREAM_AUTH_FAILED: String = "upstream_auth_failed"
    public const val UPSTREAM_ERROR: String = "upstream_error"
    public const val UNSUPPORTED_FORMAT: String = "unsupported_format"
    public const val INVALID_REQUEST: String = "invalid_request"
}
