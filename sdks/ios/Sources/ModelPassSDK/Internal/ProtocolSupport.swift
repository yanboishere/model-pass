import Foundation

/// Constants of the ModelPass Connect protocol v0.1 (see docs/protocol.md).
enum ModelPassProtocol {
    static let version = "0.1"
    static let discoveryPath = "/.well-known/modelpass-configuration"
    static let tokenPath = "/oauth/token"
    static let deviceAuthorizationPath = "/oauth/device_authorization"
    static let revocationPath = "/oauth/revoke"
    /// Relative to `api_base`.
    static let grantInfoPath = "/modelpass/grant"
    /// Relative to `api_base`.
    static let chatCompletionsPath = "/chat/completions"
    static let deviceCodeGrantType = "urn:ietf:params:oauth:grant-type:device_code"
    static let walletLinkURL = "modelpass://link"
    static let walletGrantsURL = "modelpass://grants/"
    static let defaultWalletAuthorizeURL = "modelpass://authorize"
}

// MARK: - PKCE (RFC 7636, protocol §6.1)

enum PKCE {
    /// 32 random bytes → 43-character base64url string (RFC 7636 §4.1).
    static func makeVerifier() -> String { Base64URL.encode(MPCrypto.randomBytes(32)) }

    /// 128-bit random `state` (base64url, 22 characters).
    static func makeState() -> String { Base64URL.encode(MPCrypto.randomBytes(16)) }

    /// S256 transform: base64url(SHA256(ASCII(verifier))). Also used for the link flow's `link_challenge`.
    static func challenge(for verifier: String) -> String {
        Base64URL.encode(MPCrypto.sha256(Data(verifier.utf8)))
    }
}

// MARK: - Link flow crypto (protocol §7)

enum LinkCrypto {
    static let verifierMessage = "modelpass/v1/link-verifier"
    static let sealSalt = "modelpass/v1"
    static let sealInfo = "link-seal"
    static let aadPrefix = "modelpass/v1/link/"

    static func makeSecret() -> Data { MPCrypto.randomBytes(32) }

    /// link_verifier = base64url(HMAC-SHA256(key = s, msg = "modelpass/v1/link-verifier"))
    static func verifier(secret: Data) -> String {
        Base64URL.encode(MPCrypto.hmacSHA256(key: secret, message: Data(verifierMessage.utf8)))
    }

    /// link_challenge = base64url(SHA256(ASCII(link_verifier)))
    static func challenge(verifier: String) -> String { PKCE.challenge(for: verifier) }

    /// K = HKDF-SHA256(ikm = s, salt = "modelpass/v1", info = "link-seal", L = 32)
    static func sealKey(secret: Data) -> Data {
        MPCrypto.hkdfSHA256(ikm: secret, salt: Data(sealSalt.utf8), info: Data(sealInfo.utf8), length: 32)
    }

    /// Letters only, upper-cased: `bcdf-ghjk` → `BCDFGHJK`.
    static func normalizeUserCode(_ userCode: String) -> String {
        let letters = userCode.unicodeScalars.filter { (65...90).contains($0.value) || (97...122).contains($0.value) }
        return String(String.UnicodeScalarView(letters)).uppercased()
    }

    /// `BCDFGHJK` → `BCDF-GHJK` (codes of other lengths are returned normalized).
    static func formatUserCode(_ userCode: String) -> String {
        let normalized = normalizeUserCode(userCode)
        guard normalized.count == 8 else { return normalized }
        return "\(normalized.prefix(4))-\(normalized.suffix(4))"
    }

    /// AAD = "modelpass/v1/link/" + normalized user code.
    static func aad(userCode: String) -> Data { Data((aadPrefix + normalizeUserCode(userCode)).utf8) }

    /// sealed = base64url(nonce ‖ AES-256-GCM(K, nonce, plaintext, AAD) ‖ tag)
    static func seal(secret: Data, userCode: String, plaintext: Data, nonce: Data? = nil) throws -> String {
        let sealed = try MPCrypto.aesGCMSeal(key: sealKey(secret: secret), plaintext: plaintext, aad: aad(userCode: userCode), nonce: nonce)
        return Base64URL.encode(sealed)
    }

    static func open(secret: Data, userCode: String, sealed: String) throws -> Data {
        guard let data = Base64URL.decode(sealed) else {
            throw ModelPassError.invalidResponse("modelpass_sealed is not valid base64url")
        }
        return try MPCrypto.aesGCMOpen(key: sealKey(secret: secret), sealed: data, aad: aad(userCode: userCode))
    }

