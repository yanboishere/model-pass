import Foundation

extension ModelPass {
    /// Starts the cross-device "link" flow (§7): show `link.qrURL` as a QR code (and `link.userCode` as text),
    /// then `try await link.waitForSession()`. Use it when the wallet is on another device (iPad, Mac, TV…) or not
    /// installed on this one.
    ///
    /// The token travels end-to-end encrypted with a one-time secret that only exists in the QR code, so the
    /// rendezvous hub can neither read nor forge it.
    ///
    /// - Parameter rendezvous: The hub used as meeting point, e.g. `https://hub.example.com`. It does not have to
    ///   be the user's own hub.
    public func startLink(rendezvous: URL, scopes: [String]? = nil, slots: [String]? = nil) async throws -> ModelPassLink {
        guard IssuerPolicy.isAllowedURL(rendezvous) else {
            throw ModelPassError.untrustedIssuer(rendezvous.absoluteString)
        }
        let base = IssuerPolicy.normalize(rendezvous)
        let secret = LinkCrypto.makeSecret()
        let verifier = LinkCrypto.verifier(secret: secret)
        let request = HTTPClient.formRequest(IssuerPolicy.endpoint(base, ModelPassProtocol.deviceAuthorizationPath), [
            ("client_id", configuration.clientId),
            ("scope", Self.normalizedList(scopes ?? configuration.scopes, required: "chat").joined(separator: " ")),
            ("slots", Self.normalizedList(slots ?? configuration.slots, required: "default").joined(separator: " ")),
            ("client_name", configuration.clientName),
            ("link_challenge", LinkCrypto.challenge(verifier: verifier)),
            ("link_challenge_method", "S256"),
        ])
        let (data, response) = try await HTTPClient(urlSession: urlSession).send(request)
        guard (200..<300).contains(response.statusCode) else {
            let oauth = HTTPClient.oauthError(from: data)
            throw ModelPassError.authorizationFailed(
                code: oauth?.error ?? "server_error",
                description: oauth?.description ?? "HTTP \(response.statusCode)"
            )
        }
        let device: DeviceAuthorizationResponse
        do {
            device = try JSONDecoder().decode(DeviceAuthorizationResponse.self, from: data)
        } catch {
            throw ModelPassError.invalidResponse("malformed device authorization response")
        }
        guard !device.deviceCode.isEmpty,
              !LinkCrypto.normalizeUserCode(device.userCode).isEmpty,
              let verificationURI = URL(string: device.verificationURI),
              IssuerPolicy.isAllowedURL(verificationURI),
              let qrURL = LinkCrypto.qrURL(verificationURI: device.verificationURI, userCode: device.userCode, secret: secret),
              let walletURL = LinkCrypto.walletURL(rendezvous: base.absoluteString, userCode: device.userCode, secret: secret)
        else {
            throw ModelPassError.invalidResponse("invalid device authorization response")
        }
        return ModelPassLink(
            owner: self,
            tokenEndpoint: IssuerPolicy.endpoint(base, ModelPassProtocol.tokenPath),
            deviceCode: device.deviceCode,
            userCode: LinkCrypto.formatUserCode(device.userCode),
            secret: secret,
            qrURL: qrURL,
            walletURL: walletURL,
            verificationURI: verificationURI,
            expiresAt: now().addingTimeInterval(max(1, device.expiresIn ?? 600)),
            interval: max(1, device.interval ?? 5)
        )
    }
}

/// A pending cross-device authorization (§7). Display `qrURL` as a QR code together with `userCode`, then await
/// `waitForSession()`. Destroy the QR code once this completes, fails or is cancelled (§13.7).
@MainActor
public final class ModelPassLink: Identifiable {
    public nonisolated let id = UUID()
    /// Code to show next to the QR code so the user can compare it in the wallet, e.g. `BCDF-GHJK`.
    public nonisolated let userCode: String
    /// QR code content: `{verification_uri}#v=1&uc={user_code}&s={base64url(s)}`. Treat it as a one-time secret.
    public nonisolated let qrURL: URL
    /// `modelpass://link?rv=…&uc=…&s=…` — opens the wallet directly when it is installed on this device.
    public nonisolated let walletURL: URL
    /// The rendezvous' landing page (without the secret).
    public nonisolated let verificationURI: URL
    /// When the code expires (`expires_in`, typically 10 minutes).
    public nonisolated let expiresAt: Date
    /// Current polling interval in seconds (`interval`, +5 s after every `slow_down`).
    public private(set) var pollingInterval: TimeInterval
    public private(set) var isCancelled = false

    private let owner: ModelPass
    private let tokenEndpoint: URL
    private let deviceCode: String
    private var secret: Data
    private var pollTask: Task<ModelPassSession, Error>?

