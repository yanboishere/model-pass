import Foundation

/// Performs authenticated calls against `api_base` with a snapshot of the session. Runs off the main actor.
struct ModelPassAPIClient: Sendable {
    let session: ModelPassSession
    let urlSession: URLSession

    func makeRequest(_ path: String, method: String = "GET", body: Data? = nil, timeout: TimeInterval = 60,
                     accept: String = "application/json", headers: [String: String] = [:]) -> URLRequest {
        var request = URLRequest(url: IssuerPolicy.endpoint(session.apiBase, path),
                                 cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        request.httpMethod = method
        request.setValue(session.authorizationHeaderValue, forHTTPHeaderField: "Authorization")
        request.setValue(accept, forHTTPHeaderField: "Accept")
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        return request
    }

    func grantInfo() async throws -> ModelPassGrantInfo {
        let (data, response) = try await HTTPClient(urlSession: urlSession).send(makeRequest(ModelPassProtocol.grantInfoPath, timeout: 30))
        guard (200..<300).contains(response.statusCode) else {
            throw HTTPClient.apiError(status: response.statusCode, data: data)
        }
        do {
            return try JSONDecoder().decode(ModelPassGrantInfo.self, from: data)
        } catch {
            throw ModelPassError.invalidResponse("malformed grant info")
        }
    }

    func chat(_ messages: [ChatMessage], model: String, options: ChatOptions) async throws -> ChatCompletion {
        let body = try ChatRequestBody(model: model, messages: messages, options: options, stream: false).encoded()
        let request = makeRequest(ModelPassProtocol.chatCompletionsPath, method: "POST", body: body,
                                  timeout: options.timeout ?? 600, headers: options.extraHeaders)
        let (data, response) = try await HTTPClient(urlSession: urlSession).send(request)
        guard (200..<300).contains(response.statusCode) else {
            throw HTTPClient.apiError(status: response.statusCode, data: data)
        }
        var completion: ChatCompletion
        do {
            completion = try JSONDecoder().decode(ChatCompletion.self, from: data)
        } catch {
            throw ModelPassError.invalidResponse("malformed chat completion")
        }
        completion.routing = ModelPassRouting(response: response)
        return completion
    }

    /// - Parameter onError: Invoked (before the stream finishes) with every error, e.g. to clear the session on 401.
    func streamChat(_ messages: [ChatMessage], model: String, options: ChatOptions,
                    onError: @escaping @Sendable (Error) async -> Void) -> AsyncThrowingStream<ChatStreamEvent, Error> {
        let request: URLRequest
        do {
            let body = try ChatRequestBody(model: model, messages: messages, options: options, stream: true).encoded()
            request = makeRequest(ModelPassProtocol.chatCompletionsPath, method: "POST", body: body,
                                  timeout: options.timeout ?? 300, accept: "text/event-stream", headers: options.extraHeaders)
        } catch {
            return AsyncThrowingStream { $0.finish(throwing: error) }
        }
        let urlSession = self.urlSession
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    try await Self.runStream(request, urlSession: urlSession, continuation: continuation)
                    continuation.finish()
                } catch {
                    let mapped = HTTPClient.mapTransportError(error)
                    await onError(mapped)
                    continuation.finish(throwing: mapped)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private static func runStream(_ request: URLRequest, urlSession: URLSession,
                                  continuation: AsyncThrowingStream<ChatStreamEvent, Error>.Continuation) async throws {
        let (bytes, response) = try await urlSession.bytes(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw ModelPassError.invalidResponse("not an HTTP response")
        }
        guard (200..<300).contains(http.statusCode) else {
            var body = Data()
            for try await byte in bytes {
                body.append(byte)
                if body.count >= 64 * 1024 { break }
            }
            throw HTTPClient.apiError(status: http.statusCode, data: body)
        }
        continuation.yield(.routing(ModelPassRouting(response: http)))

        // A server that ignored `stream: true` answers with a plain completion.
        if (http.value(forHTTPHeaderField: "Content-Type") ?? "").lowercased().contains("application/json") {
            var body = Data()
            for try await byte in bytes { body.append(byte) }
            let completion: ChatCompletion
            do {
                completion = try JSONDecoder().decode(ChatCompletion.self, from: body)
            } catch {
                throw HTTPClient.apiError(status: http.statusCode, data: body)
            }
            for event in ChatStreamDecoder.events(for: completion) { continuation.yield(event) }
            return
        }

        var lines = SSELineSplitter()
        var parser = SSEParser()
        func dispatch(_ payload: String?) throws -> Bool {
            guard let payload else { return false }
            let output = try ChatStreamDecoder.decode(payload, status: http.statusCode)
            for event in output.events { continuation.yield(event) }
            return output.done
        }
        for try await byte in bytes {
            guard let line = lines.push(byte) else { continue }
            if try dispatch(parser.feed(line)) { return }
        }
        if let line = lines.finish(), try dispatch(parser.feed(line)) { return }
        _ = try dispatch(parser.finish())
    }
}

/// The `POST /chat/completions` body.
struct ChatRequestBody: Encodable {
    let model: String
    let messages: [ChatMessage]
    let options: ChatOptions
    let stream: Bool

    func encoded() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        return try encoder.encode(self)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: AnyCodingKey.self)
        let extra = options.extraBody
        func put<T: Encodable>(_ value: T?, _ key: String) throws {
            guard let value, extra[key] == nil else { return }
            try container.encode(value, forKey: AnyCodingKey(key))
        }
        try put(model, "model")
        try put(messages, "messages")
        if stream {
            try put(true, "stream")
            if options.includeUsage { try put(["include_usage": true], "stream_options") }
        }
        try put(options.temperature, "temperature")
        try put(options.topP, "top_p")
        try put(options.maxTokens, "max_tokens")
        try put(options.stop, "stop")
        try put(options.presencePenalty, "presence_penalty")
        try put(options.frequencyPenalty, "frequency_penalty")
        try put(options.seed, "seed")
        try put(options.tools, "tools")
        try put(options.toolChoice, "tool_choice")
        try put(options.responseFormat, "response_format")
        try put(options.user, "user")
        for (key, value) in extra.sorted(by: { $0.key < $1.key }) {
            try container.encode(value, forKey: AnyCodingKey(key))
        }
    }
}

struct AnyCodingKey: CodingKey {
    let stringValue: String
    let intValue: Int? = nil

    init(_ string: String) { stringValue = string }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
}
