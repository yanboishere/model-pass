import XCTest
@testable import ModelPassSDK

/// Cross-device link flow (§7) against a stubbed rendezvous hub.
@MainActor
final class LinkFlowTests: XCTestCase {
    private let rendezvous = URL(string: "https://rv.example.com")!

    private func makeModelPass(store: InMemorySessionStore = InMemorySessionStore(),
                               configuration: ModelPassConfiguration = Fixtures.configuration()) -> ModelPass {
        ModelPass(configuration: configuration, sessionStore: store, urlSession: StubURLProtocol.makeSession(), urlOpener: StubOpener())
    }

    /// Rendezvous stub: device authorization + a scripted sequence of token poll responses.
    /// `polls` entries are evaluated lazily so the test can seal the payload once it knows `s`.
    private func installRendezvous(interval: Int = 2, expiresIn: Int = 600, polls: [@Sendable () -> StubResponse]) {
        let step = Locked(0)
        StubURLProtocol.reset { request in
            switch (request.method, request.path) {
            case ("POST", "/oauth/device_authorization"):
                return .json([
                    "device_code": "dc_1",
                    "user_code": "BCDF-GHJK",
                    "verification_uri": "https://rv.example.com/link",
                    "expires_in": expiresIn,
                    "interval": interval,
                ])
            case ("POST", "/oauth/token"):
                let index = step.mutate { value -> Int in
                    defer { value += 1 }
                    return value
                }
                return polls[min(index, polls.count - 1)]()
            default:
                return .json(["error": "not_found"], status: 404)
            }
        }
    }

    private static func oauthError(_ code: String) -> @Sendable () -> StubResponse {
        { .json(["error": code], status: 400) }
    }

    private func secret(of link: ModelPassLink) throws -> Data {
        try XCTUnwrap(Base64URL.decode(try XCTUnwrap(QueryString.fragmentParameters(of: link.qrURL)["s"])))
    }

    private static func seal(_ token: [String: Any], secret: Data, userCode: String = "BCDF-GHJK") -> String {
        let json = try! JSONSerialization.data(withJSONObject: token)
        return try! LinkCrypto.seal(secret: secret, userCode: userCode, plaintext: json)
    }

    func testLinkFlowEndToEnd() async throws {
        let sealed = Locked<String?>(nil)
        installRendezvous(polls: [
            Self.oauthError("authorization_pending"),
            Self.oauthError("slow_down"),
            { .json(["modelpass_sealed": sealed.current!]) },
        ])
        let store = InMemorySessionStore()
        let modelPass = makeModelPass(store: store)
        let sleeps = Locked<[TimeInterval]>([])
        modelPass.sleep = { seconds in sleeps.mutate { $0.append(seconds) } }
        var changes: [ModelPassSession?] = []
        modelPass.onSessionChange = { changes.append($0) }

        let link = try await modelPass.startLink(rendezvous: rendezvous, scopes: ["chat", "vision"], slots: ["vision"])
        XCTAssertEqual(link.userCode, "BCDF-GHJK")
        XCTAssertEqual(link.verificationURI.absoluteString, "https://rv.example.com/link")
        XCTAssertEqual(link.pollingInterval, 2)
        XCTAssertGreaterThan(link.expiresAt.timeIntervalSinceNow, 590)

        // QR content (§7.2) and the derived link_challenge (§7.1).
        let s = try secret(of: link)
        XCTAssertEqual(s.count, 32)
        XCTAssertEqual(link.qrURL.absoluteString, "https://rv.example.com/link#v=1&uc=BCDF-GHJK&s=\(Base64URL.encode(s))")
        XCTAssertEqual(link.walletURL.absoluteString, "modelpass://link?rv=https%3A%2F%2Frv.example.com&uc=BCDF-GHJK&s=\(Base64URL.encode(s))")
        let deviceRequest = try XCTUnwrap(StubURLProtocol.requests(path: "/oauth/device_authorization").first)
        XCTAssertEqual(deviceRequest.header("Content-Type"), "application/x-www-form-urlencoded")
        XCTAssertEqual(deviceRequest.form, [
            "client_id": "com.example.chat",
            "scope": "chat vision",
            "slots": "default vision",
            "client_name": "Example Chat",
            "link_challenge": LinkCrypto.challenge(verifier: LinkCrypto.verifier(secret: s)),
            "link_challenge_method": "S256",
        ])
        XCTAssertFalse(String(decoding: deviceRequest.body, as: UTF8.self).contains(Base64URL.encode(s))) // s never leaves the device

        // The wallet seals the user's hub token response with s (the user's hub differs from the rendezvous).
        sealed.set(Self.seal(Fixtures.tokenResponse(issuer: "https://my-hub.example.org"), secret: s))
        let session = try await link.waitForSession()

        XCTAssertEqual(sleeps.current, [2, 2, 7]) // interval, interval, interval + 5 after slow_down
        XCTAssertEqual(link.pollingInterval, 7)
        XCTAssertEqual(session.accessToken, "mpk_3wq6oX8d")
        XCTAssertEqual(session.issuer.absoluteString, "https://my-hub.example.org")
        XCTAssertEqual(session.apiBase.absoluteString, "https://my-hub.example.org/v1")
        XCTAssertEqual(modelPass.session, session)
        XCTAssertEqual(changes, [session])
        XCTAssertEqual(store.keys, ["session"])

        let polls = StubURLProtocol.requests(path: "/oauth/token")
        XCTAssertEqual(polls.count, 3)
        XCTAssertEqual(polls[0].form, [
            "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
            "device_code": "dc_1",
            "client_id": "com.example.chat",
        ])

        // Awaiting again returns the same result without polling again.
        let again = try await link.waitForSession()
        XCTAssertEqual(again, session)
        XCTAssertEqual(StubURLProtocol.requests(path: "/oauth/token").count, 3)
    }

