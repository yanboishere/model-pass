import XCTest
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif
@testable import ModelPassSDK

/// `authorize()` → wallet → `handleRedirect` → discovery → token exchange, against a stubbed hub (§5, §6).
@MainActor
final class SameDeviceFlowTests: XCTestCase {
    private func makeModelPass(store: InMemorySessionStore = InMemorySessionStore(), opener: StubOpener? = nil,
                               configuration: ModelPassConfiguration = Fixtures.configuration()) -> ModelPass {
        ModelPass(configuration: configuration, sessionStore: store, urlSession: StubURLProtocol.makeSession(),
                  urlOpener: opener ?? StubOpener())
    }

    /// A hub at `issuer` with discovery + token endpoint.
    private func installHub(issuer: String = Fixtures.issuer, discovery: StubResponse? = nil,
                            token: StubResponse? = nil, tokenPath: String = "/oauth/token") {
        let discoveryResponse = discovery ?? .json([
            "issuer": issuer,
            "protocol_version": "0.1",
            "token_endpoint": "\(issuer)\(tokenPath)",
            "api_base": "\(issuer)/v1",
        ])
        let tokenResponse = token ?? .json(Fixtures.tokenResponse(issuer: issuer))
        StubURLProtocol.reset { request in
            switch (request.method, request.path) {
            case ("GET", "/.well-known/modelpass-configuration"): return discoveryResponse
            case ("POST", tokenPath): return tokenResponse
            default: return .json(["error": "not_found"], status: 404)
            }
        }
    }

    /// Starts `authorize()` and waits until the wallet was opened; returns the task and the wallet URL parameters.
    private func startAuthorization(_ modelPass: ModelPass, opener: StubOpener, budgetHint: Int? = nil)
        async throws -> (Task<ModelPassSession, Error>, [String: String]) {
        let alreadyOpened = opener.opened.count
        let task = Task { try await modelPass.authorize(budgetHint: budgetHint) }
        try await waitUntil { opener.opened.count > alreadyOpened }
        return (task, QueryString.parameters(of: opener.opened[alreadyOpened]))
    }

    func testAuthorizeHandleRedirectAndExchangeCode() async throws {
        installHub()
        let store = InMemorySessionStore()
        let opener = StubOpener()
        let modelPass = makeModelPass(store: store, opener: opener)
        var changes: [ModelPassSession?] = []
        var results: [Result<ModelPassSession, Error>] = []
        modelPass.onSessionChange = { changes.append($0) }
        modelPass.onAuthorizationResult = { results.append($0) }

        let (task, params) = try await startAuthorization(modelPass, opener: opener, budgetHint: 200_000)
        XCTAssertTrue(modelPass.isAuthorizing)
        XCTAssertEqual(opener.opened[0].scheme, "modelpass")
        XCTAssertEqual(opener.opened[0].host, "authorize")
        XCTAssertEqual(params["response_type"], "code")
        XCTAssertEqual(params["client_id"], "com.example.chat")
        XCTAssertEqual(params["redirect_uri"], "com.example.chat:/modelpass/callback")
        XCTAssertEqual(params["scope"], "chat tools")
        XCTAssertEqual(params["slots"], "default fast")
        XCTAssertEqual(params["client_name"], "Example Chat")
        XCTAssertEqual(params["budget_hint"], "200000")
        XCTAssertEqual(params["code_challenge_method"], "S256")
        XCTAssertEqual(params["state"]?.count, 22)
        XCTAssertEqual(params["code_challenge"]?.count, 43)
        XCTAssertEqual(store.keys, ["pending_authorization"]) // survives a relaunch

        let redirect = Fixtures.redirect([("code", "c_123"), ("state", params["state"]), ("iss", Fixtures.issuer)])
        XCTAssertTrue(modelPass.handleRedirect(redirect))
        let session = try await task.value

        XCTAssertEqual(session.accessToken, "mpk_3wq6oX8d")
        XCTAssertEqual(session.issuer.absoluteString, "https://hub.example.com")
        XCTAssertEqual(session.apiBase.absoluteString, "https://hub.example.com/v1")
        XCTAssertEqual(session.grantId, "g_9xKc2")
        XCTAssertEqual(session.scopes, ["chat", "tools"])
        XCTAssertEqual(session.slots.map(\.id), ["default", "fast"])
        XCTAssertEqual(modelPass.session, session)
        XCTAssertFalse(modelPass.isAuthorizing)
        XCTAssertEqual(changes, [session])
        XCTAssertEqual(results.count, 1)
        XCTAssertEqual(store.keys, ["session"]) // pending request consumed

        // Token request (§6.3).
        let tokenRequest = try XCTUnwrap(StubURLProtocol.requests(path: "/oauth/token").first)
        XCTAssertEqual(tokenRequest.url.absoluteString, "https://hub.example.com/oauth/token")
        XCTAssertEqual(tokenRequest.header("Content-Type"), "application/x-www-form-urlencoded")
        let form = tokenRequest.form
        XCTAssertEqual(form["grant_type"], "authorization_code")
        XCTAssertEqual(form["code"], "c_123")
        XCTAssertEqual(form["redirect_uri"], "com.example.chat:/modelpass/callback")
        XCTAssertEqual(form["client_id"], "com.example.chat")
        XCTAssertEqual(PKCE.challenge(for: try XCTUnwrap(form["code_verifier"])), params["code_challenge"])
        XCTAssertEqual(StubURLProtocol.requests(path: "/.well-known/modelpass-configuration").count, 1)

        // A new instance restores the session from the store.
        XCTAssertEqual(makeModelPass(store: store).session, session)
    }