    init(owner: ModelPass, tokenEndpoint: URL, deviceCode: String, userCode: String, secret: Data, qrURL: URL,
         walletURL: URL, verificationURI: URL, expiresAt: Date, interval: TimeInterval) {
        self.owner = owner
        self.tokenEndpoint = tokenEndpoint
        self.deviceCode = deviceCode
        self.userCode = userCode
        self.secret = secret
        self.qrURL = qrURL
        self.walletURL = walletURL
        self.verificationURI = verificationURI
        self.expiresAt = expiresAt
        self.pollingInterval = interval
    }

    /// True once `expiresAt` has passed.
    public var isExpired: Bool { owner.now() >= expiresAt }

    /// Polls `POST {rendezvous}/oauth/token` until the user approves in the wallet, then decrypts the sealed token
    /// response, stores the session on the owning `ModelPass` and returns it.
    ///
    /// - Throws: `ModelPassError.linkDenied`, `.linkExpired`, `.cancelled` (via `cancel()` or task cancellation),
    ///   `.untrustedIssuer`, `.invalidResponse` (e.g. a payload that does not decrypt).
    public func waitForSession() async throws -> ModelPassSession {
        if isCancelled { throw ModelPassError.cancelled }
        let task: Task<ModelPassSession, Error>
        if let pollTask {
            task = pollTask
        } else {
            task = Task { @MainActor in try await self.poll() }
            pollTask = task
        }
        return try await withTaskCancellationHandler {
            try await task.value
        } onCancel: {
            task.cancel()
        }
    }

    /// Stops polling; `waitForSession()` throws `ModelPassError.cancelled`.
    public func cancel() {
        isCancelled = true
        pollTask?.cancel()
        secret = Data()
    }

    private func poll() async throws -> ModelPassSession {
        let http = HTTPClient(urlSession: owner.urlSession)
        do {
            while true {
                if isCancelled || Task.isCancelled { throw ModelPassError.cancelled }
                if owner.now() >= expiresAt { throw ModelPassError.linkExpired }
                try await owner.sleep(pollingInterval)
                if isCancelled || Task.isCancelled { throw ModelPassError.cancelled }

                let request = HTTPClient.formRequest(tokenEndpoint, [
                    ("grant_type", ModelPassProtocol.deviceCodeGrantType),
                    ("device_code", deviceCode),
                    ("client_id", owner.configuration.clientId),
                ])
                let data: Data
                let response: HTTPURLResponse
                do {
                    (data, response) = try await http.send(request)
                } catch ModelPassError.network(_) {
                    continue // transient (offline, timeout): keep polling until the code expires
                }
                if isCancelled { throw ModelPassError.cancelled }

                let status = response.statusCode
                if (200..<300).contains(status) {
                    let session = try await openSealedTokenResponse(data)
                    secret = Data()
                    owner.adopt(session)
                    return session
                }
                let oauth = HTTPClient.oauthError(from: data)
                switch oauth?.error {
                case "authorization_pending":
                    continue
                case "slow_down":
                    pollingInterval += 5 // RFC 8628 §3.5
                case "access_denied":
                    throw ModelPassError.linkDenied
                case "expired_token":
                    throw ModelPassError.linkExpired
                default:
                    if status == 429 {
                        pollingInterval += 5
                    } else if status < 500 {
                        throw ModelPassError.tokenExchangeFailed(oauth?.error ?? "server_error", oauth?.description ?? "HTTP \(status)")
                    } // 5xx: transient, keep polling
                }
            }
        } catch is CancellationError {
            throw ModelPassError.cancelled
        }
    }

    /// `{"modelpass_sealed": "…"}` → token response (§7.4) → validated session.
    private func openSealedTokenResponse(_ data: Data) async throws -> ModelPassSession {
        guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let sealed = object["modelpass_sealed"] as? String else {
            throw ModelPassError.invalidResponse("the rendezvous returned no modelpass_sealed payload")
        }
        let plaintext: Data
        do {
            plaintext = try LinkCrypto.open(secret: secret, userCode: userCode, sealed: sealed)
        } catch {
            // Wrong key / AAD / tampered payload: the rendezvous cannot forge a token we would accept.
            throw ModelPassError.invalidResponse("the sealed token response could not be decrypted")
        }
        let token = try TokenResponse.decode(plaintext)
        guard let iss = token.issuer, !iss.isEmpty else {
            throw ModelPassError.invalidResponse("the token response contains no issuer")
        }
        let issuer = try IssuerPolicy.validateIssuer(iss, trusted: owner.configuration.trustedIssuers)
        try await owner.confirmIssuer(issuer)
        return try token.makeSession(issuer: issuer, receivedAt: owner.now())
    }
}
