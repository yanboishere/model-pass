import Foundation

// OpenAI Chat Completions compatible types (protocol §8.3). Only what the helpers need; for the full API surface
// use any OpenAI-compatible client with `baseURL = session.apiBase` and `apiKey = session.accessToken`.

/// `system`, `developer`, `user`, `assistant`, `tool` (or any other string).
public struct ChatRole: RawRepresentable, Hashable, Codable, Sendable, ExpressibleByStringLiteral, CustomStringConvertible {
    public let rawValue: String

    public init(rawValue: String) { self.rawValue = rawValue }
    public init(stringLiteral value: String) { rawValue = value }

    public static let system: ChatRole = "system"
    public static let developer: ChatRole = "developer"
    public static let user: ChatRole = "user"
    public static let assistant: ChatRole = "assistant"
    public static let tool: ChatRole = "tool"

    public var description: String { rawValue }

    public init(from decoder: Decoder) throws {
        rawValue = try decoder.singleValueContainer().decode(String.self)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

/// One part of a multimodal message (`vision` scope required for images).
public enum ChatContentPart: Hashable, Sendable, Codable {
    case text(String)
    /// An `https:` or `data:` URL; `detail` is `low`, `high` or `auto`.
    case imageURL(String, detail: String? = nil)
    /// Any other part type, passed through unchanged.
    case other(JSONValue)

    /// An inline image as a `data:` URL.
    public static func image(data: Data, mimeType: String = "image/jpeg", detail: String? = nil) -> ChatContentPart {
        .imageURL("data:\(mimeType);base64,\(data.base64EncodedString())", detail: detail)
    }

    public init(from decoder: Decoder) throws {
        let value = try JSONValue(from: decoder)
        switch value["type"]?.stringValue {
        case "text":
            if let text = value["text"]?.stringValue {
                self = .text(text)
                return
            }
        case "image_url":
            if let url = value["image_url"]?["url"]?.stringValue ?? value["image_url"]?.stringValue {
                self = .imageURL(url, detail: value["image_url"]?["detail"]?.stringValue)
                return
            }
        default:
            break
        }
        self = .other(value)
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .text(let text):
            try JSONValue.object(["type": "text", "text": .string(text)]).encode(to: encoder)
        case .imageURL(let url, let detail):
            var image: [String: JSONValue] = ["url": .string(url)]
            if let detail { image["detail"] = .string(detail) }
            try JSONValue.object(["type": "image_url", "image_url": .object(image)]).encode(to: encoder)
        case .other(let value):
            try value.encode(to: encoder)
        }
    }
}

/// Message content: a plain string or an array of parts.
public enum ChatContent: Hashable, Sendable, Codable, ExpressibleByStringLiteral {
    case text(String)
    case parts([ChatContentPart])

    public init(stringLiteral value: String) { self = .text(value) }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let text = try? container.decode(String.self) {
            self = .text(text)
        } else {
            self = .parts(try container.decode([ChatContentPart].self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .text(let text): try container.encode(text)
        case .parts(let parts): try container.encode(parts)
        }
    }

    /// The concatenated text parts.
    public var text: String {
        switch self {
        case .text(let text):
            return text
        case .parts(let parts):
            return parts.compactMap { part -> String? in
                if case .text(let text) = part { return text }
                return nil
            }.joined()
        }
    }
}

/// A tool call requested by the model (`tools` scope).
public struct ChatToolCall: Codable, Hashable, Sendable {
    public struct Function: Codable, Hashable, Sendable {
        public var name: String
        /// JSON-encoded arguments, exactly as produced by the model.
        public var arguments: String

        public init(name: String, arguments: String) {
            self.name = name
            self.arguments = arguments
        }

        private enum CodingKeys: String, CodingKey { case name, arguments }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            name = try container.decodeIfPresent(String.self, forKey: .name) ?? ""
            arguments = try container.decodeIfPresent(String.self, forKey: .arguments) ?? ""
        }
    }

    public var id: String
    public var type: String
    public var function: Function

    public init(id: String, type: String = "function", function: Function) {
        self.id = id
        self.type = type
        self.function = function
    }

    private enum CodingKeys: String, CodingKey { case id, type, function }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decodeIfPresent(String.self, forKey: .id) ?? ""
        type = try container.decodeIfPresent(String.self, forKey: .type) ?? "function"
        function = try container.decode(Function.self, forKey: .function)
    }
}

/// A chat message (request or response).
public struct ChatMessage: Codable, Hashable, Sendable {
    public var role: ChatRole
    public var content: ChatContent?
    public var name: String?
    public var toolCalls: [ChatToolCall]?
    public var toolCallId: String?
    /// Reasoning returned by some models (`reasoning_content` / `reasoning`). Output only; never sent back.
    public var reasoningContent: String?

    public init(role: ChatRole, content: ChatContent?, name: String? = nil, toolCalls: [ChatToolCall]? = nil,
                toolCallId: String? = nil) {
        self.role = role
        self.content = content
        self.name = name
        self.toolCalls = toolCalls
        self.toolCallId = toolCallId
    }

