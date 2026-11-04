package dev.modelpass.core

import dev.modelpass.core.TestVectors.string
import org.junit.jupiter.api.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class LinkCryptoTest {
    private val v = TestVectors.link
    private val secret = fromHex(v.string("secret_hex"))
    private val userCode = v.string("user_code")

    @Test
    fun `secret encodes to the vector`() {
        assertContentEquals(ByteArray(32) { (0xa0 + it).toByte() }, secret)
        assertEquals(v.string("secret_b64url"), Base64Url.encode(secret))
    }

    @Test
    fun `link verifier and challenge match the vector`() {
        val verifier = LinkCrypto.linkVerifier(secret)
        assertEquals(v.string("link_verifier"), verifier)
        assertEquals(v.string("link_challenge"), LinkCrypto.linkChallenge(verifier))
    }

    @Test
    fun `HKDF seal key and AAD match the vector`() {
        assertEquals(v.string("seal_key_hex"), LinkCrypto.sealKey(secret).hex())
        assertEquals(v.string("aad"), LinkCrypto.aad(userCode).decodeToString())
        assertEquals("modelpass/v1/link/BCDFGHJK", LinkCrypto.aad("bcdf ghjk").decodeToString())
    }

    @Test
    fun `decrypts sealed_b64url to payload_json byte for byte`() {
        val plaintext = LinkCrypto.open(secret, userCode, v.string("sealed_b64url"))
        assertContentEquals(v.string("payload_json").encodeToByteArray(), plaintext)

        val token = TokenResponse.parse(plaintext.decodeToString())
        assertEquals("mpk_test-vector-token", token.accessToken)
        assertEquals("g_testvector000001", token.grantId)
        assertEquals("默认", token.slots.single().label)
    }

    @Test
    fun `sealing with the vector nonce reproduces sealed_b64url`() {
        val sealed = LinkCrypto.seal(
            secret,
            userCode,
            v.string("payload_json").encodeToByteArray(),
            nonce = fromHex(v.string("nonce_hex")),
        )
        assertEquals(v.string("sealed_b64url"), sealed)
        assertTrue(Base64Url.decode(sealed).copyOfRange(0, 12).contentEquals(fromHex(v.string("nonce_hex"))))
    }

    @Test
    fun `user code is normalized for the AAD, so formatting differences still decrypt`() {
        val plaintext = LinkCrypto.open(secret, "bcdfghjk", v.string("sealed_b64url"))
        assertEquals(v.string("payload_json"), plaintext.decodeToString())
    }

    @Test
    fun `wrong secret, wrong user code or tampering is rejected`() {
        val sealed = v.string("sealed_b64url")
        assertFailsWith<ModelPassException.InvalidResponse> { LinkCrypto.open(LinkCrypto.createSecret(), userCode, sealed) }
        assertFailsWith<ModelPassException.InvalidResponse> { LinkCrypto.open(secret, "BBBB-BBBB", sealed) }
        val bytes = Base64Url.decode(sealed).also { it[it.size - 1] = (it[it.size - 1].toInt() xor 0x01).toByte() }
        assertFailsWith<ModelPassException.InvalidResponse> { LinkCrypto.open(secret, userCode, Base64Url.encode(bytes)) }
        assertFailsWith<ModelPassException.InvalidResponse> { LinkCrypto.open(secret, userCode, "not base64!") }
        assertFailsWith<ModelPassException.InvalidResponse> { LinkCrypto.open(secret, userCode, "AAAA") }
    }

    @Test
    fun `QR URL matches the vector and the wallet deep link is well formed`() {
        assertEquals(v.string("qr_example"), LinkCrypto.buildQrUrl("https://hub.example.com/link", userCode, secret))
        assertEquals(v.string("qr_example"), LinkCrypto.buildQrUrl("https://hub.example.com/link", "bcdfghjk", secret))
        assertEquals(
            "modelpass://link?rv=https%3A%2F%2Fhub.example.com&uc=BCDF-GHJK&s=${v.string("secret_b64url")}",
            LinkCrypto.buildWalletLinkUrl("https://hub.example.com", userCode, secret),
        )
    }

    @Test
    fun `user code normalization and formatting`() {
        assertEquals("BCDFGHJK", LinkCrypto.normalizeUserCode("bcdf-ghjk"))
        assertEquals("BCDFGHJK", LinkCrypto.normalizeUserCode(" B C D F 1 2 G H J K "))
        assertEquals("BCDF-GHJK", LinkCrypto.formatUserCode("bcdfghjk"))
        assertEquals("ABC", LinkCrypto.formatUserCode("a-b-c"))
    }
}