    /// QR content: `{verification_uri}#v=1&uc=BCDF-GHJK&s=<base64url(s)>` (§7.2).
    static func qrURL(verificationURI: String, userCode: String, secret: Data) -> URL? {
        let fragment = QueryString.encode([("v", "1"), ("uc", formatUserCode(userCode)), ("s", Base64URL.encode(secret))])
        return URL(string: "\(verificationURI)#\(fragment)")
    }

    /// Wallet deep link: `modelpass://link?rv=<rendezvous>&uc=…&s=…` (§7.2).
    static func walletURL(rendezvous: String, userCode: String, secret: Data) -> URL? {
        let query = QueryString.encode([("rv", rendezvous), ("uc", formatUserCode(userCode)), ("s", Base64URL.encode(secret))])
        return URL(string: "\(ModelPassProtocol.walletLinkURL)?\(query)")
    }
}

// MARK: - Query strings

enum QueryString {
    /// Characters left unescaped by JavaScript's `encodeURIComponent` (keeps URLs identical to the JS SDK).
    static let componentAllowed: CharacterSet = {
        var set = CharacterSet()
        set.insert(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
        return set
    }()

    static func encodeComponent(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: componentAllowed) ?? value
    }

    /// `k=v&k2=v2`; nil / empty values are skipped (same as `encodeQuery` in packages/core).
    static func encode(_ params: [(String, String?)]) -> String {
        params.compactMap { key, value -> String? in
            guard let value, !value.isEmpty else { return nil }
            return "\(encodeComponent(key))=\(encodeComponent(value))"
        }
        .joined(separator: "&")
    }

    /// Parses `a=1&b=x%20y` (also accepts `+` for spaces). The first occurrence of a key wins.
    static func parse(_ query: String) -> [String: String] {
        var out: [String: String] = [:]
        var rest = Substring(query)
        if rest.hasPrefix("?") || rest.hasPrefix("#") { rest = rest.dropFirst() }
        for part in rest.split(separator: "&") {
            let pieces = part.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            let key = decodeComponent(pieces[0])
            let value = pieces.count > 1 ? decodeComponent(pieces[1]) : ""
            if out[key] == nil { out[key] = value }
        }
        return out
    }

    private static func decodeComponent(_ component: Substring) -> String {
        let spaced = component.replacingOccurrences(of: "+", with: " ")
        return spaced.removingPercentEncoding ?? spaced
    }

    /// Query parameters of any URL (custom schemes included), ignoring the fragment.
    static func parameters(of url: URL) -> [String: String] {
        let string = url.absoluteString
        guard let questionMark = string.firstIndex(of: "?") else { return [:] }
        var query = string[string.index(after: questionMark)...]
        if let hash = query.firstIndex(of: "#") { query = query[..<hash] }
        return parse(String(query))
    }

    /// Fragment parameters, e.g. of a link-flow QR URL.
    static func fragmentParameters(of url: URL) -> [String: String] {
        let string = url.absoluteString
        guard let hash = string.firstIndex(of: "#") else { return [:] }
        return parse(String(string[string.index(after: hash)...]))
    }

    /// Appends a query to a URL that may already contain a query string and/or fragment.
    static func append(_ query: String, to url: String) -> String {
        guard !query.isEmpty else { return url }
        var base = Substring(url)
        var fragment: Substring = ""
        if let hash = url.firstIndex(of: "#") {
            base = url[..<hash]
            fragment = url[hash...]
        }
        let separator: String
        if base.contains("?") {
            separator = (base.hasSuffix("?") || base.hasSuffix("&")) ? "" : "&"
        } else {
            separator = "?"
        }
        return "\(base)\(separator)\(query)\(fragment)"
    }
}

// MARK: - Issuer / endpoint policy (protocol §3, §6.2, §13.2)

enum IssuerPolicy {
    /// `https` everywhere; plain `http` only for loopback, private LAN addresses and mDNS (`.local`) hosts.
    static func isAllowedURL(_ url: URL) -> Bool {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let scheme = components.scheme?.lowercased(),
              let host = components.host, !host.isEmpty,
              components.user == nil, components.password == nil
        else { return false }
        switch scheme {
        case "https": return true
        case "http": return isLocalDevelopmentHost(host)
        default: return false
        }
    }

