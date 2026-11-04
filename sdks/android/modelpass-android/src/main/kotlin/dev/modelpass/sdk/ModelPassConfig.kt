package dev.modelpass.sdk

import dev.modelpass.core.ModelPassProtocol
import dev.modelpass.core.Scopes
import dev.modelpass.core.Slots

/**
 * Static configuration of a [ModelPass] client.
 *
 * @property clientId App identifier, normally the package name (e.g. `com.example.chat`).
 * @property redirectUri Where the wallet sends the result, e.g. `com.example.chat:/modelpass/callback`
 *   (its scheme must match the `modelpassRedirectScheme` manifest placeholder) or a verified
 *   `https://` App Link handled by [ModelPassRedirectActivity].
 * @property clientName Name shown on the wallet's consent screen.
 * @property scopes Requested scopes (`chat` is always included).
 * @property slots Model slots the app will use (`default` is always included).
 * @property walletAuthorizeUrl Wallet entry point; may contain a query string.
 * @property trustedIssuers If non-empty, only these hubs are accepted (see `IssuerPolicy`).
 * @property linkRendezvous Hub used to start the cross-device (QR) link flow.
 * @property budgetHint Suggested daily token budget shown to the user.
 * @property allowLocalHttpIssuers Accept `http://` hubs on localhost / LAN addresses (development).
 *   Consider `BuildConfig.DEBUG` for release builds.
 */
public data class ModelPassConfig @JvmOverloads constructor(
    val clientId: String,
    val redirectUri: String,
    val clientName: String? = null,
    val scopes: List<String> = listOf(Scopes.CHAT),
    val slots: List<String> = listOf(Slots.DEFAULT),
    val walletAuthorizeUrl: String = ModelPassProtocol.DEFAULT_WALLET_AUTHORIZE_URL,
    val trustedIssuers: Set<String>? = null,
    val linkRendezvous: String? = null,
    val budgetHint: Long? = null,
    val allowLocalHttpIssuers: Boolean = true,
) {
    init {
        require(clientId.isNotBlank()) { "clientId must not be blank" }
        require(redirectUri.indexOf(':') > 0) { "redirectUri must be an absolute URI such as com.example.app:/modelpass/callback" }
    }
}
