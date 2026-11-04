import XCTest
@testable import ModelPassSDK

final class SSEParserTests: XCTestCase {
    func testLineSplitterHandlesLFCRLFAndCRAndKeepsEmptyLines() {
        XCTAssertEqual(SSELineSplitter.lines(of: Data("a\nb\r\nc\rd\n\ne".utf8)), ["a", "b", "c", "d", "", "e"])
        XCTAssertEqual(SSELineSplitter.lines(of: Data("x\r\n\r\n".utf8)), ["x", ""])
        XCTAssertEqual(SSELineSplitter.lines(of: Data("你好\n".utf8)), ["你好"])
    }

    func testLineSplitterCRLFAcrossChunkBoundary() {
        var splitter = SSELineSplitter()
        var lines: [String] = []
        for byte in Data("a\r".utf8) { if let line = splitter.push(byte) { lines.append(line) } }
        for byte in Data("\nb\n".utf8) { if let line = splitter.push(byte) { lines.append(line) } }
        XCTAssertEqual(lines, ["a", "b"])
        XCTAssertNil(splitter.finish())
    }

    func testParserFieldsCommentsAndDispatch() {
        var parser = SSEParser()
        XCTAssertNil(parser.feed("\u{FEFF}: comment"))
        XCTAssertNil(parser.feed("event: message"))
        XCTAssertNil(parser.feed("id: 1"))
        XCTAssertNil(parser.feed("data:first"))
        XCTAssertNil(parser.feed("data:  second"))
        XCTAssertNil(parser.feed("retry: 1000"))
        XCTAssertEqual(parser.feed(""), "first\n second") // one leading space removed, lines joined with \n
        XCTAssertNil(parser.feed("")) // no data → no event
        XCTAssertNil(parser.feed("data"))
        XCTAssertEqual(parser.feed(""), "")
        XCTAssertNil(parser.feed("data: tail"))
        XCTAssertEqual(parser.finish(), "tail")
        XCTAssertNil(parser.finish())
    }

    func testDecoderEventsDoneAndErrors() throws {
        XCTAssertEqual(try ChatStreamDecoder.decode("[DONE]"), .init(events: [], done: true))
        XCTAssertEqual(try ChatStreamDecoder.decode(" [DONE] \n"), .init(events: [], done: true))
        XCTAssertEqual(try ChatStreamDecoder.decode("not json"), .init()) // ignored
        XCTAssertEqual(try ChatStreamDecoder.decode(#"{"choices":[{"index":1,"delta":{"content":"second choice"}}]}"#), .init())

        let chunk = #"{"choices":[{"index":0,"delta":{"reasoning":"r","content":"c","tool_calls":[{"index":2,"id":"t","function":{"name":"f","arguments":"{}"}}]},"finish_reason":"length"}],"usage":{"prompt_tokens":1,"completion_tokens":2}}"#
        XCTAssertEqual(try ChatStreamDecoder.decode(chunk).events, [
            .reasoning("r"),
            .content("c"),
            .toolCall(ChatToolCallDelta(index: 2, id: "t", name: "f", arguments: "{}")),
            .finish(reason: "length"),
            .usage(ChatUsage(promptTokens: 1, completionTokens: 2, totalTokens: 3)),
        ])

        // Lenient mode: several JSON documents in one event (a server that never sends blank lines).
        let joined = #"{"choices":[{"delta":{"content":"a"}}]}"# + "\n" + #"{"choices":[{"delta":{"content":"b"}}]}"# + "\n[DONE]"
        XCTAssertEqual(try ChatStreamDecoder.decode(joined), .init(events: [.content("a"), .content("b")], done: true))

        XCTAssertThrowsError(try ChatStreamDecoder.decode(#"{"error":{"message":"boom","code":"upstream_error"}}"#, status: 200)) { error in
            XCTAssertEqual(error as? ModelPassError, .api(status: 200, code: "upstream_error", message: "boom"))
        }
        XCTAssertThrowsError(try ChatStreamDecoder.decode(#"{"error":"overloaded"}"#)) { error in
            XCTAssertEqual(error as? ModelPassError, .api(status: 200, code: "overloaded", message: "overloaded"))
        }
    }
}
