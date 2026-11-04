import Foundation
import Security

/// Secure storage for ModelPass secrets: the session (access token) and the in-flight authorization request
/// (which contains the PKCE `code_verifier`). Values are small JSON blobs.
///
/// The SDK only touches the store from the main actor. Use `KeychainSessionStore` in apps and
/// `InMemorySessionStore` in tests / previews. Per protocol §13.5 tokens must live in the Keychain.
public protocol ModelPassSessionStore {
    func load(key: String) throws -> Data?
    func save(_ data: Data, key: String) throws
    func remove(key: String) throws
}

/// Keys used by the SDK.
enum StoreKey {
    static let session = "session"
    static let pendingAuthorization = "pending_authorization"
}

extension ModelPassSessionStore {
    func loadValue<T: Decodable>(_ type: T.Type, key: String) throws -> T? {
        guard let data = try load(key: key) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .secondsSince1970
        return try decoder.decode(T.self, from: data)
    }

    func saveValue<T: Encodable>(_ value: T, key: String) throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .secondsSince1970
        try save(encoder.encode(value), key: key)
    }
}

/// Stores ModelPass secrets as `kSecClassGenericPassword` items (service `dev.modelpass.sdk`, account = key).
public struct KeychainSessionStore: ModelPassSessionStore, Sendable {
    public enum Accessibility: Sendable {
        case afterFirstUnlock
        case afterFirstUnlockThisDeviceOnly
        case whenUnlocked
        case whenUnlockedThisDeviceOnly

        var attribute: CFString {
            switch self {
            case .afterFirstUnlock: return kSecAttrAccessibleAfterFirstUnlock
            case .afterFirstUnlockThisDeviceOnly: return kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            case .whenUnlocked: return kSecAttrAccessibleWhenUnlocked
            case .whenUnlockedThisDeviceOnly: return kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            }
        }
    }

    /// A Keychain call failed with `status` (see `SecCopyErrorMessageString`).
    public struct KeychainError: Error, Equatable, CustomStringConvertible {
        public let status: OSStatus
        public var description: String {
            let message = SecCopyErrorMessageString(status, nil) as String? ?? "unknown"
            return "Keychain error \(status): \(message)"
        }
    }

    public let service: String
    public let accessGroup: String?
    public let accessibility: Accessibility

    /// - Parameters:
    ///   - service: `kSecAttrService`. Use different services if you run several `ModelPass` instances.
    ///   - accessGroup: Optional Keychain access group (to share the session with extensions).
    ///   - accessibility: Defaults to "after first unlock, this device only": readable by background tasks after
    ///     the first unlock, never migrated to another device via backups.
    public init(service: String = "dev.modelpass.sdk", accessGroup: String? = nil,
                accessibility: Accessibility = .afterFirstUnlockThisDeviceOnly) {
        self.service = service
        self.accessGroup = accessGroup
        self.accessibility = accessibility
    }

    private func query(_ key: String) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        return query
    }

    public func load(key: String) throws -> Data? {
        var query = query(key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        switch status {
        case errSecSuccess: return result as? Data
        case errSecItemNotFound: return nil
        default: throw KeychainError(status: status)
        }
    }

    public func save(_ data: Data, key: String) throws {
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: accessibility.attribute,
        ]
        let status = SecItemUpdate(query(key) as CFDictionary, attributes as CFDictionary)
        switch status {
        case errSecSuccess:
            return
        case errSecItemNotFound:
            let addStatus = SecItemAdd(query(key).merging(attributes) { $1 } as CFDictionary, nil)
            guard addStatus == errSecSuccess else { throw KeychainError(status: addStatus) }
        default:
            throw KeychainError(status: status)
        }
    }

    public func remove(key: String) throws {
        let status = SecItemDelete(query(key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError(status: status) }
    }
}

/// A non-persistent store for tests and SwiftUI previews.
public final class InMemorySessionStore: ModelPassSessionStore, @unchecked Sendable {
    private var storage: [String: Data] = [:]
    private let lock = NSLock()

    public init() {}

    /// A store that already contains `session` (handy for previews).
    public convenience init(session: ModelPassSession) {
        self.init()
        try? saveValue(session, key: StoreKey.session)
    }

    public func load(key: String) throws -> Data? {
        lock.lock()
        defer { lock.unlock() }
        return storage[key]
    }

    public func save(_ data: Data, key: String) throws {
        lock.lock()
        defer { lock.unlock() }
        storage[key] = data
    }

    public func remove(key: String) throws {
        lock.lock()
        defer { lock.unlock() }
        storage[key] = nil
    }

    /// Keys currently stored (for tests).
    public var keys: [String] {
        lock.lock()
        defer { lock.unlock() }
        return storage.keys.sorted()
    }
}
