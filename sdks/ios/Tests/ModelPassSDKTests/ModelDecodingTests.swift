import XCTest
@testable import ModelPassSDK

/// Token response (§6.4), session persistence, chat/JSON model coding.
final class ModelDecodingTests: XCTestCase {
    private let tokenResponseJSON = #"""
    {
      "access_token": "mpk_3wq6oX8d",
      "token_type": "Bearer",
      "expires_in": 2592000,
      "scope": "chat tools",
      "grant_id": "g_9xKc2",
      "sub": "u2b1c",
      "issuer": "https://hub.example.com",
      "api_base": "https://hub.example.com/v1/",
      "api_formats": ["openai-chat-completions", "anthropic-messages"],
      "slots": [
        { "id": "default", "label": "默认" },
        { "id": "fast", "label": "快速", "model": "deepseek-flash", "provider": "DeepSeek" },
        { "id": "reasoning" }
      ],
      "unknown_future_field": { "ignored": true }
    }
    """#

    func testTokenResponseDecodesIntoASession() throws {
        let received = Date(timeIntervalSince1970: 1_700_000_000)
        let token = try TokenResponse.decode(Data(tokenResponseJSON.utf8))
        let session = try token.makeSession(issuer: URL(string: "https://hub.example.com")!, receivedAt: received)
        XCTAssertEqual(session.accessToken, "mpk_3wq6oX8d")
        XCTAssertEqual(session.tokenType, "Bearer")
        XCTAssertEqual(session.apiBase.absoluteString, "https://hub.example.com/v1") // trailing slash normalized
        XCTAssertEqual(session.grantId, "g_9xKc2")
        XCTAssertEqual(session.sub, "u2b1c")
        XCTAssertEqual(session.scopes, ["chat", "tools"])
        XCTAssertTrue(session.hasScope("tools"))
        XCTAssertFalse(session.hasScope("vision"))
        XCTAssertEqual(session.apiFormats, ["openai-chat-completions", "anthropic-messages"])
        XCTAssertEqual(session.expiresAt, received.addingTimeInterval(2_592_000))
        let fractional = try token.makeSession(issuer: URL(string: "https://hub.example.com")!, receivedAt: received.addingTimeInterval(0.75))
        XCTAssertEqual(fractional.expiresAt, received.addingTimeInterval(2_592_000)) // whole seconds
        XCTAssertEqual(session.slots, [
            ModelPassSlot(id: "default", label: "默认"),
            ModelPassSlot(id: "fast", label: "快速", model: "deepseek-flash", provider: "DeepSeek"),
            ModelPassSlot(id: "reasoning", label: "reasoning"),
        ])
    }

    func testMinimalAndInvalidTokenResponses() throws {
        let minimal = #"{"access_token":"mpk_x","grant_id":"g","api_base":"https://hub.example.com/v1"}"#
        let session = try TokenResponse.decode(Data(minimal.utf8)).makeSession(issuer: URL(string: "https://hub.example.com")!, receivedAt: Date())
        XCTAssertNil(session.expiresAt)
        XCTAssertEqual(session.slots.map(\.id), ["default"])
        XCTAssertEqual(session.tokenType, "Bearer")

        for invalid in [#"{"grant_id":"g","api_base":"https://h/v1"}"#, "<html>", #"{"access_token":"","grant_id":"g","api_base":"https://h/v1"}"#,
                        #"{"access_token":"t","grant_id":"g","api_base":"ftp://h/v1"}"#] {
            XCTAssertThrowsError(try TokenResponse.decode(Data(invalid.utf8)).makeSession(issuer: URL(string: "https://h")!, receivedAt: Date()), invalid) { error in
                guard case .invalidResponse = error as? ModelPassError else { return XCTFail("\(error)") }
            }
        }
    }

    func testSessionPersistenceRoundTripAndForwardCompatibility() throws {
        let store = InMemorySessionStore()
        var session = Fixtures.session
        session.expiresAt = Date(timeIntervalSince1970: 1_800_000_000)
        try store.saveValue(session, key: StoreKey.session)
        XCTAssertEqual(try store.loadValue(ModelPassSession.self, key: StoreKey.session), session)

        // Older / foreign payloads missing optional fields still decode.
        let legacy = #"{"accessToken":"mpk_a","issuer":"https://hub.example.com","apiBase":"https://hub.example.com/v1","grantId":"g_1"}"#
        try store.save(Data(legacy.utf8), key: StoreKey.session)
        let restored = try XCTUnwrap(try store.loadValue(ModelPassSession.self, key: StoreKey.session))
        XCTAssertEqual(restored.slots.map(\.id), ["default"])
        XCTAssertEqual(restored.scope, "chat")
    }

    @MainActor
    func testCorruptStoredSessionIsDiscarded() {
        let store = InMemorySessionStore()
        try? store.save(Data("garbage".utf8), key: StoreKey.session)
        let modelPass = ModelPass(configuration: Fixtures.configuration(), sessionStore: store)
        XCTAssertNil(modelPass.session)
        XCTAssertTrue(store.keys.isEmpty)
    }

    @MainActor
    func testReloadSession() throws {
        let store = InMemorySessionStore()
        let modelPass = ModelPass(configuration: Fixtures.configuration(), sessionStore: store)
        var changes: [ModelPassSession?] = []
        modelPass.onSessionChange = { changes.append($0) }
        try store.saveValue(Fixtures.session, key: StoreKey.session)
        modelPass.reloadSession()
        XCTAssertEqual(modelPass.session, Fixtures.session)
        modelPass.reloadSession()
        XCTAssertEqual(changes, [Fixtures.session])
    }

    func testPrintingASessionNeverRevealsTheToken() {
        let session = Fixtures.session
        XCTAssertFalse(String(describing: session).contains("mpk_session"))
        XCTAssertFalse(String(reflecting: session).contains("mpk_session"))
        var dumped = ""
        dump(session, to: &dumped)
        XCTAssertFalse(dumped.contains("mpk_session"))
        XCTAssertTrue(dumped.contains("g_123"))
        XCTAssertEqual(session.authorizationHeaderValue, "Bearer mpk_session")
    }

    func testChatCompletionDecoding() throws {
        let json = #"""
        {"id":"c","object":"chat.completion","created":1767225600,"model":"m",
         "choices":[{"index":0,"finish_reason":"tool_calls","message":{"role":"assistant","content":null,
           "reasoning_content":"thinking","tool_calls":[{"id":"call_1","type":"function","function":{"name":"f","arguments":"{\"a\":1}"}}]}}],
         "usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}
        """#
        let completion = try JSONDecoder().decode(ChatCompletion.self, from: Data(json.utf8))
        XCTAssertNil(completion.text)
        XCTAssertEqual(completion.message?.reasoningContent, "thinking")
        XCTAssertEqual(completion.message?.toolCalls, [ChatToolCall(id: "call_1", function: .init(name: "f", arguments: #"{"a":1}"#))])
        XCTAssertEqual(completion.finishReason, "tool_calls")
        XCTAssertEqual(completion.usage?.totalTokens, 15)

        let parts = #"{"choices":[{"message":{"role":"assistant","content":[{"type":"text","text":"a"},{"type":"text","text":"b"},{"type":"other","x":1}]}}]}"#
        let multi = try JSONDecoder().decode(ChatCompletion.self, from: Data(parts.utf8))
        XCTAssertEqual(multi.text, "ab")
        guard case .parts(let decoded)? = multi.message?.content else { return XCTFail("expected parts") }
        XCTAssertEqual(decoded.last, .other(["type": "other", "x": 1]))
    }

    func testReasoningIsNeverSentBack() throws {
        var message = ChatMessage.assistant("answer")
        message.reasoningContent = "secret thoughts"
        let json = String(decoding: try JSONEncoder().encode(message), as: UTF8.self)
        XCTAssertFalse(json.contains("secret thoughts"))
        XCTAssertEqual(try JSONDecoder().decode(ChatMessage.self, from: Data(json.utf8)), ChatMessage.assistant("answer"))
    }

    func testJSONValue() throws {
        let value: JSONValue = ["n": 1, "f": 1.5, "s": "x", "b": true, "z": nil, "a": [1, "two"]]
        let data = try JSONEncoder().encode(value)
        let text = String(decoding: data, as: UTF8.self)
        XCTAssertTrue(text.contains(#""n":1"#), text) // integers stay integral
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: data), value)
        XCTAssertEqual(value["a"]?[1]?.stringValue, "two")
        XCTAssertEqual(value["n"]?.intValue, 1)
        XCTAssertEqual(value["f"]?.doubleValue, 1.5)
        XCTAssertEqual(value["b"]?.boolValue, true)
        XCTAssertEqual(value["z"]?.isNull, true)
        XCTAssertNil(value["missing"])
    }

    func testRequiresReauthorization() {
        XCTAssertTrue(ModelPassError.notSignedIn.requiresReauthorization)
        XCTAssertTrue(ModelPassError.api(status: 401, code: "invalid_token", message: "").requiresReauthorization)
        XCTAssertFalse(ModelPassError.api(status: 403, code: "grant_paused", message: "").requiresReauthorization)
        XCTAssertFalse(ModelPassError.api(status: 401, code: nil, message: "").requiresReauthorization)
        XCTAssertFalse(ModelPassError.linkExpired.requiresReauthorization)
    }
}

final class KeychainSessionStoreTests: XCTestCase {
    /// Touches the real Keychain, so it only runs when `MODELPASS_KEYCHAIN_TESTS=1` is set.
    func testRoundTrip() throws {
        guard ProcessInfo.processInfo.environment["MODELPASS_KEYCHAIN_TESTS"] == "1" else {
            throw XCTSkip("Set MODELPASS_KEYCHAIN_TESTS=1 to exercise the real Keychain.")
        }
        let store = KeychainSessionStore(service: "dev.modelpass.sdk.tests.\(UUID().uuidString)")
        defer { try? store.remove(key: "k") }
        XCTAssertNil(try store.load(key: "k"))
        try store.save(Data("one".utf8), key: "k")
        XCTAssertEqual(try store.load(key: "k"), Data("one".utf8))
        try store.save(Data("two".utf8), key: "k") // update path
        XCTAssertEqual(try store.load(key: "k"), Data("two".utf8))
        try store.remove(key: "k")
        XCTAssertNil(try store.load(key: "k"))
        XCTAssertNoThrow(try store.remove(key: "k")) // idempotent
    }
}
