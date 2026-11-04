import CryptoKit
import Foundation
import Security

/// RFC 4648 §5 base64url **without padding** (protocol §3).
enum Base64URL {
    static func encode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Decodes base64url (or standard base64), with or without padding. Returns nil for malformed input.
    static func decode(_ string: String) -> Data? {
        var s = string
        while s.hasSuffix("=") { s.removeLast() }
        guard s.count % 4 != 1 else { return nil }
        s = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        let remainder = s.count % 4
        if remainder > 0 { s += String(repeating: "=", count: 4 - remainder) }
        return Data(base64Encoded: s)
    }
}

/// Thin wrappers over CryptoKit that mirror `packages/core/src/crypto.ts`.
enum MPCrypto {
    static let gcmNonceLength = 12
    static let gcmTagLength = 16

    /// Cryptographically secure random bytes (`SecRandomCopyBytes`).
    static func randomBytes(_ count: Int) -> Data {
        var bytes = [UInt8](repeating: 0, count: count)
        let status = bytes.withUnsafeMutableBytes { buffer in
            SecRandomCopyBytes(kSecRandomDefault, count, buffer.baseAddress!)
        }
        if status != errSecSuccess {
            // SystemRandomNumberGenerator is also a CSPRNG on Apple platforms.
            var rng = SystemRandomNumberGenerator()
            for i in bytes.indices { bytes[i] = UInt8.random(in: .min ... .max, using: &rng) }
        }
        return Data(bytes)
    }

    static func sha256(_ data: Data) -> Data {
        Data(SHA256.hash(data: data))
    }

    static func hmacSHA256(key: Data, message: Data) -> Data {
        Data(HMAC<SHA256>.authenticationCode(for: message, using: SymmetricKey(data: key)))
    }

    static func hkdfSHA256(ikm: Data, salt: Data, info: Data, length: Int = 32) -> Data {
        let key = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: ikm),
            salt: salt,
            info: info,
            outputByteCount: length
        )
        return key.withUnsafeBytes { Data($0) }
    }

    /// AES-256-GCM. Output = nonce(12) ‖ ciphertext ‖ tag(16) — CryptoKit's "combined" representation.
    static func aesGCMSeal(key: Data, plaintext: Data, aad: Data, nonce: Data? = nil) throws -> Data {
        let gcmNonce = try nonce.map { try AES.GCM.Nonce(data: $0) } ?? AES.GCM.Nonce()
        let box = try AES.GCM.seal(plaintext, using: SymmetricKey(data: key), nonce: gcmNonce, authenticating: aad)
        guard let combined = box.combined else { throw CryptoKitError.incorrectParameterSize }
        return combined
    }

    /// Inverse of `aesGCMSeal`. Throws if the payload is truncated or authentication fails.
    static func aesGCMOpen(key: Data, sealed: Data, aad: Data) throws -> Data {
        guard sealed.count >= gcmNonceLength + gcmTagLength else { throw CryptoKitError.incorrectParameterSize }
        let box = try AES.GCM.SealedBox(combined: sealed)
        return try AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: aad)
    }

    /// Length-independent comparison for secrets of equal expected length.
    static func constantTimeEquals(_ a: String, _ b: String) -> Bool {
        let x = Array(a.utf8), y = Array(b.utf8)
        guard x.count == y.count else { return false }
        var diff: UInt8 = 0
        for i in x.indices { diff |= x[i] ^ y[i] }
        return diff == 0
    }
}