    func testDeniedAndExpiredCodes() async throws {
        let modelPass = makeModelPass()
        modelPass.sleep = { _ in }

        installRendezvous(polls: [Self.oauthError("authorization_pending"), Self.oauthError("access_denied")])
        var link = try await modelPass.startLink(rendezvous: rendezvous)
        await assertThrows(.linkDenied) { try await link.waitForSession() }

        installRendezvous(polls: [Self.oauthError("expired_token")])
        link = try await modelPass.startLink(rendezvous: rendezvous)
        await assertThrows(.linkExpired) { try await link.waitForSession() }

        installRendezvous(polls: [Self.oauthError("invalid_grant")])
        link = try await modelPass.startLink(rendezvous: rendezvous)
        await assertThrows(.tokenExchangeFailed("invalid_grant", "HTTP 400")) { try await link.waitForSession() }
        XCTAssertNil(modelPass.session)
    }

    func testLocalExpiryStopsPolling() async throws {
        installRendezvous(expiresIn: 60, polls: [Self.oauthError("authorization_pending")])
        let modelPass = makeModelPass()
        modelPass.sleep = { _ in }
        let link = try await modelPass.startLink(rendezvous: rendezvous)
        modelPass.now = { Date().addingTimeInterval(120) }
        XCTAssertTrue(link.isExpired)
        await assertThrows(.linkExpired) { try await link.waitForSession() }
        XCTAssertTrue(StubURLProtocol.requests(path: "/oauth/token").isEmpty)
    }

    func testTransientErrorsKeepPolling() async throws {
        let sealed = Locked<String?>(nil)
        installRendezvous(polls: [
            { .text("Service Unavailable", status: 503) },
            { .json(["error": "rate_limited"], status: 429) },
            { .json(["modelpass_sealed": sealed.current!]) },
        ])
        let modelPass = makeModelPass()
        let sleeps = Locked<[TimeInterval]>([])
        modelPass.sleep = { seconds in sleeps.mutate { $0.append(seconds) } }
        let link = try await modelPass.startLink(rendezvous: rendezvous)
        sealed.set(Self.seal(Fixtures.tokenResponse(), secret: try secret(of: link)))
        _ = try await link.waitForSession()
        XCTAssertEqual(sleeps.current, [2, 2, 7])
    }

