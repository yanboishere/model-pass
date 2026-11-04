import CryptoKit
import XCTest
@testable import ModelPassSDK

/// Byte-for-byte checks against docs/test-vectors.json and the relevant RFCs.
final class CryptoVectorTests: XCTestCase {
    // MARK: base64url

    func testBase64URLRoundTripsEveryLength() {
        for length in 0 ..< 40 {
            let bytes = Data((0 ..< length).map { UInt8(($0 * 37 + length) & 0xFF) })
            let encoded = Base64URL.encode(bytes)
            XCTAssertNil(encoded.rangeOfCharacter(from: CharacterSet(charactersIn: "+/=")), encoded)
            XCTAssertEqual(Base64URL.decode(encoded), bytes)
            let standard = bytes.base64EncodedString()
                .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
                .replacingOccurrences(of: "=", with: "")
            XCTAssertEqual(encoded, standard)
        }
    }

    func testBase64URLDecodeAcceptsPaddingAndStandardAlphabetAndRejectsGarbage() {
        XCTAssertEqual(Base64URL.decode("-_8="), Data([0xFB, 0xFF]))
        XCTAssertEqual(Base64URL.decode("+/8"), Data([0xFB, 0xFF]))
        XCTAssertNil(Base64URL.decode("abcde")) // length % 4 == 1
        XCTAssertNil(Base64URL.decode("ab$d"))
    }

    // MARK: PKCE (RFC 7636)

    func testPKCEMatchesRFC7636AppendixB() {
        XCTAssertEqual(PKCE.challenge(for: TestVectors.rfc7636CodeVerifier), TestVectors.rfc7636CodeChallenge)
    }

    func testPKCEVectorFromSequentialBytes() {
        let verifier = Base64URL.encode(Data((0 ..< 32).map { UInt8($0) }))
        XCTAssertEqual(verifier, TestVectors.pkceCodeVerifier)
        XCTAssertEqual(PKCE.challenge(for: verifier), TestVectors.pkceCodeChallenge)
    }

