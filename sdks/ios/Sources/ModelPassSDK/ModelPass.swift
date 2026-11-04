import Combine
import Foundation
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// "Continue with ModelPass": lets your app use the user's own AI models through an OpenAI-compatible endpoint.
///
/// ```swift
/// let modelPass = ModelPass(configuration: .init(
///     clientId: "com.example.chat",
///     redirectURI: URL(string: "com.example.chat:/modelpass/callback")!,
///     clientName: "Example Chat"))
///
/// // SwiftUI: .onOpenURL { modelPass.handleRedirect($0) }
/// let session = try await modelPass.authorize()
/// let reply = try await modelPass.chat([.user("你好")])
/// ```
///
/// All state lives on the main actor; network work runs off the main thread. Observe `session` via SwiftUI
/// (`ObservableObject`), Combine (`$session`), `onSessionChange`, or `for await s in modelPass.$session.values`.
@MainActor
public final class ModelPass: ObservableObject {
    public nonisolated let configuration: ModelPassConfiguration
    public nonisolated let urlSession: URLSession
    let sessionStore: any ModelPassSessionStore
    private let customURLOpener: (any ModelPassURLOpener)?

    /// The current session, restored from the store at init. `nil` when not connected.
    @Published public private(set) var session: ModelPassSession?
    /// True while an `authorize()` call waits for the wallet or a redirect is being exchanged for a token.
    @Published public private(set) var isAuthorizing: Bool = false

    /// Called whenever `session` changes: authorization, link flow, sign-out, or a 401 that invalidated the token.
    public var onSessionChange: (@MainActor (ModelPassSession?) -> Void)?
    /// Called with the outcome of every redirect processed by `handleRedirect(_:)`, including redirects that arrive
    /// after a cold start when no `authorize()` call is waiting any more.
    public var onAuthorizationResult: (@MainActor (Result<ModelPassSession, Error>) -> Void)?
    /// Optional hook to show "Connecting to {issuer}" and let the user confirm a hub before the token exchange
    /// (protocol §6.2 / §13.2). Return false to abort with `ModelPassError.untrustedIssuer`.
    public var issuerConfirmation: (@MainActor (URL) async -> Bool)?

    // Test seams (internal).
    var sleep: @Sendable (TimeInterval) async throws -> Void = { seconds in
        try await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
    }
    var now: @Sendable () -> Date = { Date() }
    /// How long to wait for the redirect after the app becomes active again before giving up on `authorize()`.
    var returnGracePeriod: TimeInterval = 2

    private struct Waiter {
        let id: UUID
        let continuation: CheckedContinuation<ModelPassSession, Error>
    }

    private var waiter: Waiter?
    private var redirectReceived = false
    private var returnObserver: NSObjectProtocol?
    private var pendingCache: PendingAuthorization?
    private var lastRedirect: (state: String, task: Task<ModelPassSession, Error>)?

    /// - Parameters:
    ///   - configuration: Your client ID, redirect URI, requested scopes / slots.
    ///   - sessionStore: Where the session and the pending request are kept. Defaults to the Keychain.
    ///   - urlSession: Used for all HTTP calls.
    ///   - urlOpener: Opens the wallet. Defaults to `UIApplication.shared` (`NSWorkspace` on macOS).
    public init(
        configuration: ModelPassConfiguration,
        sessionStore: any ModelPassSessionStore = KeychainSessionStore(),
        urlSession: URLSession = .shared,
        urlOpener: (any ModelPassURLOpener)? = nil
    ) {
        self.configuration = configuration
        self.sessionStore = sessionStore
        self.urlSession = urlSession
        self.customURLOpener = urlOpener
        self._session = Published(initialValue: Self.restoreSession(from: sessionStore))
    }

    var urlOpener: any ModelPassURLOpener { customURLOpener ?? SystemURLOpener() }

    /// Whether the wallet app can be opened. Requires `modelpass` in `LSApplicationQueriesSchemes`; without it iOS
    /// cannot answer and this returns true (the wallet is then simply opened and `authorize()` reports failures).
    public var isWalletInstalled: Bool { urlOpener.canOpen(configuration.walletAuthorizeURL) }

    /// `modelpass://grants/{grant_id}` — link it as "在 ModelPass 中管理 / Manage in ModelPass" (§9).
    public var manageURL: URL? { session?.manageURL }

