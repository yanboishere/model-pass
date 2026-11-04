import Foundation
import ModelPassSDK

let hub = ProcessInfo.processInfo.environment["HUB_URL"] ?? "http://localhost:8787"
let repoRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../../..").standardized

/// Runs the headless wallet and returns the last line it printed.
func wallet(_ args: [String]) throws -> String {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = ["npx", "tsx", "scripts/interop/wallet.mts"] + args
    process.currentDirectoryURL = repoRoot
    var env = ProcessInfo.processInfo.environment
    env["HUB_URL"] = hub
    process.environment = env
    let out = Pipe()
    process.standardOutput = out
    try process.run()
    process.waitUntilExit()
    let text = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    guard process.terminationStatus == 0 else { throw NSError(domain: "wallet", code: Int(process.terminationStatus), userInfo: [NSLocalizedDescriptionKey: text]) }
    return text.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: "\n").last ?? ""
}

func check(_ ok: Bool, _ message: String) {
    print(ok ? "✔ \(message)" : "✘ \(message)")
    if !ok { exit(1) }
}

/// Stands in for "open the wallet app": hands the URL to the headless wallet and feeds the redirect back.
@MainActor
final class HeadlessWalletOpener: ModelPassURLOpener {
    weak var modelPass: ModelPass?
    func canOpen(_ url: URL) -> Bool { true }
    func open(_ url: URL) async -> Bool {
        Task.detached {
            let redirect = try wallet(["approve-authorize", url.absoluteString])
            await MainActor.run { _ = self.modelPass?.handleRedirect(URL(string: redirect)!) }
        }
        return true
    }
}

@MainActor
func run() async throws {
    // 1. Same-device flow: authorize() → wallet → redirect → code exchange.
    let opener = HeadlessWalletOpener()
    let app = ModelPass(
        configuration: ModelPassConfiguration(clientId: "dev.interop.swift", redirectURI: URL(string: "dev.interop.swift://cb")!,
                                              clientName: "Swift Interop", scopes: ["chat", "tools"], slots: ["default", "reasoning"]),
        sessionStore: InMemorySessionStore(), urlOpener: opener)
    opener.modelPass = app
    let session = try await app.authorize()
    check(session.accessToken.hasPrefix("mpk_"), "same-device authorize → \(session.issuer)")

    let completion = try await app.chat([.user("hello from Swift")], model: "default")
    check((completion.text ?? "").contains("mock-gpt-mini"), "chat via OpenAI-compatible upstream: \(completion.routing.model ?? "?") / \(completion.routing.provider ?? "?")")
    check(completion.routing.provider == "演示模型 · OpenAI 协议", "x-modelpass-provider header decoded (CJK)")

    var streamed = ""
    for try await event in app.streamChat([.user("stream from Swift")], model: "reasoning") {
        if case .content(let delta) = event { streamed += delta }
    }
    check(streamed.contains("Anthropic"), "streaming through the Anthropic translation (\(streamed.count) chars)")

    let info = try await app.grantInfo()
    check((info.budget?.requestsToday ?? 0) >= 2, "grant info: \(info.budget?.requestsToday ?? 0) requests today")
    await app.signOut()
    do {
        _ = try await app.chat([.user("after sign-out")])
        check(false, "revoked token must fail")
    } catch {
        check(true, "revoked after signOut: \(error.localizedDescription)")
    }

    // 2. Cross-device link flow: startLink → wallet approves the QR → sealed token decrypted.
    let web = ModelPass(configuration: ModelPassConfiguration(clientId: "dev.modelpass.webdemo", redirectURI: URL(string: "dev.interop.swift://cb")!, clientName: "Swift Link"),
                        sessionStore: InMemorySessionStore(), urlOpener: opener)
    let link = try await web.startLink(rendezvous: URL(string: hub)!)
    check(link.qrURL.absoluteString.contains("#v=1&uc="), "link QR \(link.userCode)")
    let qr = link.qrURL.absoluteString
    Task.detached { _ = try wallet(["approve-link", qr]) }
    let linked = try await link.waitForSession()
    check(linked.grantId.hasPrefix("g_"), "link flow session (grant \(linked.grantId))")
    let reply = try await web.chat([.user("hi via QR")])
    check(!(reply.text ?? "").isEmpty, "chat after link flow")
    print("Swift SDK interop: all checks passed")
}

do {
    try await run()
} catch {
    print("✘ \(error)")
    exit(1)
}
