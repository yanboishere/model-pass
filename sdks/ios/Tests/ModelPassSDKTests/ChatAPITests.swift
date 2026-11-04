import XCTest
@testable import ModelPassSDK

/// Chat helpers, SSE streaming, grant info, error mapping and revocation against a stubbed hub (§8, §9).
@MainActor
final class ChatAPITests: XCTestCase {
    private func signedIn(store: InMemorySessionStore = InMemorySessionStore(session: Fixtures.session)) -> ModelPass {
        ModelPass(configuration: Fixtures.configuration(), sessionStore: store, urlSession: StubURLProtocol.makeSession(), urlOpener: StubOpener())
    }

    private func collect(_ stream: AsyncThrowingStream<ChatStreamEvent, Error>) async throws -> [ChatStreamEvent] {
        var events: [ChatStreamEvent] = []
        for try await event in stream { events.append(event) }
        return events
    }

    // MARK: Non-streaming

    func testChatSendsBearerTokenAndDecodesTheCompletion() async throws {
        StubURLProtocol.reset { _ in
            .json([
                "id": "chatcmpl-1", "object": "chat.completion", "created": 1_767_225_600, "model": "deepseek-chat",
                "choices": [["index": 0, "message": ["role": "assistant", "content": "你好！"], "finish_reason": "stop"]],
                "usage": ["prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8],
            ], headers: ["x-modelpass-slot": "default", "x-modelpass-fallback": "true", "x-modelpass-budget-remaining": "1234",
                         "x-modelpass-provider": "DeepSeek%20%E6%B7%B1%E5%BA%A6%E6%B1%82%E7%B4%A2"])
        }
        let modelPass = signedIn()
        let completion = try await modelPass.chat([.system("简短回答"), .user("你好")], model: "gpt-4o-mini",
                                                   options: ChatOptions(temperature: 0.2, maxTokens: 64, extraBody: ["metadata": ["k": "v"]]))
        XCTAssertEqual(completion.text, "你好！")
        XCTAssertEqual(completion.finishReason, "stop")
        XCTAssertEqual(completion.model, "deepseek-chat")
        XCTAssertEqual(completion.created, Date(timeIntervalSince1970: 1_767_225_600))
        XCTAssertEqual(completion.usage, ChatUsage(promptTokens: 5, completionTokens: 3, totalTokens: 8))
        XCTAssertEqual(completion.routing, ModelPassRouting(slot: "default", fallback: true, provider: "DeepSeek 深度求索", budgetRemaining: 1234))

        let request = try XCTUnwrap(StubURLProtocol.requests.last)
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.url.absoluteString, "https://hub.example.com/v1/chat/completions")
        XCTAssertEqual(request.header("Authorization"), "Bearer mpk_session")
        XCTAssertEqual(request.header("Content-Type"), "application/json")
        let body = request.json
        XCTAssertEqual(body["model"] as? String, "gpt-4o-mini")
        XCTAssertEqual(body["temperature"] as? Double, 0.2)
        XCTAssertEqual(body["max_tokens"] as? Int, 64)
        XCTAssertEqual((body["metadata"] as? [String: String]) ?? [:], ["k": "v"])
        XCTAssertNil(body["stream"])
        let messages = try XCTUnwrap(body["messages"] as? [[String: Any]])
        XCTAssertEqual(messages.map { $0["role"] as? String }, ["system", "user"])
        XCTAssertEqual(messages[1]["content"] as? String, "你好")
    }

