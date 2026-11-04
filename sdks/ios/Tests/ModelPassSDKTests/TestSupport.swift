import Foundation
import XCTest
@testable import ModelPassSDK

/// A lock-protected mutable value that can be captured by `@Sendable` closures.
final class Locked<Value>: @unchecked Sendable {
    private var value: Value
    private let lock = NSLock()

    init(_ value: Value) { self.value = value }

    var current: Value {
        lock.lock()
        defer { lock.unlock() }
        return value
    }

    func set(_ newValue: Value) {
        lock.lock()
        defer { lock.unlock() }
        value = newValue
    }

    @discardableResult
    func mutate<T>(_ body: (inout Value) -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body(&value)
    }
}

// MARK: - URLProtocol stub

struct RecordedRequest {
    let method: String
    let url: URL
    let headers: [String: String]
    let body: Data

    var path: String { url.path }
    var form: [String: String] { QueryString.parse(String(decoding: body, as: UTF8.self)) }
    var json: [String: Any] { ((try? JSONSerialization.jsonObject(with: body)) as? [String: Any]) ?? [:] }

    func header(_ name: String) -> String? {
        headers.first { $0.key.caseInsensitiveCompare(name) == .orderedSame }?.value
    }
}

struct StubResponse {
    var status: Int
    var headers: [String: String]
    var chunks: [Data]

    static func json(_ object: Any, status: Int = 200, headers: [String: String] = [:]) -> StubResponse {
        let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data()
        return StubResponse(status: status, headers: ["Content-Type": "application/json"].merging(headers) { $1 }, chunks: [data])
    }

    static func text(_ text: String, status: Int, headers: [String: String] = [:]) -> StubResponse {
        StubResponse(status: status, headers: ["Content-Type": "text/plain"].merging(headers) { $1 }, chunks: [Data(text.utf8)])
    }

    /// An SSE body delivered in `chunkSize`-byte pieces (splitting lines and multi-byte characters on purpose).
    static func sse(_ body: String, chunkSize: Int = 7, headers: [String: String] = [:]) -> StubResponse {
        let bytes = Array(body.utf8)
        let chunks = stride(from: 0, to: bytes.count, by: chunkSize).map { Data(bytes[$0 ..< min($0 + chunkSize, bytes.count)]) }
        return StubResponse(status: 200, headers: ["Content-Type": "text/event-stream"].merging(headers) { $1 }, chunks: chunks)
    }
}

final class StubURLProtocol: URLProtocol {
    typealias Handler = @Sendable (RecordedRequest) throws -> StubResponse

    private static let handler = Locked<Handler?>(nil)
    private static let recorded = Locked<[RecordedRequest]>([])

    /// Installs `handler` for subsequent requests and clears the request log.
    static func reset(_ handler: @escaping Handler) {
        self.handler.set(handler)
        recorded.set([])
    }

    static var requests: [RecordedRequest] { recorded.current }

    static func requests(path: String) -> [RecordedRequest] { requests.filter { $0.path == path } }

    static func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let request = RecordedRequest(
            method: self.request.httpMethod ?? "GET",
            url: self.request.url!,
            headers: self.request.allHTTPHeaderFields ?? [:],
            body: Self.body(of: self.request)
        )
        Self.recorded.mutate { $0.append(request) }
        guard let handler = Self.handler.current else {
            client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL))
            return
        }
        do {
            let stub = try handler(request)
            let response = HTTPURLResponse(url: request.url, statusCode: stub.status, httpVersion: "HTTP/1.1", headerFields: stub.headers)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            for chunk in stub.chunks { client?.urlProtocol(self, didLoad: chunk) }
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}

    private static func body(of request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }
}

// MARK: - Wallet opener stub

@MainActor
final class StubOpener: ModelPassURLOpener {
    var canOpenResult = true
    var openResult = true
    private(set) var opened: [URL] = []

    func canOpen(_ url: URL) -> Bool { canOpenResult }