    /// localhost, *.localhost, *.local, 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, ::1, fc00::/7, fe80::/10.
    static func isLocalDevelopmentHost(_ rawHost: String) -> Bool {
        var host = rawHost.lowercased()
        if host.hasPrefix("["), host.hasSuffix("]") { host = String(host.dropFirst().dropLast()) }
        if host.hasSuffix(".") { host.removeLast() }
        if host == "localhost" || host.hasSuffix(".localhost") || host.hasSuffix(".local") { return true }
        if let octets = ipv4Octets(host) {
            switch (octets[0], octets[1]) {
            case (127, _), (10, _), (192, 168), (169, 254), (172, 16...31): return true
            default: return false
            }
        }
        if host.contains(":") {
            if host == "::1" || host == "0:0:0:0:0:0:0:1" { return true }
            let firstGroup = host.split(separator: ":", omittingEmptySubsequences: false).first.map(String.init) ?? ""
            if let value = UInt16(firstGroup, radix: 16) {
                if value & 0xFE00 == 0xFC00 { return true } // fc00::/7 unique local
                if value & 0xFFC0 == 0xFE80 { return true } // fe80::/10 link local
            }
        }
        return false
    }

    static func ipv4Octets(_ host: String) -> [Int]? {
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return nil }
        var octets: [Int] = []
        for part in parts {
            guard !part.isEmpty, part.count <= 3, part.allSatisfy({ $0.isASCII && $0.isNumber }),
                  let value = Int(part), value <= 255 else { return nil }
            octets.append(value)
        }
        return octets
    }

    /// Validates an `iss` value (RFC 9207) and returns it normalized (no trailing slash).
    static func validateIssuer(_ raw: String, trusted: [String]?) throws -> URL {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed), isAllowedURL(url),
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.query == nil, components.fragment == nil
        else { throw ModelPassError.untrustedIssuer(raw) }
        let normalized = normalize(url)
        if let trusted, !trusted.contains(where: { sameIssuer($0, normalized.absoluteString) }) {
            throw ModelPassError.untrustedIssuer(raw)
        }
        return normalized
    }

    /// Removes trailing slashes: `https://hub.example.com/` → `https://hub.example.com`.
    static func normalize(_ url: URL) -> URL {
        var string = url.absoluteString
        while string.hasSuffix("/") { string.removeLast() }
        return URL(string: string) ?? url
    }

    /// Compares two issuer identifiers: case-insensitive scheme/host, default ports, trailing slashes ignored.
    static func sameIssuer(_ a: String, _ b: String) -> Bool {
        guard let ua = URL(string: a.trimmingCharacters(in: .whitespacesAndNewlines)),
              let ub = URL(string: b.trimmingCharacters(in: .whitespacesAndNewlines)),
              let ca = URLComponents(url: ua, resolvingAgainstBaseURL: false),
              let cb = URLComponents(url: ub, resolvingAgainstBaseURL: false),
              ca.host != nil
        else { return false }
        func path(_ c: URLComponents) -> String {
            var p = c.percentEncodedPath
            while p.hasSuffix("/") { p.removeLast() }
            return p
        }
        return ca.scheme?.lowercased() == cb.scheme?.lowercased()
            && ca.host?.lowercased() == cb.host?.lowercased()
            && effectivePort(ca) == effectivePort(cb)
            && path(ca) == path(cb)
    }

    private static func effectivePort(_ components: URLComponents) -> Int? {
        if let port = components.port { return port }
        switch components.scheme?.lowercased() {
        case "https": return 443
        case "http": return 80
        default: return nil
        }
    }

    /// `{base}{path}` — string concatenation so that issuers with a path prefix keep it.
    static func endpoint(_ base: URL, _ path: String) -> URL {
        var string = base.absoluteString
        while string.hasSuffix("/") { string.removeLast() }
        return URL(string: string + path) ?? base.appendingPathComponent(path)
    }
}

// MARK: - Redirect matching

enum RedirectMatcher {
    /// True when `url` targets the configured redirect URI (scheme, host, port and path; query/fragment ignored).
    static func matches(_ url: URL, redirectURI: URL) -> Bool {
        guard let a = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let b = URLComponents(url: redirectURI, resolvingAgainstBaseURL: false),
              let schemeA = a.scheme, let schemeB = b.scheme
        else { return false }
        func path(_ c: URLComponents) -> String {
            var p = c.percentEncodedPath
            while p.hasSuffix("/") { p.removeLast() }
            return p
        }
        return schemeA.lowercased() == schemeB.lowercased()
            && (a.host ?? "").lowercased() == (b.host ?? "").lowercased()
            && a.port == b.port
            && path(a) == path(b)
    }
}