    func testRequestBodyEncodingOfToolsImagesAndOverrides() throws {
        let options = ChatOptions(
            temperature: 1,
            tools: [.function(name: "get_weather", description: "天气", parameters: ["type": "object", "properties": ["city": ["type": "string"]], "required": ["city"]])],
            toolChoice: "auto",
            extraBody: ["temperature": 0.5]
        )
        let messages: [ChatMessage] = [
            .user([.text("这是什么？"), .image(data: Data([1, 2, 3]), mimeType: "image/png", detail: "low")]),
            ChatMessage(role: .assistant, content: nil, toolCalls: [ChatToolCall(id: "call_1", function: .init(name: "get_weather", arguments: #"{"city":"北京"}"#))]),
            .tool(#"{"temp":20}"#, toolCallId: "call_1"),
        ]
        let data = try ChatRequestBody(model: "vision", messages: messages, options: options, stream: true).encoded()
        let body = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(body["stream"] as? Bool, true)
        XCTAssertEqual(body["stream_options"] as? [String: Bool], ["include_usage": true])
        XCTAssertEqual(body["temperature"] as? Double, 0.5) // extraBody wins
        XCTAssertEqual(body["tool_choice"] as? String, "auto")
        let tool = try XCTUnwrap((body["tools"] as? [[String: Any]])?.first)
        XCTAssertEqual(tool["type"] as? String, "function")
        XCTAssertEqual((tool["function"] as? [String: Any])?["name"] as? String, "get_weather")
        let sent = try XCTUnwrap(body["messages"] as? [[String: Any]])
        let parts = try XCTUnwrap(sent[0]["content"] as? [[String: Any]])
        XCTAssertEqual(parts[0]["type"] as? String, "text")
        XCTAssertEqual((parts[1]["image_url"] as? [String: String]) ?? [:], ["url": "data:image/png;base64,AQID", "detail": "low"])
        XCTAssertNil(sent[1]["content"])
        XCTAssertEqual(((sent[1]["tool_calls"] as? [[String: Any]])?.first?["function"] as? [String: String])?["name"], "get_weather")
        XCTAssertEqual(sent[2]["tool_call_id"] as? String, "call_1")
    }

    func testNotSignedIn() async throws {
        let modelPass = ModelPass(configuration: Fixtures.configuration(), sessionStore: InMemorySessionStore(), urlSession: StubURLProtocol.makeSession())
        await assertThrows(.notSignedIn) { try await modelPass.chat([.user("hi")]) }
        await assertThrows(.notSignedIn) { try await modelPass.grantInfo() }
        await assertThrows(.notSignedIn) { try await self.collect(modelPass.streamChat([.user("hi")])) }
    }

    // MARK: Errors (§8.7)

    func testSessionInvalidatingErrorsClearTheSession() async throws {
        for code in ["invalid_token", "grant_revoked", "grant_expired"] {
            StubURLProtocol.reset { _ in .json(["error": ["message": "nope", "type": "modelpass_error", "code": code]], status: 401) }
            let store = InMemorySessionStore(session: Fixtures.session)
            let modelPass = signedIn(store: store)
            var changes: [ModelPassSession?] = []
            modelPass.onSessionChange = { changes.append($0) }
            let error = await thrownError { try await modelPass.chat([.user("hi")]) }
            XCTAssertEqual(error, .api(status: 401, code: code, message: "nope"))
            XCTAssertEqual(error?.requiresReauthorization, true)
            XCTAssertNil(modelPass.session, code)
            XCTAssertTrue(store.keys.isEmpty, code)
            XCTAssertEqual(changes, [nil])
        }
    }

    func testOtherErrorsKeepTheSession() async throws {
        let cases: [(StubResponse, ModelPassError)] = [
            (.json(["error": ["message": "额度用尽", "type": "modelpass_error", "code": "budget_exceeded"]], status: 429),
             .api(status: 429, code: "budget_exceeded", message: "额度用尽")),
            (.json(["error": ["message": "paused", "type": "modelpass_error", "code": "grant_paused"]], status: 403),
             .api(status: 403, code: "grant_paused", message: "paused")),
            (.json(["error": ["message": "no route", "code": "no_route"]], status: 503),
             .api(status: 503, code: "no_route", message: "no route")),
            (.json(["error": "invalid_request", "error_description": "bad"], status: 400),
             .api(status: 400, code: "invalid_request", message: "bad")),
            (.text("upstream exploded", status: 502), .api(status: 502, code: nil, message: "upstream exploded")),
            (.json(["error": ["message": "who are you"]], status: 401), .api(status: 401, code: nil, message: "who are you")),
        ]
        for (response, expected) in cases {
            StubURLProtocol.reset { _ in response }
            let modelPass = signedIn()
            await assertThrows(expected) { try await modelPass.chat([.user("hi")]) }
            XCTAssertNotNil(modelPass.session)
            XCTAssertFalse(expected.requiresReauthorization)
        }
    }

    func testTransportErrorsAreWrapped() async throws {
        StubURLProtocol.reset { _ in throw URLError(.notConnectedToInternet) }
        let modelPass = signedIn()
        await assertThrows(.network(URLError(.notConnectedToInternet))) { try await modelPass.chat([.user("hi")]) }
        XCTAssertNotNil(modelPass.session)
    }

    func testErrorDescriptionsAreLocalized() {
        let all: [ModelPassError] = [
            .walletNotInstalled, .accessDenied("x"), .authorizationFailed(code: "server_error", description: nil), .invalidState,
            .untrustedIssuer("http://x"), .tokenExchangeFailed("invalid_grant", nil), .notSignedIn,
            .api(status: 429, code: "budget_exceeded", message: "m"), .api(status: 500, code: nil, message: "raw message"),
            .linkExpired, .linkDenied, .invalidResponse("d"), .network(URLError(.timedOut)), .cancelled,
        ]
        for error in all {
            XCTAssertFalse((error.errorDescription ?? "").isEmpty, "\(error)")
        }
        XCTAssertEqual(ModelPassError.api(status: 500, code: nil, message: "raw message").errorDescription, "raw message")
        XCTAssertEqual(ModelPassError.api(status: 401, code: "grant_revoked", message: "").code, "grant_revoked")
    }

    // MARK: Streaming

    func testStreamChatYieldsRoutingDeltasFinishAndUsage() async throws {
        let body = ": keep-alive\n\n"
            + #"data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}"# + "\n\n"
            + #"data: {"choices":[{"index":0,"delta":{"reasoning_content":"想一想"}}]}"# + "\r\n\r\n"
            + #"data: {"choices":[{"index":0,"delta":{"content":"你好"}}]}"# + "\n\n"
            + #"data:{"choices":[{"index":0,"delta":{"content":", world"}}],"usage":null}"# + "\n\n"
            + #"data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}"# + "\n\n"
            + #"data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}"# + "\n\n"
            + "data: [DONE]\n\n"
            + #"data: {"choices":[{"index":0,"delta":{"content":"ignored after DONE"}}]}"# + "\n\n"
        StubURLProtocol.reset { _ in .sse(body, chunkSize: 5, headers: ["x-modelpass-slot": "fast"]) }
        let modelPass = signedIn()
        let events = try await collect(modelPass.streamChat([.user("hi")], model: "fast"))
        XCTAssertEqual(events, [
            .routing(ModelPassRouting(slot: "fast")),
            .reasoning("想一想"),
            .content("你好"),
            .content(", world"),
            .finish(reason: "stop"),
            .usage(ChatUsage(promptTokens: 3, completionTokens: 2, totalTokens: 5)),
        ])
        let request = try XCTUnwrap(StubURLProtocol.requests.last)
        XCTAssertEqual(request.header("Accept"), "text/event-stream")
        XCTAssertEqual(request.header("Authorization"), "Bearer mpk_session")
        XCTAssertEqual(request.json["stream"] as? Bool, true)
        XCTAssertEqual(request.json["model"] as? String, "fast")
        XCTAssertEqual(request.json["stream_options"] as? [String: Bool], ["include_usage": true])
    }

    func testStreamToolCallDeltas() async throws {
        let body = #"data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]}}]}"# + "\n\n"
            + #"data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"city\":"}}]}}]}"# + "\n\n"
            + #"data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}"# + "\n\n"
            + "data: [DONE]\n\n"
        StubURLProtocol.reset { _ in .sse(body) }
        let events = try await collect(signedIn().streamChat([.user("weather?")], options: ChatOptions(includeUsage: false)))
        XCTAssertEqual(Array(events.dropFirst()), [
            .toolCall(ChatToolCallDelta(index: 0, id: "call_1", name: "get_weather", arguments: "")),
            .toolCall(ChatToolCallDelta(index: 0, arguments: #"{"city":"#)),
            .finish(reason: "tool_calls"),
        ])
        XCTAssertNil(StubURLProtocol.requests.last?.json["stream_options"])
    }

    func testStreamHTTPErrorClearsSessionOn401() async throws {
        StubURLProtocol.reset { _ in .json(["error": ["message": "revoked", "type": "modelpass_error", "code": "grant_revoked"]], status: 401) }
        let store = InMemorySessionStore(session: Fixtures.session)
        let modelPass = signedIn(store: store)
        await assertThrows(.api(status: 401, code: "grant_revoked", message: "revoked")) {
            try await self.collect(modelPass.streamChat([.user("hi")]))
        }
        XCTAssertNil(modelPass.session)
        XCTAssertTrue(store.keys.isEmpty)
    }

    func testStreamErrorEventMidStream() async throws {
        let body = #"data: {"choices":[{"index":0,"delta":{"content":"部分"}}]}"# + "\n\n"
            + #"data: {"error":{"message":"upstream failed","type":"modelpass_error","code":"upstream_error"}}"# + "\n\n"
        StubURLProtocol.reset { _ in .sse(body) }
        let modelPass = signedIn()
        var received: [ChatStreamEvent] = []
        do {
            for try await event in modelPass.streamChat([.user("hi")]) { received.append(event) }
            XCTFail("expected an error")
        } catch {
            XCTAssertEqual(error as? ModelPassError, .api(status: 200, code: "upstream_error", message: "upstream failed"))
        }
        XCTAssertEqual(received.last, .content("部分"))
        XCTAssertNotNil(modelPass.session)
    }

    func testStreamFallsBackToPlainJSONCompletion() async throws {
        StubURLProtocol.reset { _ in
            .json(["id": "x", "model": "m", "choices": [["index": 0, "message": ["role": "assistant", "content": "whole"], "finish_reason": "stop"]]])
        }
        let events = try await collect(signedIn().streamChat([.user("hi")]))
        XCTAssertEqual(Array(events.dropFirst()), [.content("whole"), .finish(reason: "stop")])
    }

    func testBreakingOutOfTheStreamCancelsTheRequest() async throws {
        let body = (0 ..< 50).map { #"data: {"choices":[{"index":0,"delta":{"content":"\#($0)"}}]}"# + "\n\n" }.joined()
        StubURLProtocol.reset { _ in .sse(body) }
        var count = 0
        for try await event in signedIn().streamChat([.user("hi")]) {
            if case .content = event { count += 1 }
            if count == 3 { break }
        }
        XCTAssertEqual(count, 3)
    }

    // MARK: Grant info & revocation

    func testGrantInfo() async throws {
        StubURLProtocol.reset { _ in
            .json([
                "grant_id": "g_123", "client_id": "com.example.chat", "scope": "chat tools", "status": "active",
                "slots": [["id": "default", "label": "默认", "model": "deepseek-flash", "provider": "DeepSeek"]],
                "budget": ["tokens_per_day": 200_000, "requests_per_day": NSNull(), "tokens_used_today": 5120, "requests_today": 7],
                "created_at": 1_767_225_600, "expires_at": NSNull(),
            ])
        }
        let info = try await signedIn().grantInfo()
        XCTAssertEqual(info.grantId, "g_123")
        XCTAssertTrue(info.isActive)
        XCTAssertEqual(info.slots, [ModelPassSlot(id: "default", label: "默认", model: "deepseek-flash", provider: "DeepSeek")])
        XCTAssertEqual(info.budget, ModelPassGrantInfo.Budget(tokensPerDay: 200_000, requestsPerDay: nil, tokensUsedToday: 5120, requestsToday: 7))
        XCTAssertEqual(info.budget?.tokensRemainingToday, 194_880)
        XCTAssertEqual(info.createdAt, Date(timeIntervalSince1970: 1_767_225_600))
        XCTAssertNil(info.expiresAt)
        let request = try XCTUnwrap(StubURLProtocol.requests.last)
        XCTAssertEqual(request.method, "GET")
        XCTAssertEqual(request.url.absoluteString, "https://hub.example.com/v1/modelpass/grant")
        XCTAssertEqual(request.header("Authorization"), "Bearer mpk_session")
    }

    func testSignOutRevokesAndClears() async throws {
        StubURLProtocol.reset { _ in .json([:]) }
        let store = InMemorySessionStore(session: Fixtures.session)
        let modelPass = signedIn(store: store)
        var changes: [ModelPassSession?] = []
        modelPass.onSessionChange = { changes.append($0) }
        await modelPass.signOut()
        XCTAssertNil(modelPass.session)
        XCTAssertNil(modelPass.manageURL)
        XCTAssertTrue(store.keys.isEmpty)
        XCTAssertEqual(changes, [nil])
        let request = try XCTUnwrap(StubURLProtocol.requests.last)
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.url.absoluteString, "https://hub.example.com/oauth/revoke")
        XCTAssertEqual(request.header("Content-Type"), "application/x-www-form-urlencoded")
        XCTAssertEqual(request.form, ["token": "mpk_session"])
    }

    func testSignOutWithoutRevocationOrWhileOffline() async throws {
        StubURLProtocol.reset { _ in .json([:]) }
        let modelPass = signedIn()
        await modelPass.signOut(revoke: false)
        XCTAssertNil(modelPass.session)
        XCTAssertTrue(StubURLProtocol.requests.isEmpty)

        StubURLProtocol.reset { _ in throw URLError(.notConnectedToInternet) }
        let offline = signedIn()
        await offline.signOut()
        XCTAssertNil(offline.session)
        XCTAssertEqual(StubURLProtocol.requests.count, 1)
    }
}