    func testGeneratedVerifierAndState() {
        let verifier = PKCE.makeVerifier()
        XCTAssertEqual(verifier.count, 43)
        XCTAssertTrue(verifier.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") })
        XCTAssertNotEqual(verifier, PKCE.makeVerifier())
        XCTAssertEqual(PKCE.makeState().count, 22) // 128 bit
        XCTAssertEqual(MPCrypto.randomBytes(32).count, 32)
    }

    // MARK: HKDF (RFC 5869)

    func testHKDFMatchesRFC5869TestCase1() {
        let okm = MPCrypto.hkdfSHA256(
            ikm: Data(hex: String(repeating: "0b", count: 22)),
            salt: Data(hex: "000102030405060708090a0b0c"),
            info: Data(hex: "f0f1f2f3f4f5f6f7f8f9"),
            length: 42
        )
        XCTAssertEqual(okm.hex, "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865")
    }

    // MARK: Link flow (§7)

    private var secret: Data { Data(hex: TestVectors.linkSecretHex) }

    func testLinkSecretVerifierAndChallenge() {
        XCTAssertEqual(Base64URL.encode(secret), TestVectors.linkSecretB64url)
        XCTAssertEqual(LinkCrypto.verifier(secret: secret), TestVectors.linkVerifier)
        XCTAssertEqual(LinkCrypto.challenge(verifier: TestVectors.linkVerifier), TestVectors.linkChallenge)
    }

    func testLinkSealKeyAndAAD() {
        XCTAssertEqual(LinkCrypto.sealKey(secret: secret).hex, TestVectors.linkSealKeyHex)
        XCTAssertEqual(String(decoding: LinkCrypto.aad(userCode: TestVectors.linkUserCode), as: UTF8.self), TestVectors.linkAAD)
        XCTAssertEqual(LinkCrypto.normalizeUserCode("bcdf-ghjk"), "BCDFGHJK")
        XCTAssertEqual(LinkCrypto.normalizeUserCode(" B C D F – G H J K 1 "), "BCDFGHJK")
        XCTAssertEqual(LinkCrypto.formatUserCode("bcdfghjk"), "BCDF-GHJK")
        XCTAssertEqual(LinkCrypto.formatUserCode("bcd"), "BCD")
    }

    func testOpensTheSealedVectorPayload() throws {
        let plaintext = try LinkCrypto.open(secret: secret, userCode: TestVectors.linkUserCode, sealed: TestVectors.linkSealedB64url)
        XCTAssertEqual(plaintext, Data(TestVectors.linkPayloadJSON.utf8))
        // The AAD only depends on the letters of the user code.
        XCTAssertEqual(try LinkCrypto.open(secret: secret, userCode: "bcdfghjk", sealed: TestVectors.linkSealedB64url), plaintext)

        let token = try TokenResponse.decode(plaintext)
        XCTAssertEqual(token.accessToken, "mpk_test-vector-token")
        XCTAssertEqual(token.grantId, "g_testvector000001")
        XCTAssertEqual(token.slots?.first, ModelPassSlot(id: "default", label: "默认"))
    }

    func testSealingWithTheVectorNonceReproducesTheVectorByteForByte() throws {
        let sealed = try LinkCrypto.seal(
            secret: secret,
            userCode: TestVectors.linkUserCode,
            plaintext: Data(TestVectors.linkPayloadJSON.utf8),
            nonce: Data(hex: TestVectors.linkNonceHex)
        )
        XCTAssertEqual(sealed, TestVectors.linkSealedB64url)
        let raw = try XCTUnwrap(Base64URL.decode(sealed))
        XCTAssertEqual(raw.prefix(12).hex, TestVectors.linkNonceHex) // nonce ‖ ciphertext ‖ tag
        XCTAssertEqual(raw.count, 12 + Data(TestVectors.linkPayloadJSON.utf8).count + 16)
    }

    func testTamperedOrMisdirectedPayloadsAreRejected() throws {
        XCTAssertThrowsError(try LinkCrypto.open(secret: Data(repeating: 7, count: 32), userCode: TestVectors.linkUserCode,
                                                 sealed: TestVectors.linkSealedB64url))
        XCTAssertThrowsError(try LinkCrypto.open(secret: secret, userCode: "BBBB-BBBB", sealed: TestVectors.linkSealedB64url))
        var raw = try XCTUnwrap(Base64URL.decode(TestVectors.linkSealedB64url))
        raw[20] ^= 0x01
        XCTAssertThrowsError(try LinkCrypto.open(secret: secret, userCode: TestVectors.linkUserCode, sealed: Base64URL.encode(raw)))
        XCTAssertThrowsError(try LinkCrypto.open(secret: secret, userCode: TestVectors.linkUserCode, sealed: "AAAA"))
        XCTAssertThrowsError(try LinkCrypto.open(secret: secret, userCode: TestVectors.linkUserCode, sealed: "!!"))
    }

    func testQRAndWalletLinkURLs() {
        let qr = LinkCrypto.qrURL(verificationURI: "https://hub.example.com/link", userCode: "bcdf-ghjk", secret: secret)
        XCTAssertEqual(qr?.absoluteString, TestVectors.linkQRExample)
        let wallet = LinkCrypto.walletURL(rendezvous: "http://192.168.1.5:8787", userCode: "BCDFGHJK", secret: secret)
        XCTAssertEqual(wallet?.absoluteString,
                       "modelpass://link?rv=http%3A%2F%2F192.168.1.5%3A8787&uc=BCDF-GHJK&s=\(TestVectors.linkSecretB64url)")
    }

    func testAESGCMRoundTripAndCombinedLayout() throws {
        let key = Data(repeating: 0x42, count: 32)
        let sealed = try MPCrypto.aesGCMSeal(key: key, plaintext: Data("模型通行证 🚀".utf8), aad: Data("aad".utf8))
        XCTAssertEqual(sealed.count, 12 + Data("模型通行证 🚀".utf8).count + 16)
        XCTAssertEqual(try MPCrypto.aesGCMOpen(key: key, sealed: sealed, aad: Data("aad".utf8)), Data("模型通行证 🚀".utf8))
        XCTAssertThrowsError(try MPCrypto.aesGCMOpen(key: key, sealed: sealed, aad: Data("other".utf8)))
        XCTAssertThrowsError(try MPCrypto.aesGCMOpen(key: key, sealed: Data(count: 27), aad: Data()))
    }

    func testConstantTimeEquals() {
        XCTAssertTrue(MPCrypto.constantTimeEquals("abc", "abc"))
        XCTAssertFalse(MPCrypto.constantTimeEquals("abc", "abd"))
        XCTAssertFalse(MPCrypto.constantTimeEquals("abc", "abcd"))
    }
}
