import Foundation

/// A model slot granted to the app (§4.2): `default`, `fast`, `reasoning` or `vision`.
public struct ModelPassSlot: Codable, Hashable, Sendable, Identifiable {
    /// Slot ID — pass it as `model` in chat requests.
    public var id: String
    /// Display label chosen by the hub, e.g. "默认".
    public var label: String
    /// Concrete model name; only present when the user allows sharing model info with the app.
    public var model: String?
    /// Provider name; only present when the user allows sharing model info with the app.
    public var provider: String?

    public init(id: String, label: String? = nil, model: String? = nil, provider: String? = nil) {
        self.id = id
        self.label = label ?? id
        self.model = model
        self.provider = provider
    }

    private enum CodingKeys: String, CodingKey { case id, label, model, provider }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        label = try container.decodeIfPresent(String.self, forKey: .label) ?? id
        model = try container.decodeIfPresent(String.self, forKey: .model)
        provider = try container.decodeIfPresent(String.self, forKey: .provider)
    }
}

/// The result of a successful authorization: an OpenAI-compatible `apiBase` plus a bearer `accessToken`.
///
/// Use it with any OpenAI-compatible client (`baseURL = apiBase`, `apiKey = accessToken`) or with the built-in
/// `ModelPass.chat` / `ModelPass.streamChat` helpers. The SDK keeps it in the Keychain; never log the token.
public struct ModelPassSession: Codable, Hashable, Sendable {
    public typealias Slot = ModelPassSlot

    /// Opaque bearer token (`mpk_…`).
    public var accessToken: String
    /// Always `Bearer` in protocol v0.1.
    public var tokenType: String
    /// The hub that issued the token (validated `iss`).
    public var issuer: URL
    /// OpenAI-compatible base URL, e.g. `https://hub.example.com/v1`.
    public var apiBase: URL
    /// Grant identifier; used for `modelpass://grants/{grant_id}`.
    public var grantId: String
    /// Granted scopes, space separated (e.g. `chat tools`).
    public var scope: String
    /// Pairwise anonymous user identifier (stable per user and app).
    public var sub: String
    /// Slots the app may use as `model`.
    public var slots: [Slot]
    /// API formats supported by the hub, e.g. `openai-chat-completions`, `anthropic-messages`.
    public var apiFormats: [String]
    /// Only set when the user gave the grant an expiry. There are no refresh tokens in v0.1.
    public var expiresAt: Date?

    public init(
        accessToken: String,
        tokenType: String = "Bearer",
        issuer: URL,
        apiBase: URL,
        grantId: String,
        scope: String = "chat",
        sub: String = "",
        slots: [Slot] = [Slot(id: "default")],
        apiFormats: [String] = ["openai-chat-completions"],
        expiresAt: Date? = nil
    ) {
        self.accessToken = accessToken
        self.tokenType = tokenType
        self.issuer = issuer
        self.apiBase = apiBase
        self.grantId = grantId
        self.scope = scope
        self.sub = sub
        self.slots = slots
        self.apiFormats = apiFormats
        self.expiresAt = expiresAt
    }

    private enum CodingKeys: String, CodingKey {
        case accessToken, tokenType, issuer, apiBase, grantId, scope, sub, slots, apiFormats, expiresAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        accessToken = try container.decode(String.self, forKey: .accessToken)
        tokenType = try container.decodeIfPresent(String.self, forKey: .tokenType) ?? "Bearer"
        issuer = try container.decode(URL.self, forKey: .issuer)
        apiBase = try container.decode(URL.self, forKey: .apiBase)
        grantId = try container.decode(String.self, forKey: .grantId)
        scope = try container.decodeIfPresent(String.self, forKey: .scope) ?? "chat"
        sub = try container.decodeIfPresent(String.self, forKey: .sub) ?? ""
        slots = try container.decodeIfPresent([Slot].self, forKey: .slots) ?? [Slot(id: "default")]
        apiFormats = try container.decodeIfPresent([String].self, forKey: .apiFormats) ?? ["openai-chat-completions"]
        expiresAt = try container.decodeIfPresent(Date.self, forKey: .expiresAt)
    }

    /// Granted scopes as an array.
    public var scopes: [String] {
        scope.split(whereSeparator: { $0 == " " || $0 == "," || $0 == "+" }).map(String.init)
    }

    public func hasScope(_ scope: String) -> Bool { scopes.contains(scope) }

    /// True once `expiresAt` has passed. The hub is authoritative; this is a local hint only.
    public var isExpired: Bool {
        guard let expiresAt else { return false }
        return expiresAt <= Date()
    }

    /// `modelpass://grants/{grant_id}` — opens this grant's management page in the wallet (§9).
    public var manageURL: URL? {
        URL(string: ModelPassProtocol.walletGrantsURL + QueryString.encodeComponent(grantId))
    }

