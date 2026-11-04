import XCTest
@testable import ModelPassSDK

/// Authorization URL building, redirect matching, query parsing and issuer validation rules.
@MainActor
final class URLRulesTests: XCTestCase {
    private func pending(state: String = "state123") -> PendingAuthorization {
        PendingAuthorization(
            state: state,
            codeVerifier: TestVectors.rfc7636CodeVerifier,
            redirectURI: Fixtures.redirectURI.absoluteString,
            clientId: "com.example.chat",
            scopes: ["chat", "tools"],
            slots: ["default", "fast"],
            createdAt: Date()
        )
    }

    // MARK: Authorization URL (§6.1)

    func testAuthorizationURLContainsAllParametersInOrder() {
        let modelPass = ModelPass(configuration: Fixtures.configuration(), sessionStore: InMemorySessionStore())
        let url = modelPass.authorizationURL(for: pending(), budgetHint: 200_000)
        XCTAssertEqual(url.absoluteString, "modelpass://authorize?response_type=code&client_id=com.example.chat"
            + "&redirect_uri=com.example.chat%3A%2Fmodelpass%2Fcallback&scope=chat%20tools&state=state123"
            + "&code_challenge=\(TestVectors.rfc7636CodeChallenge)&code_challenge_method=S256&slots=default%20fast"
            + "&client_name=Example%20Chat&budget_hint=200000")
    }

    func testOptionalParametersAreOmittedAndExistingQueriesKept() {
        var configuration = Fixtures.configuration(walletAuthorizeURL: URL(string: "exp://127.0.0.1:8081/--/authorize?x=1")!)
        configuration.clientName = nil
        let modelPass = ModelPass(configuration: configuration, sessionStore: InMemorySessionStore())
        let url = modelPass.authorizationURL(for: pending(), budgetHint: nil)
        XCTAssertTrue(url.absoluteString.hasPrefix("exp://127.0.0.1:8081/--/authorize?x=1&response_type=code&"), url.absoluteString)
        let params = QueryString.parameters(of: url)
        XCTAssertEqual(params["x"], "1")
        XCTAssertEqual(params["redirect_uri"], "com.example.chat:/modelpass/callback")
        XCTAssertEqual(params["scope"], "chat tools")
        XCTAssertNil(params["client_name"])
        XCTAssertNil(params["budget_hint"])
    }

    func testScopesAndSlotsAreNormalized() {
        XCTAssertEqual(ModelPass.normalizedList(["vision", "tools chat", "tools"], required: "chat"), ["chat", "vision", "tools"])
        XCTAssertEqual(ModelPass.normalizedList([], required: "default"), ["default"])
        XCTAssertEqual(ModelPass.normalizedList(["fast,reasoning", " "], required: "default"), ["default", "fast", "reasoning"])
    }

    // MARK: Query strings

    func testQueryParsingAndEncoding() {
        XCTAssertEqual(QueryString.parse("?a=1&b=x%20y&c=a+b&d&a=2&e=%E4%BD%A0%E5%A5%BD"),
                       ["a": "1", "b": "x y", "c": "a b", "d": "", "e": "你好"])
        XCTAssertEqual(QueryString.encode([("a", "x y+z/?&="), ("b", nil), ("c", ""), ("d", "~*'()!-_.")]),
                       "a=x%20y%2Bz%2F%3F%26%3D&d=~*'()!-_.")
        XCTAssertEqual(QueryString.append("q=1", to: "app://cb?x=1#frag"), "app://cb?x=1&q=1#frag")
        XCTAssertEqual(QueryString.append("q=1", to: "app://cb"), "app://cb?q=1")
        XCTAssertEqual(QueryString.append("q=1", to: "app://cb?"), "app://cb?q=1")
        let url = URL(string: "com.example.chat:/modelpass/callback?code=a%20b&state=s#ignored=1")!
        XCTAssertEqual(QueryString.parameters(of: url), ["code": "a b", "state": "s"])
    }

    // MARK: Redirect matching

