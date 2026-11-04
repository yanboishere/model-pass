import Foundation
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// Opens the wallet. The default implementation uses `UIApplication.shared` (or `NSWorkspace` on macOS);
/// supply your own to `ModelPass.init(…urlOpener:)` for app extensions, custom routing or tests.
@MainActor
public protocol ModelPassURLOpener {
    /// Whether some installed app can handle `url` (`UIApplication.canOpenURL`).
    func canOpen(_ url: URL) -> Bool
    /// Opens `url`; returns false when no app handled it.
    func open(_ url: URL) async -> Bool
}

/// Uses `UIApplication.shared` on iOS and `NSWorkspace.shared` on macOS.
@MainActor
public struct SystemURLOpener: ModelPassURLOpener {
    public nonisolated init() {}

    public func canOpen(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased() else { return false }
        // Universal links / web fallbacks are always "openable" (Safari shows the install page).
        if scheme == "https" || scheme == "http" { return true }
        #if canImport(UIKit)
        // iOS only answers canOpenURL for schemes listed in LSApplicationQueriesSchemes; for undeclared schemes it
        // always says "no". In that case skip the pre-check and rely on open()'s result instead.
        guard Self.isQueryable(scheme: scheme) else {
            modelPassLog.warning("Add \"\(scheme, privacy: .public)\" to LSApplicationQueriesSchemes in Info.plist so ModelPass can detect whether the wallet is installed.")
            return true
        }
        return UIApplication.shared.canOpenURL(url)
        #elseif canImport(AppKit)
        return NSWorkspace.shared.urlForApplication(toOpen: url) != nil
        #else
        return false
        #endif
    }

    public func open(_ url: URL) async -> Bool {
        #if canImport(UIKit)
        return await UIApplication.shared.open(url, options: [:])
        #elseif canImport(AppKit)
        return NSWorkspace.shared.open(url)
        #else
        return false
        #endif
    }

    static func isQueryable(scheme: String) -> Bool {
        guard let schemes = Bundle.main.object(forInfoDictionaryKey: "LSApplicationQueriesSchemes") as? [String] else {
            return false
        }
        return schemes.contains { $0.caseInsensitiveCompare(scheme) == .orderedSame }
    }
}