    func testDiscoveryTokenEndpointIsUsed() async throws {
        installHub(tokenPath: "/custom/token")
        let opener = StubOpener()
        let modelPass = makeModelPass(opener: opener)
        let (task, params) = try await startAuthorization(modelPass, opener: opener)
        modelPass.handleRedirect(Fixtures.redirect([("code", "c"), ("state", params["state"]), ("iss", Fixtures.issuer)]))
        _ = try await task.value
        XCTAssertEqual(StubURLProtocol.requests(path: "/custom/token").count, 1)
    }

    func testFallsBackToConventionalTokenPathWhenDiscoveryFailsOrMismatches() async throws {
        for discovery in [StubResponse.json(["error": "not_found"], status: 404),
                          StubResponse.text("<html>", status: 200),
                          StubResponse.json(["issuer": "https://evil.example.com", "token_endpoint": "https://evil.example.com/oauth/token"])] {
            installHub(discovery: discovery)
            let opener = StubOpener()
            let modelPass = makeModelPass(opener: opener)
            let (task, params) = try await startAuthorization(modelPass, opener: opener)
            modelPass.handleRedirect(Fixtures.redirect([("code", "c"), ("state", params["state"]), ("iss", Fixtures.issuer)]))
            _ = try await task.value
            XCTAssertEqual(StubURLProtocol.requests.last?.url.absoluteString, "https://hub.example.com/oauth/token")
        }
    }

    func testLocalNetworkHubOverHTTPIsAllowed() async throws {
        let lan = "http://192.168.1.5:8787"
        installHub(issuer: lan)
        let opener = StubOpener()
        let modelPass = makeModelPass(opener: opener)
        let (task, params) = try await startAuthorization(modelPass, opener: opener)
        modelPass.handleRedirect(Fixtures.redirect([("code", "c"), ("state", params["state"]), ("iss", lan)]))
        let session = try await task.value
        XCTAssertEqual(session.apiBase.absoluteString, "http://192.168.1.5:8787/v1")
    }