    public static func system(_ text: String) -> ChatMessage { ChatMessage(role: .system, content: .text(text)) }
    public static func user(_ text: String) -> ChatMessage { ChatMessage(role: .user, content: .text(text)) }
    public static func user(_ parts: [ChatContentPart]) -> ChatMessage { ChatMessage(role: .user, content: .parts(parts)) }
    public static func assistant(_ text: String) -> ChatMessage { ChatMessage(role: .assistant, content: .text(text)) }
    public static func tool(_ text: String, toolCallId: String) -> ChatMessage {
        ChatMessage(role: .tool, content: .text(text), toolCallId: toolCallId)
    }

    /// The message text (text parts joined), if any.
    public var text: String? { content?.text }

    private enum CodingKeys: String, CodingKey {
        case role, content, name
        case toolCalls = "tool_calls"
        case toolCallId = "tool_call_id"
        case reasoningContent = "reasoning_content"
        case reasoning
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        role = (try? container.decode(ChatRole.self, forKey: .role)) ?? .assistant
        content = try container.decodeIfPresent(ChatContent.self, forKey: .content)
        name = try container.decodeIfPresent(String.self, forKey: .name)
        toolCalls = try container.decodeIfPresent([ChatToolCall].self, forKey: .toolCalls)
        toolCallId = try container.decodeIfPresent(String.self, forKey: .toolCallId)
        reasoningContent = (try? container.decodeIfPresent(String.self, forKey: .reasoningContent))
            ?? (try? container.decodeIfPresent(String.self, forKey: .reasoning))
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(role, forKey: .role)
        try container.encodeIfPresent(content, forKey: .content)
        try container.encodeIfPresent(name, forKey: .name)
        if let toolCalls, !toolCalls.isEmpty { try container.encode(toolCalls, forKey: .toolCalls) }
        try container.encodeIfPresent(toolCallId, forKey: .toolCallId)
    }
}

/// A function the model may call (`tools` scope).
public struct ChatTool: Codable, Hashable, Sendable {
    public struct Function: Codable, Hashable, Sendable {
        public var name: String
        public var description: String?
        /// JSON Schema of the arguments.
        public var parameters: JSONValue?
        public var strict: Bool?

        public init(name: String, description: String? = nil, parameters: JSONValue? = nil, strict: Bool? = nil) {
            self.name = name
            self.description = description
            self.parameters = parameters
            self.strict = strict
        }
    }

    public var type: String
    public var function: Function

    public init(type: String = "function", function: Function) {
        self.type = type
        self.function = function
    }

    public static func function(name: String, description: String? = nil, parameters: JSONValue? = nil, strict: Bool? = nil) -> ChatTool {
        ChatTool(function: Function(name: name, description: description, parameters: parameters, strict: strict))
    }
}

/// Token usage of a request.
public struct ChatUsage: Codable, Hashable, Sendable {
    public var promptTokens: Int
    public var completionTokens: Int
    public var totalTokens: Int

    public init(promptTokens: Int, completionTokens: Int, totalTokens: Int? = nil) {
        self.promptTokens = promptTokens
        self.completionTokens = completionTokens
        self.totalTokens = totalTokens ?? promptTokens + completionTokens
    }

    private enum CodingKeys: String, CodingKey {
        case promptTokens = "prompt_tokens"
        case completionTokens = "completion_tokens"
        case totalTokens = "total_tokens"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        promptTokens = try container.decodeIfPresent(Int.self, forKey: .promptTokens) ?? 0
        completionTokens = try container.decodeIfPresent(Int.self, forKey: .completionTokens) ?? 0
        totalTokens = try container.decodeIfPresent(Int.self, forKey: .totalTokens) ?? promptTokens + completionTokens
    }
}

/// Routing information from the hub's response headers (§8.5).
public struct ModelPassRouting: Hashable, Sendable {
    /// `x-modelpass-slot`: the slot that served the request.
    public var slot: String?
    /// `x-modelpass-fallback: true`: the requested model was unknown and `default` was used.
    public var fallback: Bool
    /// `x-modelpass-model` (only when the user shares model info).
    public var model: String?
    /// `x-modelpass-provider` (only when the user shares model info).
    public var provider: String?
    /// `x-modelpass-budget-remaining`: tokens left today, when a budget is set.
    public var budgetRemaining: Int?

    public init(slot: String? = nil, fallback: Bool = false, model: String? = nil, provider: String? = nil, budgetRemaining: Int? = nil) {
        self.slot = slot
        self.fallback = fallback
        self.model = model
        self.provider = provider
        self.budgetRemaining = budgetRemaining
    }

    init(response: HTTPURLResponse) {
        func header(_ name: String) -> String? {
            response.value(forHTTPHeaderField: name)?.trimmingCharacters(in: .whitespaces)
        }
        self.init(
            slot: header("x-modelpass-slot"),
            fallback: header("x-modelpass-fallback")?.lowercased() == "true",
            model: header("x-modelpass-model"),
            // Percent-encoded UTF-8 (header values must be ASCII; provider names may be CJK).
            provider: header("x-modelpass-provider").map { $0.removingPercentEncoding ?? $0 },
            budgetRemaining: header("x-modelpass-budget-remaining").flatMap { Int($0) }
        )
    }
}