    // MARK: - Same-device authorization (§6)

    /// Opens the ModelPass wallet and waits until the user approves or declines.
    ///
    /// Forward incoming URLs to `handleRedirect(_:)` (e.g. SwiftUI `.onOpenURL`) so this call can complete.
    /// The pending request (state + PKCE verifier) is persisted, so a redirect that arrives after the app was
    /// terminated still completes; observe `session` / `onAuthorizationResult` for that case.
    ///
    /// If the user switches back to the app without finishing in the wallet (no redirect arrives shortly after the
    /// app becomes active again), the call ends with `ModelPassError.cancelled` so the UI does not stay busy. The
    /// request stays valid: a later redirect still completes it (delivered via `session` / `onAuthorizationResult`).
    ///
    /// - Parameters:
    ///   - scopes: Defaults to `configuration.scopes`; `chat` is always included.
    ///   - slots: Defaults to `configuration.slots`; `default` is always included.
    ///   - budgetHint: Suggested daily token budget shown in the wallet (the user may change it).
    /// - Throws: `ModelPassError.walletNotInstalled`, `.accessDenied`, `.invalidState`, `.untrustedIssuer`,
    ///   `.tokenExchangeFailed`, `.network`, `.cancelled` (task cancelled, superseded by a newer call, or the user
    ///   came back without finishing in the wallet).
    @discardableResult
    public func authorize(scopes: [String]? = nil, slots: [String]? = nil, budgetHint: Int? = nil) async throws -> ModelPassSession {
        let pending = PendingAuthorization(
            state: PKCE.makeState(),
            codeVerifier: PKCE.makeVerifier(),
            redirectURI: configuration.redirectURI.absoluteString,
            clientId: configuration.clientId,
            scopes: Self.normalizedList(scopes ?? configuration.scopes, required: "chat"),
            slots: Self.normalizedList(slots ?? configuration.slots, required: "default"),
            createdAt: now()
        )
        let walletURL = authorizationURL(for: pending, budgetHint: budgetHint)
        let opener = urlOpener
        guard opener.canOpen(walletURL) else { throw ModelPassError.walletNotInstalled }
        if Task.isCancelled { throw ModelPassError.cancelled }

        // A newer request supersedes one that is still waiting.
        if let previous = waiter {
            waiter = nil
            previous.continuation.resume(throwing: ModelPassError.cancelled)
        }
        stopObservingReturn()
        redirectReceived = false
        savePending(pending)
        isAuthorizing = true

        let id = UUID()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<ModelPassSession, Error>) in
                self.waiter = Waiter(id: id, continuation: continuation)
                Task { @MainActor in
                    let opened = await opener.open(walletURL)
                    guard self.waiter?.id == id else { return }
                    if opened {
                        self.observeReturnWithoutRedirect(id: id)
                    } else {
                        self.clearPending()
                        self.resumeWaiter(id: id, with: .failure(ModelPassError.walletNotInstalled))
                    }
                }
            }
        } onCancel: {
            Task { @MainActor in self.resumeWaiter(id: id, with: .failure(ModelPassError.cancelled)) }
        }
    }

    /// Call from SwiftUI `.onOpenURL`, `scene(_:openURLContexts:)` or `application(_:open:options:)`.
    ///
    /// - Returns: true when `url` is a ModelPass redirect (it is then processed asynchronously and the result is
    ///   delivered to the waiting `authorize()` call, `onAuthorizationResult` and `session`); false otherwise.
    @discardableResult
    public func handleRedirect(_ url: URL) -> Bool {
        guard isRedirectURL(url) else { return false }
        Task { _ = try? await self.completeAuthorization(redirectURL: url) }
        return true
    }

    /// True when `url` targets the configured redirect URI.
    public func isRedirectURL(_ url: URL) -> Bool {
        RedirectMatcher.matches(url, redirectURI: configuration.redirectURI)
    }

    /// Async variant of `handleRedirect(_:)`: validates the redirect (state, error, iss), exchanges the code for a
    /// token and stores the session. Duplicate deliveries of the same redirect share one exchange.
    @discardableResult
    public func completeAuthorization(redirectURL url: URL) async throws -> ModelPassSession {
        guard isRedirectURL(url) else {
            throw ModelPassError.invalidResponse("the URL does not match the configured redirect URI")
        }
        redirectReceived = true
        let params = QueryString.parameters(of: url)
        let state = params["state"] ?? ""
        if !state.isEmpty, let last = lastRedirect, last.state == state {
            return try await last.task.value
        }
        let task = Task { @MainActor () throws -> ModelPassSession in
            let result: Result<ModelPassSession, Error>
            do {
                result = .success(try await self.processRedirect(params))
            } catch {
                result = .failure(HTTPClient.mapTransportError(error))
            }
            self.deliver(result)
            return try result.get()
        }
        if !state.isEmpty { lastRedirect = (state, task) }
        return try await task.value
    }

    private func processRedirect(_ params: [String: String]) async throws -> ModelPassSession {
        isAuthorizing = true
        guard let pending = loadPending() else { throw ModelPassError.invalidState }
        guard let state = params["state"], MPCrypto.constantTimeEquals(state, pending.state) else {
            // Not ours (stale or forged): keep the pending request so the genuine redirect can still complete.
            throw ModelPassError.invalidState
        }
        clearPending() // single use
        guard now().timeIntervalSince(pending.createdAt) <= PendingAuthorization.lifetime else {
            throw ModelPassError.invalidState
        }
        if let error = params["error"] {
            let description = params["error_description"].flatMap { $0.isEmpty ? nil : $0 }
            if error == "access_denied" { throw ModelPassError.accessDenied(description) }
            throw ModelPassError.authorizationFailed(code: error, description: description)
        }
        guard let code = params["code"], !code.isEmpty else {
            throw ModelPassError.invalidResponse("the redirect contains no code")
        }
        guard let iss = params["iss"], !iss.isEmpty else {
            throw ModelPassError.invalidResponse("the redirect contains no iss")
        }
        let issuer = try IssuerPolicy.validateIssuer(iss, trusted: configuration.trustedIssuers)
        try await confirmIssuer(issuer)
        let session = try await exchangeCode(code, issuer: issuer, pending: pending)
        adopt(session)
        return session
    }

    private func exchangeCode(_ code: String, issuer: URL, pending: PendingAuthorization) async throws -> ModelPassSession {
        let http = HTTPClient(urlSession: urlSession)
        let tokenEndpoint = await Self.tokenEndpoint(for: issuer, http: http)
        let request = HTTPClient.formRequest(tokenEndpoint, [
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", pending.redirectURI),
            ("client_id", pending.clientId),
            ("code_verifier", pending.codeVerifier),
        ])
        let (data, response) = try await http.send(request)
        guard (200..<300).contains(response.statusCode) else {
            if let oauth = HTTPClient.oauthError(from: data) {
                throw ModelPassError.tokenExchangeFailed(oauth.error, oauth.description)
            }
            throw ModelPassError.tokenExchangeFailed("server_error", "HTTP \(response.statusCode)")
        }
        return try TokenResponse.decode(data).makeSession(issuer: issuer, receivedAt: now())
    }

    /// `token_endpoint` from `{issuer}/.well-known/modelpass-configuration`, falling back to `{issuer}/oauth/token`.
    nonisolated static func tokenEndpoint(for issuer: URL, http: HTTPClient) async -> URL {
        let fallback = IssuerPolicy.endpoint(issuer, ModelPassProtocol.tokenPath)
        let discoveryURL = IssuerPolicy.endpoint(issuer, ModelPassProtocol.discoveryPath)
        guard let result = try? await http.send(HTTPClient.getRequest(discoveryURL, timeout: 10)),
              (200..<300).contains(result.1.statusCode),
              let document = try? JSONDecoder().decode(DiscoveryDocument.self, from: result.0),
              IssuerPolicy.sameIssuer(document.issuer, issuer.absoluteString),
              let endpoint = document.tokenEndpoint.flatMap(URL.init(string:)),
              IssuerPolicy.isAllowedURL(endpoint)
        else { return fallback }
        return endpoint
    }

    func confirmIssuer(_ issuer: URL) async throws {
        guard let issuerConfirmation else { return }
        guard await issuerConfirmation(issuer) else { throw ModelPassError.untrustedIssuer(issuer.absoluteString) }
    }

    private func deliver(_ result: Result<ModelPassSession, Error>) {
        stopObservingReturn()
        if let current = waiter {
            waiter = nil
            current.continuation.resume(with: result)
        }
        isAuthorizing = false
        onAuthorizationResult?(result)
    }

    private func resumeWaiter(id: UUID, with result: Result<ModelPassSession, Error>) {
        guard let current = waiter, current.id == id else { return }
        stopObservingReturn()
        waiter = nil
        isAuthorizing = false
        current.continuation.resume(with: result)
    }

    /// Ends a waiting `authorize()` with `.cancelled` when the app becomes active again (the user left the wallet)
    /// and no redirect arrives within `returnGracePeriod`.
    private func observeReturnWithoutRedirect(id: UUID) {
        stopObservingReturn()
        guard let name = Self.didBecomeActiveNotification else { return }
        returnObserver = NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, self.waiter?.id == id else { return }
                try? await Task.sleep(nanoseconds: UInt64(max(0, self.returnGracePeriod) * 1_000_000_000))
                guard self.waiter?.id == id, !self.redirectReceived else { return }
                modelPassLog.info("Returned from the wallet without a redirect; authorize() ends with .cancelled")
                self.resumeWaiter(id: id, with: .failure(ModelPassError.cancelled))
            }
        }
    }

    private func stopObservingReturn() {
        if let returnObserver { NotificationCenter.default.removeObserver(returnObserver) }
        returnObserver = nil
    }

    private nonisolated static var didBecomeActiveNotification: Notification.Name? {
        #if canImport(UIKit)
        return UIApplication.didBecomeActiveNotification
        #elseif canImport(AppKit)
        return NSApplication.didBecomeActiveNotification
        #else
        return nil
        #endif
    }

    /// The `modelpass://authorize?…` URL for a pending request (§6.1).
    func authorizationURL(for pending: PendingAuthorization, budgetHint: Int?) -> URL {
        let query = QueryString.encode([
            ("response_type", "code"),
            ("client_id", pending.clientId),
            ("redirect_uri", pending.redirectURI),
            ("scope", pending.scopes.joined(separator: " ")),
            ("state", pending.state),
            ("code_challenge", PKCE.challenge(for: pending.codeVerifier)),
            ("code_challenge_method", "S256"),
            ("slots", pending.slots.joined(separator: " ")),
            ("client_name", configuration.clientName),
            ("budget_hint", budgetHint.flatMap { $0 > 0 ? String($0) : nil }),
        ])
        // Every value is percent-encoded, so this only fails for an invalid walletAuthorizeURL.
        return URL(string: QueryString.append(query, to: configuration.walletAuthorizeURL.absoluteString))
            ?? configuration.walletAuthorizeURL
    }

    /// De-duplicates, splits on spaces / commas and puts `required` first.
    nonisolated static func normalizedList(_ values: [String], required: String) -> [String] {
        var out = [required]
        for value in values {
            for part in value.split(whereSeparator: { $0 == " " || $0 == "," }) {
                let item = String(part)
                if !out.contains(item) { out.append(item) }
            }
        }
        return out
    }

    // MARK: - Session storage

    /// Re-reads the session from the store (e.g. after a background launch before the first unlock).
    public func reloadSession() {
        let restored = Self.restoreSession(from: sessionStore)
        guard restored != session else { return }
        session = restored
        onSessionChange?(restored)
    }

    func adopt(_ newSession: ModelPassSession) {
        do {
            try sessionStore.saveValue(newSession, key: StoreKey.session)
        } catch {
            modelPassLog.error("Could not persist the ModelPass session: \(String(describing: error), privacy: .public)")
        }
        session = newSession
        onSessionChange?(newSession)
    }

    func clearSession() {
        do {
            try sessionStore.remove(key: StoreKey.session)
        } catch {
            modelPassLog.error("Could not delete the ModelPass session: \(String(describing: error), privacy: .public)")
        }
        guard session != nil else { return }
        session = nil
        onSessionChange?(nil)
    }

    /// Clears the session after a 401 `invalid_token` / `grant_revoked` / `grant_expired` (§8.7) — unless the
    /// failing request used an older token than the current session.
    func invalidateSessionIfNeeded(after error: Error, token: String) {
        guard let error = error as? ModelPassError, case .api = error, error.requiresReauthorization,
              session?.accessToken == token else { return }
        clearSession()
    }

    private nonisolated static func restoreSession(from store: any ModelPassSessionStore) -> ModelPassSession? {
        do {
            return try store.loadValue(ModelPassSession.self, key: StoreKey.session)
        } catch is DecodingError {
            try? store.remove(key: StoreKey.session) // unreadable leftovers
            return nil
        } catch {
            modelPassLog.error("Could not read the ModelPass session: \(String(describing: error), privacy: .public)")
            return nil
        }
    }

    private func savePending(_ pending: PendingAuthorization) {
        pendingCache = pending
        do {
            try sessionStore.saveValue(pending, key: StoreKey.pendingAuthorization)
        } catch {
            modelPassLog.error("Could not persist the pending ModelPass request: \(String(describing: error), privacy: .public)")
        }
    }

    private func loadPending() -> PendingAuthorization? {
        if let pendingCache { return pendingCache }
        return try? sessionStore.loadValue(PendingAuthorization.self, key: StoreKey.pendingAuthorization)
    }

    private func clearPending() {
        pendingCache = nil
        try? sessionStore.remove(key: StoreKey.pendingAuthorization)
    }

    // MARK: - Grant info, revocation (§8.6, §9)

    /// `GET {api_base}/modelpass/grant`: status, slots and budget of the current grant.
    public func grantInfo() async throws -> ModelPassGrantInfo {
        let client = try apiClient()
        do {
            return try await client.grantInfo()
        } catch {
            invalidateSessionIfNeeded(after: error, token: client.session.accessToken)
            throw error
        }
    }

    /// Disconnects: revokes the token at `{issuer}/oauth/revoke` (best effort, RFC 7009) and clears the store.
    public func signOut(revoke: Bool = true) async {
        guard let current = session else {
            clearSession()
            return
        }
        if revoke {
            let request = HTTPClient.formRequest(
                IssuerPolicy.endpoint(current.issuer, ModelPassProtocol.revocationPath),
                [("token", current.accessToken)],
                timeout: 10
            )
            do {
                let (_, response) = try await HTTPClient(urlSession: urlSession).send(request)
                if !(200..<300).contains(response.statusCode) {
                    modelPassLog.warning("ModelPass revocation returned HTTP \(response.statusCode)")
                }
            } catch {
                modelPassLog.warning("ModelPass revocation failed: \(String(describing: error), privacy: .public)")
            }
        }
        if session?.accessToken == current.accessToken { clearSession() }
    }

    // MARK: - Calling models (§8)

    /// `POST {api_base}/chat/completions` (non-streaming).
    ///
    /// - Parameter model: A granted slot (`default`, `fast`, `reasoning`, `vision`); anything else falls back to
    ///   `default` on the hub (see `ChatCompletion.routing.fallback`).
    public func chat(_ messages: [ChatMessage], model: String = "default", options: ChatOptions = ChatOptions()) async throws -> ChatCompletion {
        let client = try apiClient()
        do {
            return try await client.chat(messages, model: model, options: options)
        } catch {
            invalidateSessionIfNeeded(after: error, token: client.session.accessToken)
            throw error
        }
    }

    /// Streaming chat completion (SSE). Yields `.routing` first, then `.content` / `.reasoning` / `.toolCall`
    /// deltas, `.finish` and `.usage`. Stops at `[DONE]`. Cancel by breaking out of the loop / cancelling the task.
    public func streamChat(_ messages: [ChatMessage], model: String = "default", options: ChatOptions = ChatOptions()) -> AsyncThrowingStream<ChatStreamEvent, Error> {
        let client: ModelPassAPIClient
        do {
            client = try apiClient()
        } catch {
            return AsyncThrowingStream { $0.finish(throwing: error) }
        }
        let token = client.session.accessToken
        return client.streamChat(messages, model: model, options: options) { [weak self] error in
            await self?.invalidateSessionIfNeeded(after: error, token: token)
        }
    }

    private func apiClient() throws -> ModelPassAPIClient {
        guard let session else { throw ModelPassError.notSignedIn }
        return ModelPassAPIClient(session: session, urlSession: urlSession)
    }
}