    func testForgedOrMisdirectedPayloadsAreRejected() async throws {
        let modelPass = makeModelPass()
        modelPass.sleep = { _ in }

        // Sealed with a key the client never generated (a malicious rendezvous cannot know s).
        let forged = Self.seal(Fixtures.tokenResponse(), secret: Data(repeating: 1, count: 32))
        installRendezvous(polls: [{ .json(["modelpass_sealed": forged]) }])
        var link = try await modelPass.startLink(rendezvous: rendezvous)
        var error = await thrownError { try await link.waitForSession() }
        guard case .invalidResponse = error else { return XCTFail("expected invalidResponse, got \(String(describing: error))") }

        // Sealed for another user code (AAD mismatch).
        let otherCode = Locked<String?>(nil)
        installRendezvous(polls: [{ .json(["modelpass_sealed": otherCode.current!]) }])
        link = try await modelPass.startLink(rendezvous: rendezvous)
        otherCode.set(Self.seal(Fixtures.tokenResponse(), secret: try secret(of: link), userCode: "BBBB-BBBB"))
        error = await thrownError { try await link.waitForSession() }
        guard case .invalidResponse = error else { return XCTFail("expected invalidResponse, got \(String(describing: error))") }

        // Success response without a sealed payload.
        installRendezvous(polls: [{ .json(Fixtures.tokenResponse()) }])
        link = try await modelPass.startLink(rendezvous: rendezvous)
        error = await thrownError { try await link.waitForSession() }
        guard case .invalidResponse = error else { return XCTFail("expected invalidResponse, got \(String(describing: error))") }
        XCTAssertNil(modelPass.session)
    }

    func testTrustedIssuersApplyToTheDecryptedToken() async throws {
        let sealed = Locked<String?>(nil)
        installRendezvous(polls: [{ .json(["modelpass_sealed": sealed.current!]) }])
        let modelPass = makeModelPass(configuration: Fixtures.configuration(trustedIssuers: ["https://hub.example.com"]))
        modelPass.sleep = { _ in }
        let link = try await modelPass.startLink(rendezvous: rendezvous)
        sealed.set(Self.seal(Fixtures.tokenResponse(issuer: "https://untrusted.example.net"), secret: try secret(of: link)))
        await assertThrows(.untrustedIssuer("https://untrusted.example.net")) { try await link.waitForSession() }
        XCTAssertNil(modelPass.session)
    }

    func testCancel() async throws {
        installRendezvous(polls: [Self.oauthError("authorization_pending")])
        let modelPass = makeModelPass()
        modelPass.sleep = { _ in try await Task.sleep(nanoseconds: 20_000_000) }

        let link = try await modelPass.startLink(rendezvous: rendezvous)
        let waiting = Task { try await link.waitForSession() }
        try await waitUntil { !StubURLProtocol.requests(path: "/oauth/token").isEmpty }
        link.cancel()
        await assertThrows(.cancelled) { try await waiting.value }
        XCTAssertTrue(link.isCancelled)
        await assertThrows(.cancelled) { try await link.waitForSession() }

        // Cancelling the awaiting task stops polling too.
        let second = try await modelPass.startLink(rendezvous: rendezvous)
        let task = Task { try await second.waitForSession() }
        try await Task.sleep(nanoseconds: 30_000_000)
        task.cancel()
        await assertThrows(.cancelled) { try await task.value }
    }

    func testStartLinkErrors() async throws {
        let modelPass = makeModelPass()
        await assertThrows(.untrustedIssuer("http://rv.example.com")) {
            try await modelPass.startLink(rendezvous: URL(string: "http://rv.example.com")!)
        }

        StubURLProtocol.reset { _ in .json(["error": "invalid_client", "error_description": "unknown client"], status: 400) }
        await assertThrows(.authorizationFailed(code: "invalid_client", description: "unknown client")) {
            try await modelPass.startLink(rendezvous: self.rendezvous)
        }

        StubURLProtocol.reset { _ in .json(["device_code": "dc", "user_code": "BCDF-GHJK", "verification_uri": "http://evil.example.com/link"]) }
        let error = await thrownError { try await modelPass.startLink(rendezvous: self.rendezvous) }
        guard case .invalidResponse = error else { return XCTFail("expected invalidResponse, got \(String(describing: error))") }
    }

    #if canImport(CoreImage)
    func testQRCodeImage() async throws {
        installRendezvous(polls: [Self.oauthError("authorization_pending")])
        let link = try await makeModelPass().startLink(rendezvous: rendezvous)
        let image = try XCTUnwrap(link.qrCodeImage(dimension: 300))
        XCTAssertEqual(image.width, image.height)
        XCTAssertGreaterThanOrEqual(image.width, 200)
        XCTAssertLessThanOrEqual(image.width, 300)
        link.cancel()
    }
    #endif
}
