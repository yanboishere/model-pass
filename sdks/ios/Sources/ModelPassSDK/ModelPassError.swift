import Foundation

/// Errors thrown by the ModelPass SDK.
public enum ModelPassError: Error, Equatable, Sendable {
    /// The ModelPass wallet app is not installed (or `modelpass` is missing from `LSApplicationQueriesSchemes`).
    /// Offer the QR-code flow (`startLink`) instead.
    case walletNotInstalled
    /// The user declined in the wallet (`error=access_denied`). Carries `error_description`.
    case accessDenied(String?)
    /// The wallet returned another OAuth error (`invalid_request`, `invalid_scope`, `server_error`, …).
    case authorizationFailed(code: String, description: String?)
    /// The redirect's `state` does not match the pending request, or no request is pending / it expired.
    case invalidState
    /// The hub (`iss`) is not an allowed URL (https required, http only for local development) or is not in
    /// `trustedIssuers`, or `issuerConfirmation` rejected it.
    case untrustedIssuer(String)
    /// The token endpoint returned an OAuth error: (`error`, `error_description`).
    case tokenExchangeFailed(String, String?)
    /// There is no session; call `authorize()` or `startLink(…)` first.
    case notSignedIn
    /// An error returned by the hub's model API (§8.7), e.g. `budget_exceeded`, `grant_paused`, `no_route`.
    case api(status: Int, code: String?, message: String)
    /// The link-flow QR code expired before the user approved it.
    case linkExpired
    /// The user declined the link-flow request in the wallet.
    case linkDenied
    /// The hub, wallet or rendezvous returned something the SDK could not understand.
    case invalidResponse(String)
    /// A transport-level error (offline, timeout, TLS…).
    case network(URLError)
    /// The operation was cancelled: task cancellation, a newer `authorize()` call, the user returning from the
    /// wallet without finishing, or `ModelPassLink.cancel()`.
    case cancelled
}

extension ModelPassError {
    /// `.network` errors compare by `URLError.Code` only (URLSession attaches request-specific user info), so
    /// `error == .network(URLError(.notConnectedToInternet))` works as expected.
    public static func == (lhs: ModelPassError, rhs: ModelPassError) -> Bool {
        switch (lhs, rhs) {
        case (.walletNotInstalled, .walletNotInstalled), (.invalidState, .invalidState), (.notSignedIn, .notSignedIn),
             (.linkExpired, .linkExpired), (.linkDenied, .linkDenied), (.cancelled, .cancelled):
            return true
        case let (.accessDenied(a), .accessDenied(b)):
            return a == b
        case let (.authorizationFailed(code1, description1), .authorizationFailed(code2, description2)):
            return code1 == code2 && description1 == description2
        case let (.untrustedIssuer(a), .untrustedIssuer(b)):
            return a == b
        case let (.tokenExchangeFailed(error1, description1), .tokenExchangeFailed(error2, description2)):
            return error1 == error2 && description1 == description2
        case let (.api(status1, code1, message1), .api(status2, code2, message2)):
            return status1 == status2 && code1 == code2 && message1 == message2
        case let (.invalidResponse(a), .invalidResponse(b)):
            return a == b
        case let (.network(a), .network(b)):
            return a.code == b.code
        default:
            return false
        }
    }

    /// The machine-readable code: the API error code (§8.7) or OAuth error code, when there is one.
    public var code: String? {
        switch self {
        case .api(_, let code, _): return code
        case .authorizationFailed(let code, _): return code
        case .tokenExchangeFailed(let code, _): return code
        case .accessDenied: return "access_denied"
        case .linkDenied: return "access_denied"
        case .linkExpired: return "expired_token"
        default: return nil
        }
    }

    /// True when the current session can no longer be used and the user has to connect again
    /// (`invalid_token`, `grant_revoked`, `grant_expired`, or no session at all). The SDK has already cleared
    /// the stored session in these cases.
    public var requiresReauthorization: Bool {
        switch self {
        case .notSignedIn: return true
        case .api(401, let code, _): return code.map(ModelPassError.sessionInvalidatingCodes.contains) ?? false
        default: return false
        }
    }

