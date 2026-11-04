import Foundation

/// Static configuration of a ModelPass client app.
public struct ModelPassConfiguration: Sendable {
    /// The default wallet entry point, `modelpass://authorize` (§6.1).
    public static let defaultWalletAuthorizeURL = URL(string: ModelPassProtocol.defaultWalletAuthorizeURL)!

    /// Your app's identifier, typically the bundle ID (e.g. `com.example.chat`).
    public var clientId: String
    /// Where the wallet sends the user back, e.g. `com.example.chat:/modelpass/callback` (private-use scheme,
    /// RFC 8252 §7.1) or an https universal link. Register its scheme under `CFBundleURLTypes`.
    public var redirectURI: URL
    /// Name shown on the wallet's consent screen. Unregistered apps are labelled "unverified" by the wallet.
    public var clientName: String?
    /// Requested scopes (§4.1): `chat` (always added), `vision`, `tools`, `model_choice`.
    public var scopes: [String]
    /// Requested model slots (§4.2): `default` (always added), `fast`, `reasoning`, `vision`.
    public var slots: [String]
    /// The wallet entry point. Defaults to `modelpass://authorize`.
    public var walletAuthorizeURL: URL
    /// Optional allow-list of hub issuers (e.g. `["https://hub.example.com"]`). When set, authorizations from any
    /// other hub are rejected with `ModelPassError.untrustedIssuer` (mitigates `iss` mix-up attacks, §13.2).
    public var trustedIssuers: [String]?

    public init(
        clientId: String,
        redirectURI: URL,
        clientName: String? = nil,
        scopes: [String] = ["chat"],
        slots: [String] = ["default"],
        walletAuthorizeURL: URL = ModelPassConfiguration.defaultWalletAuthorizeURL,
        trustedIssuers: [String]? = nil
    ) {
        self.clientId = clientId
        self.redirectURI = redirectURI
        self.clientName = clientName
        self.scopes = scopes
        self.slots = slots
        self.walletAuthorizeURL = walletAuthorizeURL
        self.trustedIssuers = trustedIssuers
    }
}
