package dev.modelpass.core

import java.io.IOException

/** Every error surfaced by the SDK. Catch this type (or a specific subclass) around SDK calls. */
public sealed class ModelPassException(message: String, cause: Throwable? = null) : Exception(message, cause) {

    /** No app on this device handles the wallet URL (`modelpass://authorize`). Offer the link flow instead. */
    public class WalletNotInstalled : ModelPassException("No ModelPass wallet app is installed to handle the authorization request")

    /** The user declined the request in the wallet (`error=access_denied`). */
    public class AccessDenied(public val description: String? = null) :
        ModelPassException(description ?: "The user denied the ModelPass authorization request")

    /** The wallet returned another OAuth error (`invalid_request`, `invalid_scope`, `server_error`, …). */
    public class AuthorizationFailed(public val error: String, public val description: String? = null) :
        ModelPassException("ModelPass authorization failed: $error" + (description?.let { " ($it)" } ?: ""))

    /** The redirect's `state` does not match the pending request (possible CSRF / stale response). */
    public class InvalidState : ModelPassException("The authorization response state does not match the pending request")

    /** `iss` is not an acceptable issuer (not https, malformed, or not in the trusted-issuer list). */
    public class UntrustedIssuer(public val issuer: String, public val reason: String) :
        ModelPassException("Untrusted ModelPass issuer '$issuer': $reason")

    /** The token endpoint rejected the request (RFC 6749 §5.2 error, e.g. `invalid_grant`). */
    public class TokenExchangeFailed(
        public val error: String,
        public val description: String?,
        public val status: Int,
    ) : ModelPassException("Token request failed ($status $error)" + (description?.let { ": $it" } ?: ""))

    /**
     * The model API returned an error (`{"error":{"message","type","code"}}`, §8.7).
     * [code] is e.g. [ApiErrorCodes.INVALID_TOKEN] or [ApiErrorCodes.BUDGET_EXCEEDED].
     */
    public class Api(
        public val status: Int,
        public val code: String?,
        message: String,
        public val type: String? = null,
    ) : ModelPassException(message) {
        /** The grant is gone (invalid / revoked / expired token): clear the session and authorize again. */
        public val requiresReauthorization: Boolean
            get() = status == 401 || code == ApiErrorCodes.INVALID_TOKEN ||
                code == ApiErrorCodes.GRANT_REVOKED || code == ApiErrorCodes.GRANT_EXPIRED
    }

    /** The link (QR) code expired before the user approved it (`expired_token`). */
    public class LinkExpired : ModelPassException("The ModelPass link code expired before it was approved")

    /** The user declined the link request in the wallet (`access_denied`). */
    public class LinkDenied : ModelPassException("The user declined the ModelPass link request")

    /** A response could not be parsed, failed validation, or failed to decrypt. */
    public class InvalidResponse(message: String, cause: Throwable? = null) : ModelPassException(message, cause)

    /** The flow was cancelled (user returned without approving, or `cancel()` was called). */
    public class Cancelled(message: String = "The ModelPass flow was cancelled") : ModelPassException(message)

    /** I/O failure talking to the hub (offline, DNS, TLS, timeout…). */
    public class Network(cause: IOException) : ModelPassException("Network error: ${cause.message ?: cause.javaClass.simpleName}", cause)

    /** No session is available (never authorized, signed out, or expired). */
    public class NotAuthorized(message: String = "Not connected to ModelPass; call authorize() first") : ModelPassException(message)
}