    /// Value for the `Authorization` header when calling the API yourself.
    public var authorizationHeaderValue: String { "Bearer \(accessToken)" }
}

extension ModelPassSession: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
    // The token must never end up in logs (§13.5), so printing / dumping a session redacts it.
    public var description: String {
        "ModelPassSession(issuer: \(issuer.absoluteString), apiBase: \(apiBase.absoluteString), grantId: \(grantId), "
            + "scope: \(scope), slots: \(slots.map(\.id)), accessToken: <redacted>)"
    }

    public var debugDescription: String { description }

    public var customMirror: Mirror {
        Mirror(self, children: [
            "accessToken": "<redacted>",
            "tokenType": tokenType,
            "issuer": issuer,
            "apiBase": apiBase,
            "grantId": grantId,
            "scope": scope,
            "sub": sub,
            "slots": slots,
            "apiFormats": apiFormats,
            "expiresAt": expiresAt as Any,
        ], displayStyle: .struct)
    }
}

/// `GET {api_base}/modelpass/grant` (§8.6): the current grant's status, slots and budget.
public struct ModelPassGrantInfo: Codable, Hashable, Sendable {
    public struct Budget: Codable, Hashable, Sendable {
        public var tokensPerDay: Int?
        public var requestsPerDay: Int?
        public var tokensUsedToday: Int
        public var requestsToday: Int

        public init(tokensPerDay: Int? = nil, requestsPerDay: Int? = nil, tokensUsedToday: Int = 0, requestsToday: Int = 0) {
            self.tokensPerDay = tokensPerDay
            self.requestsPerDay = requestsPerDay
            self.tokensUsedToday = tokensUsedToday
            self.requestsToday = requestsToday
        }

        private enum CodingKeys: String, CodingKey {
            case tokensPerDay = "tokens_per_day"
            case requestsPerDay = "requests_per_day"
            case tokensUsedToday = "tokens_used_today"
            case requestsToday = "requests_today"
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            tokensPerDay = try container.decodeIfPresent(Int.self, forKey: .tokensPerDay)
            requestsPerDay = try container.decodeIfPresent(Int.self, forKey: .requestsPerDay)
            tokensUsedToday = try container.decodeIfPresent(Int.self, forKey: .tokensUsedToday) ?? 0
            requestsToday = try container.decodeIfPresent(Int.self, forKey: .requestsToday) ?? 0
        }

        /// Tokens left today, when a daily token budget is set.
        public var tokensRemainingToday: Int? { tokensPerDay.map { max(0, $0 - tokensUsedToday) } }
    }

    public var grantId: String
    public var clientId: String
    public var scope: String
    /// `active`, `paused`, `revoked` or `pending`.
    public var status: String
    public var slots: [ModelPassSlot]
    public var budget: Budget?
    public var createdAt: Date?
    public var expiresAt: Date?

    public var isActive: Bool { status == "active" }
    public var isPaused: Bool { status == "paused" }

    public init(grantId: String, clientId: String, scope: String, status: String, slots: [ModelPassSlot],
                budget: Budget? = nil, createdAt: Date? = nil, expiresAt: Date? = nil) {
        self.grantId = grantId
        self.clientId = clientId
        self.scope = scope
        self.status = status
        self.slots = slots
        self.budget = budget
        self.createdAt = createdAt
        self.expiresAt = expiresAt
    }

    private enum CodingKeys: String, CodingKey {
        case grantId = "grant_id"
        case clientId = "client_id"
        case scope, status, slots, budget
        case createdAt = "created_at"
        case expiresAt = "expires_at"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        grantId = try container.decode(String.self, forKey: .grantId)
        clientId = try container.decodeIfPresent(String.self, forKey: .clientId) ?? ""
        scope = try container.decodeIfPresent(String.self, forKey: .scope) ?? ""
        status = try container.decodeIfPresent(String.self, forKey: .status) ?? "active"
        slots = try container.decodeIfPresent([ModelPassSlot].self, forKey: .slots) ?? []
        budget = try container.decodeIfPresent(Budget.self, forKey: .budget)
        // Timestamps are epoch seconds.
        createdAt = try container.decodeIfPresent(Double.self, forKey: .createdAt).map(Date.init(timeIntervalSince1970:))
        expiresAt = try container.decodeIfPresent(Double.self, forKey: .expiresAt).map(Date.init(timeIntervalSince1970:))
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(grantId, forKey: .grantId)
        try container.encode(clientId, forKey: .clientId)
        try container.encode(scope, forKey: .scope)
        try container.encode(status, forKey: .status)
        try container.encode(slots, forKey: .slots)
        try container.encodeIfPresent(budget, forKey: .budget)
        try container.encodeIfPresent(createdAt?.timeIntervalSince1970, forKey: .createdAt)
        try container.encodeIfPresent(expiresAt?.timeIntervalSince1970, forKey: .expiresAt)
    }
}
