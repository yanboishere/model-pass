import Foundation

/// Splits a byte stream into lines terminated by LF, CRLF or CR, preserving empty lines (which delimit SSE events —
/// `URLSession.AsyncBytes.lines` drops them, so the SDK splits lines itself).
struct SSELineSplitter {
    private var buffer: [UInt8] = []
    private var lastWasCR = false

    /// Feeds one byte; returns a completed line (without its terminator), if any.
    mutating func push(_ byte: UInt8) -> String? {
        switch byte {
        case 0x0A: // \n
            if lastWasCR {
                lastWasCR = false
                return nil // second half of \r\n
            }
            return flush()
        case 0x0D: // \r
            lastWasCR = true
            return flush()
        default:
            lastWasCR = false
            buffer.append(byte)
            return nil
        }
    }

    /// The trailing line when the stream ended without a terminator.
    mutating func finish() -> String? {
        buffer.isEmpty ? nil : flush()
    }

    private mutating func flush() -> String {
        defer { buffer.removeAll(keepingCapacity: true) }
        return String(decoding: buffer, as: UTF8.self)
    }

    /// Convenience for tests.
    static func lines(of data: Data) -> [String] {
        var splitter = SSELineSplitter()
        var out: [String] = []
        for byte in data {
            if let line = splitter.push(byte) { out.append(line) }
        }
        if let line = splitter.finish() { out.append(line) }
        return out
    }
}

/// Minimal Server-Sent Events parser (WHATWG HTML "event stream interpretation") that keeps `data` fields only.
struct SSEParser {
    private var dataLines: [String] = []
    private var sawFirstLine = false

    /// Feeds one line; returns the event's data when the line (a blank line) completes an event.
    mutating func feed(_ rawLine: String) -> String? {
        var line = rawLine
        if !sawFirstLine {
            sawFirstLine = true
            if line.hasPrefix("\u{FEFF}") { line.removeFirst() }
        }
        if line.isEmpty { return dispatch() }
        if line.hasPrefix(":") { return nil } // comment / keep-alive
        let field: Substring
        var value: Substring
        if let colon = line.firstIndex(of: ":") {
            field = line[..<colon]
            value = line[line.index(after: colon)...]
            if value.hasPrefix(" ") { value = value.dropFirst() }
        } else {
            field = Substring(line)
            value = ""
        }
        if field == "data" { dataLines.append(String(value)) }
        return nil // `event`, `id`, `retry` are not used by chat completions
    }

    /// Flushes a final event that was not followed by a blank line.
    mutating func finish() -> String? { dispatch() }

    private mutating func dispatch() -> String? {
        guard !dataLines.isEmpty else { return nil }
        defer { dataLines.removeAll() }
        return dataLines.joined(separator: "\n")
    }
}

/// Turns `chat.completion.chunk` payloads into `ChatStreamEvent`s.
enum ChatStreamDecoder {
    struct Output: Equatable {
        var events: [ChatStreamEvent] = []
        var done = false
    }

    /// Decodes one SSE data payload. `[DONE]` ends the stream; unparseable payloads are ignored; an `error` object
    /// inside the stream is thrown as `ModelPassError.api`.
    static func decode(_ payload: String, status: Int = 200) throws -> Output {
        let trimmed = payload.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return Output() }
        if trimmed == "[DONE]" { return Output(done: true) }
        if let events = try decodeChunk(trimmed, status: status) { return Output(events: events) }
        // Lenient: servers that never emit blank lines end up with several JSON documents in one event.
        var output = Output()
        if trimmed.contains("\n") {
            for line in trimmed.split(separator: "\n") {
                let part = line.trimmingCharacters(in: .whitespaces)
                if part == "[DONE]" {
                    output.done = true
                    break
                }
                if let events = try decodeChunk(part, status: status) { output.events += events }
            }
        }
        return output
    }

    private struct Chunk: Decodable {
        struct Choice: Decodable {
            let index: Int?
            let delta: Delta?
            let finishReason: String?

            enum CodingKeys: String, CodingKey {
                case index, delta
                case finishReason = "finish_reason"
            }
        }

        struct Delta: Decodable {
            let content: String?
            let reasoningContent: String?
            let reasoning: String?
            let toolCalls: [ToolCall]?

            enum CodingKeys: String, CodingKey {
                case content
                case reasoningContent = "reasoning_content"
                case reasoning
                case toolCalls = "tool_calls"
            }
        }

        struct ToolCall: Decodable {
            struct Function: Decodable {
                let name: String?
                let arguments: String?
            }

            let index: Int?
            let id: String?
            let function: Function?
        }

        struct StreamError: Decodable {
            let message: String
            let code: String?

            enum CodingKeys: String, CodingKey { case message, code, type }

            init(from decoder: Decoder) throws {
                if let container = try? decoder.container(keyedBy: CodingKeys.self) {
                    message = (try? container.decode(String.self, forKey: .message)) ?? "stream error"
                    code = (try? container.decode(String.self, forKey: .code))
                        ?? (try? container.decode(Int.self, forKey: .code)).map(String.init)
                } else {
                    let text = try decoder.singleValueContainer().decode(String.self)
                    message = text
                    code = text
                }
            }
        }

        let choices: [Choice]?
        let usage: ChatUsage?
        let error: StreamError?
    }

    /// nil when `json` is not a decodable chunk.
    private static func decodeChunk(_ json: String, status: Int) throws -> [ChatStreamEvent]? {
        guard json.hasPrefix("{"), let chunk = try? JSONDecoder().decode(Chunk.self, from: Data(json.utf8)) else {
            return nil
        }
        if let error = chunk.error {
            throw ModelPassError.api(status: status, code: error.code, message: error.message)
        }
        var events: [ChatStreamEvent] = []
        // Only the first choice is surfaced (the helpers do not request n > 1).
        for choice in chunk.choices ?? [] where (choice.index ?? 0) == 0 {
            if let reasoning = choice.delta?.reasoningContent ?? choice.delta?.reasoning, !reasoning.isEmpty {
                events.append(.reasoning(reasoning))
            }
            if let content = choice.delta?.content, !content.isEmpty {
                events.append(.content(content))
            }
            for (offset, call) in (choice.delta?.toolCalls ?? []).enumerated() {
                events.append(.toolCall(ChatToolCallDelta(index: call.index ?? offset, id: call.id,
                                                          name: call.function?.name, arguments: call.function?.arguments)))
            }
            if let reason = choice.finishReason, !reason.isEmpty {
                events.append(.finish(reason: reason))
            }
        }
        if let usage = chunk.usage { events.append(.usage(usage)) }
        return events
    }

    /// Events equivalent to a non-streamed completion (used when a server ignores `stream: true`).
    static func events(for completion: ChatCompletion) -> [ChatStreamEvent] {
        var events: [ChatStreamEvent] = []
        if let reasoning = completion.message?.reasoningContent, !reasoning.isEmpty { events.append(.reasoning(reasoning)) }
        if let text = completion.text, !text.isEmpty { events.append(.content(text)) }
        for (index, call) in (completion.message?.toolCalls ?? []).enumerated() {
            events.append(.toolCall(ChatToolCallDelta(index: index, id: call.id, name: call.function.name, arguments: call.function.arguments)))
        }
        if let reason = completion.finishReason { events.append(.finish(reason: reason)) }
        if let usage = completion.usage { events.append(.usage(usage)) }
        return events
    }
}