    func testAccessDeniedAndOtherWalletErrors() async throws {
        installHub()
        let opener = StubOpener()
        let modelPass = makeModelPass(opener: opener)
        var (task, params) = try await startAuthorization(modelPass, opener: opener)
        modelPass.handleRedirect(Fixtures.redirect([("error", "access_denied"), ("error_description", "用户拒绝了授权"), ("state", params["state"])]))
        await assertThrows(.accessDenied("用户拒绝了授权")) { try await task.value }
        XCTAssertNil(modelPass.session)
        XCTAssertFalse(modelPass.isAuthorizing)

        (task, params) = try await startAuthorization(modelPass, opener: opener)
        modelPass.handleRedirect(Fixtures.redirect([("error", "invalid_scope"), ("state", params["state"])]))
        await assertThrows(.authorizationFailed(code: "invalid_scope", description: nil)) { try await task.value }
        XCTAssertTrue(StubURLProtocol.requests.isEmpty) // no token exchange attempted
    }

    func testStateMismatchIsRejectedAndKeepsThePendingRequest() async throws {
        installHub()
        let store = InMemorySessionStore()
        let opener = StubOpener()
        let modelPass = makeModelPass(store: store, opener: opener)
        let (task, params) = try await startAuthorization(modelPass, opener: opener)
        modelPass.handleRedirect(Fixtures.redirect([("code", "c"), ("state", "forged-state-value-123"), ("iss", Fixtures.issuer)]))
        await assertThrows(.invalidState) { try await task.value }
        XCTAssertEqual(store.keys, ["pending_authorization"])
        XCTAssertTrue(StubURLProtocol.requests.isEmpty)

        // The genuine redirect can still complete afterwards.
        let session = try await modelPass.completeAuthorization(
            redirectURL: Fixtures.redirect([("code", "c"), ("state", params["state"]), ("iss", Fixtures.issuer)]))
        XCTAssertEqual(modelPass.session, session)
    }

    func testRedirectWithoutPendingRequestOrForUnknownURL() async throws {
        let modelPass = makeModelPass()
        XCTAssertFalse(modelPass.handleRedirect(URL(string: "com.example.chat:/somewhere/else?code=1")!))
        XCTAssertFalse(modelPass.handleRedirect(URL(string: "https://example.com/?code=1")!))
        await assertThrows(.invalidState) {
            try await modelPass.completeAuthorization(redirectURL: Fixtures.redirect([("code", "c"), ("state", "s"), ("iss", Fixtures.issuer)]))
        }
    }

    func testIssuerValidation() async throws {
        installHub()
        let opener = StubOpener()
        let modelPass = makeModelPass(opener: opener)

        var (task, params) = try await startAuthorization(modelPass, opener: opener)
        modelPass.handleRedirect(Fixtures.redirect([("code", "c"), ("state", params["state"]), ("iss", "http://evil.example.com")]))
        await assertThrows(.untrustedIssuer("http://evil.example.com")) { try await task.value }

        (task, params) = try await startAuthorization(modelPass, opener: opener)
        modelPass.handleRedirect(Fixtures.redirect([("code", "c"), ("state", params["state"])]))
        let missing = await thrownError { try await task.value }
        guard case .invalidResponse = missing else { return XCTFail("expected invalidResponse, got \(String(describing: missing))") }

        let pinnedOpener = StubOpener()
        let pinned = makeModelPass(opener: pinnedOpener, configuration: Fixtures.configuration(trustedIssuers: ["https://hub.example.com/"]))
        (task, params) = try await startAuthorization(pinned, opener: pinnedOpener)
        pinned.handleRedirect(Fixtures.redirect([("code", "c"), ("state", params["state"]), ("iss", "https://other.example.com")]))
        await assertThrows(.untrustedIssuer("https://other.example.com")) { try await task.value }

        (task, params) = try await startAuthorization(pinned, opener: pinnedOpener)
        pinned.handleRedirect(Fixtures.redirect([("code", "c"), ("state", params["state"]), ("iss", Fixtures.issuer)]))
        _ = try await task.value
        XCTAssertTrue(StubURLProtocol.requests.allSatisfy { $0.url.host == "hub.example.com" }) // never contacted other hubs
    }

