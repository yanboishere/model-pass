package dev.modelpass.core

/** PKCE (RFC 7636) with the S256 method, plus the OAuth `state` generator. */
public object Pkce {
    /** 32 random bytes → 43-character base64url string (RFC 7636 §4.1). */
    public fun createVerifier(): String = Base64Url.encode(ModelPassCrypto.randomBytes(32))

    /** `base64url(SHA256(ASCII(verifier)))`. Also used for the link flow's `link_challenge`. */
    public fun challengeS256(verifier: String): String =
        Base64Url.encode(ModelPassCrypto.sha256(verifier.toByteArray(Charsets.US_ASCII)))

    /** 128-bit random `state` (protocol §6.1). */
    public fun createState(): String = Base64Url.encode(ModelPassCrypto.randomBytes(16))

    /** RFC 7636 §4.1: 43–128 characters from `[A-Za-z0-9-._~]`. */
    public fun isValidVerifier(verifier: String): Boolean =
        verifier.length in 43..128 && verifier.all { it in 'A'..'Z' || it in 'a'..'z' || it in '0'..'9' || it in "-._~" }

    public fun verify(verifier: String, challenge: String): Boolean =
        isValidVerifier(verifier) && ModelPassCrypto.constantTimeEquals(challengeS256(verifier), challenge)
}
