package dev.modelpass.core

import dev.modelpass.core.TestVectors.string
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Test
import java.security.GeneralSecurityException
import java.util.Base64
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class CryptoTest {
    @Test
    fun `base64url matches java util Base64 for every length and round-trips`() {
        val reference = Base64.getUrlEncoder().withoutPadding()
        for (n in 0..64) {
            val bytes = ByteArray(n) { i -> (i * 37 + n).toByte() }
            val encoded = Base64Url.encode(bytes)
            assertEquals(reference.encodeToString(bytes), encoded, "length $n")
            assertTrue(encoded.all { it.isLetterOrDigit() || it == '-' || it == '_' })
            assertContentEquals(bytes, Base64Url.decode(encoded))
            // Padded and standard-alphabet input is accepted as well.
            assertContentEquals(bytes, Base64Url.decode(Base64.getUrlEncoder().encodeToString(bytes)))
            assertContentEquals(bytes, Base64Url.decode(Base64.getEncoder().encodeToString(bytes)))
        }
        assertFailsWith<IllegalArgumentException> { Base64Url.decode("a") }
        assertFailsWith<IllegalArgumentException> { Base64Url.decode("ab!d") }
    }

    @Test
    fun `PKCE matches RFC 7636 appendix B and the shared vector`() {
        val rfc = TestVectors.pkce.getValue("rfc7636_appendix_b").jsonObject
        assertEquals(rfc.string("code_challenge"), Pkce.challengeS256(rfc.string("code_verifier")))
        assertEquals("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", Pkce.challengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"))

        val vector = TestVectors.pkce
        assertEquals(Base64Url.encode(ByteArray(32) { it.toByte() }), vector.string("code_verifier"))
        assertEquals(vector.string("code_challenge"), Pkce.challengeS256(vector.string("code_verifier")))
    }

    @Test
    fun `generated verifier and state have the expected shape`() {
        val verifier = Pkce.createVerifier()
        assertEquals(43, verifier.length)
        assertTrue(Pkce.isValidVerifier(verifier))
        assertTrue(Pkce.verify(verifier, Pkce.challengeS256(verifier)))
        assertFalse(Pkce.verify(verifier, Pkce.challengeS256(verifier + "x")))
        assertFalse(Pkce.isValidVerifier("short"))
        assertEquals(22, Pkce.createState().length) // 16 bytes = 128 bit
        assertTrue(Pkce.createVerifier() != Pkce.createVerifier())
    }

    @Test
    fun `HKDF-SHA256 matches RFC 5869 test cases 1 and 3`() {
        val case1 = ModelPassCrypto.hkdfSha256(
            ikm = fromHex("0b".repeat(22)),
            salt = fromHex("000102030405060708090a0b0c"),
            info = fromHex("f0f1f2f3f4f5f6f7f8f9"),
            length = 42,
        )
        assertEquals("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865", case1.hex())

        val case3 = ModelPassCrypto.hkdfSha256(fromHex("0b".repeat(22)), ByteArray(0), ByteArray(0), 42)
        assertEquals("8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8", case3.hex())
    }

    @Test
    fun `HMAC-SHA256 matches RFC 4231 test case 2`() {
        val mac = ModelPassCrypto.hmacSha256("Jefe".encodeToByteArray(), "what do ya want for nothing?".encodeToByteArray())
        assertEquals("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843", mac.hex())
    }

    @Test
    fun `AES-256-GCM seals and authenticates`() {
        val key = ModelPassCrypto.randomBytes(32)
        val sealed = ModelPassCrypto.aesGcmSeal(key, "hello 世界".encodeToByteArray(), "aad".encodeToByteArray())
        assertEquals(12 + "hello 世界".encodeToByteArray().size + 16, sealed.size)
        assertEquals("hello 世界", ModelPassCrypto.aesGcmOpen(key, sealed, "aad".encodeToByteArray()).decodeToString())
        assertFailsWith<GeneralSecurityException> { ModelPassCrypto.aesGcmOpen(key, sealed, "other".encodeToByteArray()) }
        val tampered = sealed.copyOf().also { it[20] = (it[20].toInt() xor 1).toByte() }
        assertFailsWith<GeneralSecurityException> { ModelPassCrypto.aesGcmOpen(key, tampered, "aad".encodeToByteArray()) }
    }
}
