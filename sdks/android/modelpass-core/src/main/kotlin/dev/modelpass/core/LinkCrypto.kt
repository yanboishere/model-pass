package dev.modelpass.core

import java.security.GeneralSecurityException

/**
 * Cross-device "link" flow crypto (protocol §7). The QR code carries a one-time secret `s`; the
 * token response travels end-to-end encrypted through the rendezvous hub:
 *
 * ```
 * link_verifier  = base64url(HMAC-SHA256(key = s, msg = "modelpass/v1/link-verifier"))
 * link_challenge = base64url(SHA256(ASCII(link_verifier)))
 * K      = HKDF-SHA256(ikm = s, salt = "modelpass/v1", info = "link-seal", L = 32)
 * AAD    = "modelpass/v1/link/" + normalize(user_code)        // letters only, uppercased
 * sealed = base64url(nonce(12) ‖ AES-256-GCM(K, nonce, UTF8(JSON(T)), AAD))   // ‖ tag(16)
 * ```
 */
public object LinkCrypto {
    public const val VERIFIER_MESSAGE: String = "modelpass/v1/link-verifier"
    public const val KDF_SALT: String = "modelpass/v1"
    public const val KDF_INFO: String = "link-seal"
    public const val AAD_PREFIX: String = "modelpass/v1/link/"
    public const val SECRET_LENGTH: Int = 32

    public fun createSecret(): ByteArray = ModelPassCrypto.randomBytes(SECRET_LENGTH)

    public fun linkVerifier(secret: ByteArray): String =
        Base64Url.encode(ModelPassCrypto.hmacSha256(secret, VERIFIER_MESSAGE.encodeToByteArray()))

    /** Identical to the PKCE S256 transform. */
    public fun linkChallenge(verifier: String): String = Pkce.challengeS256(verifier)

    public fun sealKey(secret: ByteArray): ByteArray =
        ModelPassCrypto.hkdfSha256(secret, KDF_SALT.encodeToByteArray(), KDF_INFO.encodeToByteArray(), 32)

    /** Keeps ASCII letters only and uppercases them: `bcdf-ghjk` → `BCDFGHJK`. */
    public fun normalizeUserCode(userCode: String): String = buildString {
        for (c in userCode) if (c in 'A'..'Z' || c in 'a'..'z') append(c.uppercaseChar())
    }

    /** `BCDFGHJK` → `BCDF-GHJK` (8-letter codes only; others are returned normalized). */
    public fun formatUserCode(userCode: String): String {
        val n = normalizeUserCode(userCode)
        return if (n.length == 8) n.substring(0, 4) + "-" + n.substring(4) else n
    }

    public fun aad(userCode: String): ByteArray = (AAD_PREFIX + normalizeUserCode(userCode)).encodeToByteArray()

    /** Wallet side of §7.3; used by tests and by Kotlin wallets. */
    public fun seal(
        secret: ByteArray,
        userCode: String,
        plaintext: ByteArray,
        nonce: ByteArray = ModelPassCrypto.randomBytes(ModelPassCrypto.GCM_NONCE_LENGTH),
    ): String = Base64Url.encode(ModelPassCrypto.aesGcmSeal(sealKey(secret), plaintext, aad(userCode), nonce))

    /**
     * Decrypts a `modelpass_sealed` payload.
     * @throws ModelPassException.InvalidResponse if it is malformed or fails authentication.
     */
    public fun open(secret: ByteArray, userCode: String, sealed: String): ByteArray {
        val bytes = try {
            Base64Url.decode(sealed)
        } catch (e: IllegalArgumentException) {
            throw ModelPassException.InvalidResponse("modelpass_sealed is not valid base64url", e)
        }
        return try {
            ModelPassCrypto.aesGcmOpen(sealKey(secret), bytes, aad(userCode))
        } catch (e: GeneralSecurityException) {
            throw ModelPassException.InvalidResponse("Failed to decrypt the sealed link payload", e)
        } catch (e: IllegalArgumentException) {
            throw ModelPassException.InvalidResponse("Malformed sealed link payload", e)
        }
    }

    /** QR content: `{verification_uri}#v=1&uc=BCDF-GHJK&s={base64url(s)}` (§7.2). */
    public fun buildQrUrl(verificationUri: String, userCode: String, secret: ByteArray): String {
        val fragment = UrlCodec.encodeQuery(
            listOf("v" to "1", "uc" to formatUserCode(userCode), "s" to Base64Url.encode(secret)),
        )
        return "$verificationUri#$fragment"
    }

    /** `modelpass://link?rv={rendezvous}&uc={user_code}&s={base64url(s)}` (§7.2). */
    public fun buildWalletLinkUrl(
        rendezvous: String,
        userCode: String,
        secret: ByteArray,
        walletLinkUrl: String = ModelPassProtocol.DEFAULT_WALLET_LINK_URL,
    ): String {
        val query = UrlCodec.encodeQuery(
            listOf("rv" to rendezvous, "uc" to formatUserCode(userCode), "s" to Base64Url.encode(secret)),
        )
        return UrlCodec.appendQuery(walletLinkUrl, query)
    }
}
