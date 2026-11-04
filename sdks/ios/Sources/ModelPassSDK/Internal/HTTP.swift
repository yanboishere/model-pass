import Foundation
import os

let modelPassLog = Logger(subsystem: "dev.modelpass.sdk", category: "ModelPass")

/// Minimal HTTP helper shared by the authorization, link and API code paths.
struct HTTPClient: Sendable {
    let urlSession: URLSession

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await urlSession.data(for: request)
        } catch {
            throw HTTPClient.mapTransportError(error)
        }
        guard let http = response as? HTTPURLResponse else {
            throw ModelPassError.invalidResponse("not an HTTP response")
        }
        return (data, http)
    }

    /// URLError / CancellationError → ModelPassError.
    static func mapTransportError(_ error: Error) -> Error {
        switch error {
        case let error as ModelPassError: return error
        case is CancellationError: return ModelPassError.cancelled
        case let error as URLError: return error.code == .cancelled ? ModelPassError.cancelled : ModelPassError.network(error)
        default: return error
        }
    }

    /// `POST application/x-www-form-urlencoded` (OAuth endpoints).
    static func formRequest(_ url: URL, _ params: [(String, String?)], timeout: TimeInterval = 30) -> URLRequest {
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = Data(QueryString.encode(params).utf8)
        return request
    }

    static func getRequest(_ url: URL, timeout: TimeInterval = 15) -> URLRequest {
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return request
    }

    /// RFC 6749 §5.2 error body: `{"error":"invalid_grant","error_description":"…"}`.
    static func oauthError(from data: Data) -> (error: String, description: String?)? {
        guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        if let error = object["error"] as? String {
            return (error, object["error_description"] as? String)
        }
        if let nested = object["error"] as? [String: Any] {
            let code = stringValue(nested["code"]) ?? (nested["type"] as? String) ?? "server_error"
            return (code, nested["message"] as? String)
        }
        return nil
    }

    /// Maps an API error body (§8.7: `{"error":{"message","type","code"}}`) to `ModelPassError.api`.
    static func apiError(status: Int, data: Data) -> ModelPassError {
        if let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
            if let error = object["error"] as? [String: Any] {
                let code = stringValue(error["code"])
                let message = (error["message"] as? String) ?? code ?? HTTPURLResponse.localizedString(forStatusCode: status)
                return .api(status: status, code: code, message: message)
            }
            if let code = object["error"] as? String {
                let message = (object["error_description"] as? String) ?? (object["message"] as? String) ?? code
                return .api(status: status, code: code, message: message)
            }
            if let message = object["message"] as? String {
                return .api(status: status, code: stringValue(object["code"]), message: message)
            }
        }
        let text = String(decoding: data.prefix(500), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return .api(status: status, code: nil, message: text.isEmpty ? HTTPURLResponse.localizedString(forStatusCode: status) : text)
    }

    private static func stringValue(_ value: Any?) -> String? {
        switch value {
        case let string as String: return string
        case let number as NSNumber: return number.stringValue
        default: return nil
        }
    }
}