    /// API error codes that invalidate the session (§8.7).
    static let sessionInvalidatingCodes: Set<String> = ["invalid_token", "grant_revoked", "grant_expired"]
}

extension ModelPassError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .walletNotInstalled:
            return L10n.pick("未检测到 ModelPass 钱包。请先安装 ModelPass，或改用扫码授权。",
                             "The ModelPass wallet app is not installed. Install it or sign in with a QR code instead.")
        case .accessDenied(let description):
            return L10n.pick("你已拒绝授权。", "Authorization was denied.") + L10n.suffix(description)
        case .authorizationFailed(let code, let description):
            return L10n.pick("授权失败（\(code)）。", "Authorization failed (\(code)).") + L10n.suffix(description)
        case .invalidState:
            return L10n.pick("授权响应无效或已过期，请重试。",
                             "The authorization response is invalid or has expired. Please try again.")
        case .untrustedIssuer(let issuer):
            return L10n.pick("不受信任的 ModelPass Hub：\(issuer)", "Untrusted ModelPass hub: \(issuer)")
        case .tokenExchangeFailed(let error, let description):
            return L10n.pick("换取令牌失败（\(error)）。", "Token exchange failed (\(error)).") + L10n.suffix(description)
        case .notSignedIn:
            return L10n.pick("尚未连接 ModelPass，请先授权。", "Not connected to ModelPass. Please authorize first.")
        case .api(_, let code, let message):
            return Self.apiDescription(code: code, message: message)
        case .linkExpired:
            return L10n.pick("二维码已过期，请刷新后重试。", "The QR code has expired. Refresh it and try again.")
        case .linkDenied:
            return L10n.pick("已在 ModelPass 中拒绝授权。", "The request was declined in ModelPass.")
        case .invalidResponse(let detail):
            return L10n.pick("ModelPass 返回了无效的响应：\(detail)", "Invalid response from ModelPass: \(detail)")
        case .network(let error):
            return L10n.pick("网络错误：\(error.localizedDescription)", "Network error: \(error.localizedDescription)")
        case .cancelled:
            return L10n.pick("操作已取消。", "The operation was cancelled.")
        }
    }

    private static func apiDescription(code: String?, message: String) -> String {
        switch code {
        case "invalid_token":
            return L10n.pick("ModelPass 授权已失效，请重新连接。", "The ModelPass authorization is no longer valid. Please connect again.")
        case "grant_revoked":
            return L10n.pick("授权已在 ModelPass 中被撤销，请重新连接。", "The authorization was revoked in ModelPass. Please connect again.")
        case "grant_expired":
            return L10n.pick("授权已过期，请重新连接 ModelPass。", "The authorization has expired. Please connect ModelPass again.")
        case "grant_paused":
            return L10n.pick("该应用已在 ModelPass 中被暂停，请在钱包中恢复。", "This app is paused in ModelPass. Resume it in the wallet.")
        case "insufficient_scope":
            return L10n.pick("当前授权不包含所需权限：\(message)", "The authorization does not include the required scope: \(message)")
        case "budget_exceeded":
            return L10n.pick("已超过今日的使用额度。", "The daily usage budget has been exceeded.")
        case "no_route":
            return L10n.pick("尚未为该槽位配置模型，请打开 ModelPass 钱包设置。", "No model is configured for this slot yet. Open the ModelPass wallet to set one up.")
        case "upstream_auth_failed":
            return L10n.pick("模型厂商的 Key 已失效，请在 ModelPass 钱包中检查。", "The provider key is no longer valid. Check it in the ModelPass wallet.")
        case "upstream_error":
            return L10n.pick("上游模型服务出错：\(message)", "The upstream model provider returned an error: \(message)")
        default:
            return message
        }
    }
}

/// Picks Chinese or English based on the user's preferred language.
enum L10n {
    static var prefersChinese: Bool {
        (Locale.preferredLanguages.first ?? "").lowercased().hasPrefix("zh")
    }

    static func pick(_ chinese: String, _ english: String) -> String {
        prefersChinese ? chinese : english
    }

    static func suffix(_ detail: String?) -> String {
        guard let detail, !detail.isEmpty else { return "" }
        return prefersChinese ? "（\(detail)）" : " (\(detail))"
    }
}