// MARK: - Persisted state & wire types

/// The in-flight same-device authorization request. Persisted (it contains the PKCE verifier, so it lives in the
/// secure session store) so that the redirect can still be completed after the app was terminated in the background.
struct PendingAuthorization: Codable, Equatable {
    var state: String
    var codeVerifier: String
    var redirectURI: String
    var clientId: String
    var scopes: [String]
    var slots: [String]
    var createdAt: Date

    /// How long a pending request stays valid (first-time wallet setup can take a while).
    static let lifetime: TimeInterval = 30 * 60
}

/// `GET {issuer}/.well-known/modelpass-configuration` (§5). Only the fields the SDK needs.
struct DiscoveryDocument: Decodable {
    let issuer: String
    let tokenEndpoint: String?
    let revocationEndpoint: String?
    let apiBase: String?

    enum CodingKeys: String, CodingKey {
        case issuer
        case tokenEndpoint = "token_endpoint"
        case revocationEndpoint = "revocation_endpoint"
        case apiBase = "api_base"
    }
}

/// Response of `POST {rendezvous}/oauth/device_authorization` (§7.1).
struct DeviceAuthorizationResponse: Decodable {
    let deviceCode: String
    let userCode: String
    let verificationURI: String
    let expiresIn: Double?
    let interval: Double?

    enum CodingKeys: String, CodingKey {
        case deviceCode = "device_code"
        case userCode = "user_code"
        case verificationURI = "verification_uri"
        case expiresIn = "expires_in"
        case interval
    }
}

/// Token response (§6.4). Also the plaintext of the link flow's `modelpass_sealed` payload (§7.3).
struct TokenResponse: Decodable {
    let accessToken: String
    let tokenType: String?
    let expiresIn: Double?
    let scope: String?
    let grantId: String
    let sub: String?
    let issuer: String?
    let apiBase: String
    let apiFormats: [String]?
    let slots: [ModelPassSlot]?

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case tokenType = "token_type"
        case expiresIn = "expires_in"
        case scope
        case grantId = "grant_id"
        case sub
        case issuer
        case apiBase = "api_base"
        case apiFormats = "api_formats"
        case slots
    }

    static func decode(_ data: Data) throws -> TokenResponse {
        do {
            return try JSONDecoder().decode(TokenResponse.self, from: data)
        } catch {
            throw ModelPassError.invalidResponse("malformed token response (\(Self.describe(error)))")
        }
    }

    /// Builds a session. `issuer` is the already validated hub the token was obtained from.
    func makeSession(issuer: URL, receivedAt: Date) throws -> ModelPassSession {
        guard !accessToken.isEmpty else { throw ModelPassError.invalidResponse("empty access_token") }
        guard !grantId.isEmpty else { throw ModelPassError.invalidResponse("empty grant_id") }
        guard let base = URL(string: apiBase), IssuerPolicy.isAllowedURL(base) else {
            throw ModelPassError.invalidResponse("api_base must be an https URL (http only for local development): \(apiBase)")
        }
        return ModelPassSession(
            accessToken: accessToken,
            tokenType: tokenType ?? "Bearer",
            issuer: issuer,
            apiBase: IssuerPolicy.normalize(base),
            grantId: grantId,
            scope: scope ?? "chat",
            sub: sub ?? "",
            slots: slots ?? [ModelPassSlot(id: "default")],
            apiFormats: apiFormats ?? ["openai-chat-completions"],
            // Whole seconds (the protocol's granularity) so the date survives persistence exactly.
            expiresAt: expiresIn.map { Date(timeIntervalSince1970: (receivedAt.timeIntervalSince1970 + $0).rounded(.down)) }
        )
    }

    private static func describe(_ error: Error) -> String {
        switch error {
        case DecodingError.keyNotFound(let key, _): return "missing \(key.stringValue)"
        case DecodingError.typeMismatch(_, let context), DecodingError.valueNotFound(_, let context):
            return "bad \(context.codingPath.map(\.stringValue).joined(separator: "."))"
        default: return "not JSON"
        }
    }
}