    func testIssuerConfirmationHook() async throws {
        installHub()
        let opener = StubOpener()
        let modelPass = makeModelPass(opener: opener)
        var asked: [URL] = []
        modelPass.issuerConfirmation = { issuer in
            asked.append(issuer)
            return false
        }
        let (task, params) = try await startAuthorization(modelPass, opener: opener)
        modelPass.handleRedirect(Fixtures.redirect([("code", "c"), ("state", params["state"]), ("iss", Fixtures.issuer)]))
        await assertThrows(.untrustedIssuer("https://hub.example.com")) { try await task.value }
        XCTAssertEqual(asked.map(\.absoluteString), ["https://hub.example.com"])
        XCTAssertTrue(StubURLProtocol.requests.isEmpty)
    }

    func testTokenEndpointErrors() async throws {
        let opener = StubOpener()
        let modelPass = makeModelPass(opener: opener)

        installHub(token: .json(["error": "invalid_grant", "error_description": "code expired"], status: 400))
        var (task, params) = try await startAuthorization(modelPass, opener: opener)
        modelPass.handleRedirect(Fixtures.redirect([("code", "c"), ("state", params["state"]), ("iss", Fixtures.issuer)]))
        await assertThrows(.tokenExchangeFailed("invalid_grant", "code expired")) { try await task.value }

        installHub(token: .text("Bad Gateway", status: 502))
        (task, params) = try await startAuthorization(modelPass, opener: opener)
        modelPass.handleRedirect(Fixtures.redirect([("code", "c"), ("state", params["state"]), ("iss", Fixtures.issuer)]))
        await assertThrows(.tokenExchangeFailed("server_error", "HTTP 502")) { try await task.value }

        // An api_base on plain http on a public host would leak the bearer token.
        installHub(token: .json(Fixtures.tokenResponse(apiBase: "http://relay.example.com/v1")))
        (task, params) = try await startAuthorization(modelPass, opener: opener)
        modelPass.handleRedirect(Fixtures.redirect([("code", "c"), ("state", params["state"]), ("iss", Fixtures.issuer)]))
        let error = await thrownError { try await task.value }
        guard case .invalidResponse = error else { return XCTFail("expected invalidResponse, got \(String(describing: error))") }
        XCTAssertNil(modelPass.session)
    }

    func testWalletNotInstalled() async throws {
        let store = InMemorySessionStore()
        let opener = StubOpener()
        opener.canOpenResult = false
        let modelPass = makeModelPass(store: store, opener: opener)
        await assertThrows(.walletNotInstalled) { try await modelPass.authorize() }
        XCTAssertTrue(opener.opened.isEmpty)
        XCTAssertTrue(store.keys.isEmpty)
        XCTAssertFalse(modelPass.isWalletInstalled)

        // canOpenURL says yes (e.g. LSApplicationQueriesSchemes missing) but nothing handles the URL.
        opener.canOpenResult = true
        opener.openResult = false
        await assertThrows(.walletNotInstalled) { try await modelPass.authorize() }
        XCTAssertTrue(store.keys.isEmpty)
        XCTAssertFalse(modelPass.isAuthorizing)
    }

    func testCancellationAndSupersededRequests() async throws {
        let opener = StubOpener()
        let modelPass = makeModelPass(opener: opener)

        let first = Task { try await modelPass.authorize() }
        try await waitUntil { opener.opened.count == 1 }
        let second = Task { try await modelPass.authorize() }
        try await waitUntil { opener.opened.count == 2 }
        await assertThrows(.cancelled) { try await first.value }
        XCTAssertTrue(modelPass.isAuthorizing)

        second.cancel()
        await assertThrows(.cancelled) { try await second.value }
        XCTAssertFalse(modelPass.isAuthorizing)
    }