    func testRedirectMatching() {
        let configured = Fixtures.redirectURI
        func matches(_ string: String, _ redirect: URL = configured) -> Bool {
            RedirectMatcher.matches(URL(string: string)!, redirectURI: redirect)
        }
        XCTAssertTrue(matches("com.example.chat:/modelpass/callback?code=1&state=2"))
        XCTAssertTrue(matches("COM.EXAMPLE.CHAT:/modelpass/callback/"))
        XCTAssertFalse(matches("com.example.chat:/modelpass/other?code=1"))
        XCTAssertFalse(matches("com.evil.chat:/modelpass/callback?code=1"))

        let custom = URL(string: "myapp://modelpass/callback")!
        XCTAssertTrue(matches("myapp://modelpass/callback?code=1", custom))
        XCTAssertFalse(matches("myapp://evil/callback?code=1", custom))

        let universal = URL(string: "https://example.com/mp/cb")!
        XCTAssertTrue(matches("https://EXAMPLE.com/mp/cb?code=1", universal))
        XCTAssertFalse(matches("https://example.com:8443/mp/cb?code=1", universal))
        XCTAssertFalse(matches("http://example.com/mp/cb?code=1", universal))
    }

    // MARK: Issuer rules (§3, §6.2, §13.2)

    func testAllowedIssuers() throws {
        for issuer in [
            "https://hub.example.com", "https://hub.example.com/", "https://hub.example.com/modelpass",
            "https://hub.example.com:8443", "http://localhost:8787", "http://127.0.0.1:8787", "http://10.0.0.2",
            "http://172.16.5.4", "http://172.31.255.255:80", "http://192.168.1.5:8787", "http://169.254.10.1",
            "http://my-mac.local:8787", "http://[::1]:8787", "http://[fd12:3456::1]:8787", "http://dev.localhost",
        ] {
            XCTAssertNoThrow(try IssuerPolicy.validateIssuer(issuer, trusted: nil), issuer)
        }
        XCTAssertEqual(try IssuerPolicy.validateIssuer("https://hub.example.com/", trusted: nil).absoluteString, "https://hub.example.com")
    }

    func testRejectedIssuers() {
        for issuer in [
            "http://hub.example.com", "http://172.32.0.1", "http://8.8.8.8", "http://192.169.1.1", "http://localhost.evil.com",
            "ftp://hub.example.com", "modelpass://authorize", "javascript:alert(1)", "https://user:pass@hub.example.com",
            "https://hub.example.com?x=1", "https://hub.example.com#fragment", "not a url", "", "https://",
        ] {
            XCTAssertThrowsError(try IssuerPolicy.validateIssuer(issuer, trusted: nil), issuer) { error in
                XCTAssertEqual(error as? ModelPassError, .untrustedIssuer(issuer))
            }
        }
    }

    func testTrustedIssuerAllowList() {
        let trusted = ["https://HUB.example.com/", "https://other.example.com:8443"]
        XCTAssertNoThrow(try IssuerPolicy.validateIssuer("https://hub.example.com", trusted: trusted))
        XCTAssertNoThrow(try IssuerPolicy.validateIssuer("https://hub.example.com:443/", trusted: trusted))
        XCTAssertNoThrow(try IssuerPolicy.validateIssuer("https://other.example.com:8443", trusted: trusted))
        XCTAssertThrowsError(try IssuerPolicy.validateIssuer("https://other.example.com", trusted: trusted))
        XCTAssertThrowsError(try IssuerPolicy.validateIssuer("https://hub.example.com/sub", trusted: trusted))
        XCTAssertThrowsError(try IssuerPolicy.validateIssuer("https://hub.example.com", trusted: []))
    }

    func testEndpointsKeepIssuerPathPrefix() {
        XCTAssertEqual(IssuerPolicy.endpoint(URL(string: "https://hub.example.com/")!, "/oauth/token").absoluteString,
                       "https://hub.example.com/oauth/token")
        XCTAssertEqual(IssuerPolicy.endpoint(URL(string: "https://example.com/modelpass")!, "/.well-known/modelpass-configuration").absoluteString,
                       "https://example.com/modelpass/.well-known/modelpass-configuration")
        XCTAssertEqual(IssuerPolicy.endpoint(URL(string: "https://hub.example.com/v1")!, "/chat/completions").absoluteString,
                       "https://hub.example.com/v1/chat/completions")
    }

    func testManageURL() {
        XCTAssertEqual(Fixtures.session.manageURL?.absoluteString, "modelpass://grants/g_123")
        let modelPass = ModelPass(configuration: Fixtures.configuration(), sessionStore: InMemorySessionStore(session: Fixtures.session))
        XCTAssertEqual(modelPass.manageURL?.absoluteString, "modelpass://grants/g_123")
    }
}