/// A (non-streaming) chat completion.
public struct ChatCompletion: Decodable, Hashable, Sendable {
    public struct Choice: Decodable, Hashable, Sendable {
        public var index: Int
        public var message: ChatMessage
        public var finishReason: String?

        private enum CodingKeys: String, CodingKey {
            case index, message
            case finishReason = "finish_reason"
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            index = try container.decodeIfPresent(Int.self, forKey: .index) ?? 0
            message = try container.decode(ChatMessage.self, forKey: .message)
            finishReason = try container.decodeIfPresent(String.self, forKey: .finishReason)
        }
    }

    public var id: String
    public var model: String
    public var created: Date?
    public var choices: [Choice]
    public var usage: ChatUsage?
    /// From the `x-modelpass-*` response headers.
    public internal(set) var routing = ModelPassRouting()

    /// The first choice's message.
    public var message: ChatMessage? { choices.first?.message }
    /// The first choice's text.
    public var text: String? { message?.text }
    public var finishReason: String? { choices.first?.finishReason }

    private enum CodingKeys: String, CodingKey { case id, model, created, choices, usage }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decodeIfPresent(String.self, forKey: .id) ?? ""
        model = try container.decodeIfPresent(String.self, forKey: .model) ?? ""
        created = try container.decodeIfPresent(Double.self, forKey: .created).map(Date.init(timeIntervalSince1970:))
        choices = try container.decodeIfPresent([Choice].self, forKey: .choices) ?? []
        usage = try container.decodeIfPresent(ChatUsage.self, forKey: .usage)
    }
}

/// An incremental tool call fragment in a stream. Concatenate `arguments` per `index`.
public struct ChatToolCallDelta: Hashable, Sendable {
    public var index: Int
    public var id: String?
    public var name: String?
    public var arguments: String?

    public init(index: Int, id: String? = nil, name: String? = nil, arguments: String? = nil) {
        self.index = index
        self.id = id
        self.name = name
        self.arguments = arguments
    }
}

/// Events yielded by `ModelPass.streamChat`.
public enum ChatStreamEvent: Hashable, Sendable {
    /// Routing information from the response headers (always the first event).
    case routing(ModelPassRouting)
    /// A content delta.
    case content(String)
    /// A reasoning delta (`reasoning_content` / `reasoning`), when the model exposes it.
    case reasoning(String)
    /// A tool call fragment.
    case toolCall(ChatToolCallDelta)
    /// `finish_reason`: `stop`, `length`, `tool_calls`, `content_filter`, …
    case finish(reason: String)
    /// Token usage (sent at the end of the stream when `ChatOptions.includeUsage` is true).
    case usage(ChatUsage)
}

/// Optional chat parameters.
public struct ChatOptions: Sendable {
    public var temperature: Double?
    public var topP: Double?
    public var maxTokens: Int?
    public var stop: [String]?
    public var presencePenalty: Double?
    public var frequencyPenalty: Double?
    public var seed: Int?
    /// Requires the `tools` scope.
    public var tools: [ChatTool]?
    /// `"auto"`, `"none"`, `"required"` or `{"type":"function","function":{"name":…}}`.
    public var toolChoice: JSONValue?
    /// e.g. `["type": "json_object"]`.
    public var responseFormat: JSONValue?
    public var user: String?
    /// Streaming only: ask for a final usage chunk (`stream_options.include_usage`).
    public var includeUsage: Bool
    /// Extra top-level body fields; they override the fields above.
    public var extraBody: [String: JSONValue]
    /// Extra HTTP headers.
    public var extraHeaders: [String: String]
    /// Idle timeout of the request. Defaults to 600 s (non-streaming) / 300 s (streaming).
    public var timeout: TimeInterval?

    public init(
        temperature: Double? = nil,
        topP: Double? = nil,
        maxTokens: Int? = nil,
        stop: [String]? = nil,
        presencePenalty: Double? = nil,
        frequencyPenalty: Double? = nil,
        seed: Int? = nil,
        tools: [ChatTool]? = nil,
        toolChoice: JSONValue? = nil,
        responseFormat: JSONValue? = nil,
        user: String? = nil,
        includeUsage: Bool = true,
        extraBody: [String: JSONValue] = [:],
        extraHeaders: [String: String] = [:],
        timeout: TimeInterval? = nil
    ) {
        self.temperature = temperature
        self.topP = topP
        self.maxTokens = maxTokens
        self.stop = stop
        self.presencePenalty = presencePenalty
        self.frequencyPenalty = frequencyPenalty
        self.seed = seed
        self.tools = tools
        self.toolChoice = toolChoice
        self.responseFormat = responseFormat
        self.user = user
        self.includeUsage = includeUsage
        self.extraBody = extraBody
        self.extraHeaders = extraHeaders
        self.timeout = timeout
    }
}