    func testRedirectAfterColdStartCompletesFromThePersistedRequest() async throws {
        installHub()
        let store = InMemorySessionStore()
        let opener = StubOpener()
        let original = makeModelPass(store: store, opener: opener)
        let (abandoned, params) = try await startAuthorization(original, opener: opener)

        // The app was terminated while the wallet was in the foreground; a fresh instance receives the redirect.
        let relaunched = makeModelPass(store: store)
        XCTAssertNil(relaunched.session)
        var results: [Result<ModelPassSession, Error>] = []
        relaunched.onAuthorizationResult = { results.append($0) }
        XCTAssertTrue(relaunched.handleRedirect(Fixtures.redirect([("code", "c"), ("state", params["state"]), ("iss", Fixtures.issuer)])))
        try await waitUntil { relaunched.session != nil }
        XCTAssertEqual(results.count, 1)
        XCTAssertEqual(try results.first?.get(), relaunched.session)
        XCTAssertEqual(store.keys, ["session"])

        abandoned.cancel()
        await assertThrows(.cancelled) { try await abandoned.value }
    }

    func testDuplicateRedirectDeliveryExchangesTheCodeOnce() async throws {
        installHub()
        let opener = StubOpener()
        let modelPass = makeModelPass(opener: opener)
        var results = 0
        modelPass.onAuthorizationResult = { _ in results += 1 }
        let (task, params) = try await startAuthorization(modelPass, opener: opener)
        let redirect = Fixtures.redirect([("code", "c"), ("state", params["state"]), ("iss", Fixtures.issuer)])
        XCTAssertTrue(modelPass.handleRedirect(redirect))
        XCTAssertTrue(modelPass.handleRedirect(redirect))
        let direct = try await modelPass.completeAuthorization(redirectURL: redirect)
        let session = try await task.value
        XCTAssertEqual(direct, session)
        XCTAssertEqual(StubURLProtocol.requests(path: "/oauth/token").count, 1)
        XCTAssertEqual(results, 1)
    }

    private static var didBecomeActive: Notification.Name {
        #if canImport(UIKit)
        return UIApplication.didBecomeActiveNotification
        #else
        return NSApplication.didBecomeActiveNotification
        #endif
    }

    func testReturningFromTheWalletWithoutARedirectEndsTheWait() async throws {
        installHub()
        let store = InMemorySessionStore()
        let opener = StubOpener()
        let modelPass = makeModelPass(store: store, opener: opener)
        modelPass.returnGracePeriod = 0.01
        var results = 0
        modelPass.onAuthorizationResult = { _ in results += 1 }
        let (task, params) = try await startAuthorization(modelPass, opener: opener)

        NotificationCenter.default.post(name: Self.didBecomeActive, object: nil) // user switched back manually
        await assertThrows(.cancelled) { try await task.value }
        XCTAssertFalse(modelPass.isAuthorizing)
        XCTAssertEqual(store.keys, ["pending_authorization"]) // still completable

        // The wallet redirects later after all: the session is still established.
        modelPass.handleRedirect(Fixtures.redirect([("code", "c"), ("state", params["state"]), ("iss", Fixtures.issuer)]))
        try await waitUntil { modelPass.session != nil }
        XCTAssertEqual(results, 1)
    }

    func testRedirectArrivingWithinTheGracePeriodWins() async throws {
        installHub()
        let opener = StubOpener()
        let modelPass = makeModelPass(opener: opener)
        modelPass.returnGracePeriod = 0.2
        let (task, params) = try await startAuthorization(modelPass, opener: opener)
        NotificationCenter.default.post(name: Self.didBecomeActive, object: nil)
        modelPass.handleRedirect(Fixtures.redirect([("code", "c"), ("state", params["state"]), ("iss", Fixtures.issuer)]))
        let session = try await task.value
        try await Task.sleep(nanoseconds: 300_000_000) // past the grace period: nothing is cancelled
        XCTAssertEqual(modelPass.session, session)
        XCTAssertFalse(modelPass.isAuthorizing)
    }

    func testExpiredPendingRequestIsRejected() async throws {
        installHub()
        let opener = StubOpener()
        let modelPass = makeModelPass(opener: opener)
        let (task, params) = try await startAuthorization(modelPass, opener: opener)
        modelPass.now = { Date().addingTimeInterval(PendingAuthorization.lifetime + 60) }
        modelPass.handleRedirect(Fixtures.redirect([("code", "c"), ("state", params["state"]), ("iss", Fixtures.issuer)]))
        await assertThrows(.invalidState) { try await task.value }
    }
}