    func open(_ url: URL) async -> Bool {
        opened.append(url)
        return openResult
    }
}

// MARK: - Fixtures

enum Fixtures {
    static let issuer = "https://hub.example.com"
    static let redirectURI = URL(string: "com.example.chat:/modelpass/callback")!

    static func configuration(trustedIssuers: [String]? = nil, walletAuthorizeURL: URL? = nil) -> ModelPassConfiguration {
        ModelPassConfiguration(
            clientId: "com.example.chat",
            redirectURI: redirectURI,
            clientName: "Example Chat",
            scopes: ["chat", "tools"],
            slots: ["default", "fast"],
            walletAuthorizeURL: walletAuthorizeURL ?? ModelPassConfiguration.defaultWalletAuthorizeURL,
            trustedIssuers: trustedIssuers
        )
    }

    /// §6.4 token response.
    static func tokenResponse(issuer: String = issuer, apiBase: String? = nil, accessToken: String = "mpk_3wq6oX8d") -> [String: Any] {
        [
            "access_token": accessToken,
            "token_type": "Bearer",
            "expires_in": 2_592_000,
            "scope": "chat tools",
            "grant_id": "g_9xKc2",
            "sub": "u2b1c",
            "issuer": issuer,
            "api_base": apiBase ?? "\(issuer)/v1",
            "api_formats": ["openai-chat-completions", "anthropic-messages"],
            "slots": [["id": "default", "label": "默认"], ["id": "fast", "label": "快速"]],
            "some_future_field": true,
        ]
    }

    static let session = ModelPassSession(
        accessToken: "mpk_session",
        issuer: URL(string: issuer)!,
        apiBase: URL(string: "\(issuer)/v1")!,
        grantId: "g_123",
        scope: "chat tools",
        sub: "u_1",
        slots: [ModelPassSlot(id: "default", label: "默认"), ModelPassSlot(id: "fast", label: "快速")]
    )

    static func redirect(_ params: [(String, String?)]) -> URL {
        URL(string: "\(redirectURI.absoluteString)?\(QueryString.encode(params))")!
    }
}

// MARK: - Helpers

extension Data {
    init(hex: String) {
        var bytes: [UInt8] = []
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            bytes.append(UInt8(hex[index ..< next], radix: 16)!)
            index = next
        }
        self.init(bytes)
    }

    var hex: String { map { String(format: "%02x", $0) }.joined() }
}

/// Polls `condition` on the main actor until it is true (fails the test after `timeout`).
@MainActor
func waitUntil(timeout: TimeInterval = 5, file: StaticString = #filePath, line: UInt = #line,
               _ condition: @MainActor () -> Bool) async throws {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition() {
        if Date() > deadline {
            XCTFail("timed out waiting for condition", file: file, line: line)
            throw ModelPassError.cancelled
        }
        try await Task.sleep(nanoseconds: 2_000_000)
    }
}

/// Asserts that `expression` throws exactly `expected`.
@MainActor
func assertThrows<T>(_ expected: ModelPassError, file: StaticString = #filePath, line: UInt = #line,
                     _ expression: () async throws -> T) async {
    do {
        _ = try await expression()
        XCTFail("expected \(expected), but the call succeeded", file: file, line: line)
    } catch let error as ModelPassError {
        XCTAssertEqual(error, expected, file: file, line: line)
    } catch {
        XCTFail("expected \(expected), got \(error)", file: file, line: line)
    }
}

/// Returns the `ModelPassError` thrown by `expression` (fails if it succeeds or throws something else).
@MainActor
func thrownError<T>(file: StaticString = #filePath, line: UInt = #line, _ expression: () async throws -> T) async -> ModelPassError? {
    do {
        _ = try await expression()
        XCTFail("expected an error, but the call succeeded", file: file, line: line)
    } catch let error as ModelPassError {
        return error
    } catch {
        XCTFail("expected a ModelPassError, got \(error)", file: file, line: line)
    }
    return nil
}
