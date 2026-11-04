package dev.modelpass.core

import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** Cryptographic primitives used by the protocol, built on `java.security` / `javax.crypto` only. */
public object ModelPassCrypto {
    public const val GCM_NONCE_LENGTH: Int = 12
    public const val GCM_TAG_BITS: Int = 128
    private const val HMAC_SHA256 = "HmacSHA256"
    private const val SHA256_LENGTH = 32

    private val secureRandom: SecureRandom by lazy { SecureRandom() }

    public fun randomBytes(size: Int): ByteArray = ByteArray(size).also { secureRandom.nextBytes(it) }

    public fun sha256(data: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(data)

    public fun hmacSha256(key: ByteArray, message: ByteArray): ByteArray {
        val mac = Mac.getInstance(HMAC_SHA256)
        // SecretKeySpec rejects empty keys; HMAC pads short keys with zeros, so this is equivalent.
        mac.init(SecretKeySpec(if (key.isEmpty()) ByteArray(SHA256_LENGTH) else key, HMAC_SHA256))
        return mac.doFinal(message)
    }

    /** HKDF-SHA256 (RFC 5869): extract-then-expand. */
    public fun hkdfSha256(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int = 32): ByteArray {
        require(length in 0..255 * SHA256_LENGTH) { "HKDF-SHA256 output length must be <= ${255 * SHA256_LENGTH}" }
        val prk = hmacSha256(if (salt.isEmpty()) ByteArray(SHA256_LENGTH) else salt, ikm)
        val mac = Mac.getInstance(HMAC_SHA256).apply { init(SecretKeySpec(prk, HMAC_SHA256)) }
        val okm = ByteArray(length)
        var previous = ByteArray(0)
        var offset = 0
        var counter = 1
        while (offset < length) {
            mac.update(previous)
            mac.update(info)
            mac.update(counter.toByte())
            previous = mac.doFinal()
            val n = minOf(previous.size, length - offset)
            System.arraycopy(previous, 0, okm, offset, n)
            offset += n
            counter++
        }
        return okm
    }

    /** AES-256-GCM. Output = nonce(12) ‖ ciphertext ‖ tag(16). */
    public fun aesGcmSeal(
        key: ByteArray,
        plaintext: ByteArray,
        aad: ByteArray,
        nonce: ByteArray = randomBytes(GCM_NONCE_LENGTH),
    ): ByteArray {
        require(key.size == 32) { "AES-256-GCM requires a 32-byte key" }
        require(nonce.size == GCM_NONCE_LENGTH) { "AES-GCM nonce must be $GCM_NONCE_LENGTH bytes" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(GCM_TAG_BITS, nonce))
        cipher.updateAAD(aad)
        return nonce + cipher.doFinal(plaintext)
    }

    /**
     * Inverse of [aesGcmSeal].
     * @throws java.security.GeneralSecurityException if authentication fails.
     */
    public fun aesGcmOpen(key: ByteArray, sealed: ByteArray, aad: ByteArray): ByteArray {
        require(key.size == 32) { "AES-256-GCM requires a 32-byte key" }
        require(sealed.size >= GCM_NONCE_LENGTH + GCM_TAG_BITS / 8) { "sealed payload too short" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.DECRYPT_MODE,
            SecretKeySpec(key, "AES"),
            GCMParameterSpec(GCM_TAG_BITS, sealed, 0, GCM_NONCE_LENGTH),
        )
        cipher.updateAAD(aad)
        return cipher.doFinal(sealed, GCM_NONCE_LENGTH, sealed.size - GCM_NONCE_LENGTH)
    }

    /** Constant-time comparison for secrets such as `state`. */
    public fun constantTimeEquals(a: String, b: String): Boolean =
        MessageDigest.isEqual(a.encodeToByteArray(), b.encodeToByteArray())
}
