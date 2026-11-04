package dev.modelpass.core

import kotlin.io.encoding.Base64

/**
 * RFC 4648 §5 base64url **without padding** (protocol §3).
 *
 * Uses the Kotlin stdlib codec rather than `java.util.Base64`, which only exists on Android API 26+
 * (this SDK supports API 24). The unit tests check it against `java.util.Base64` on the JVM.
 */
public object Base64Url {
    private val encoder = Base64.UrlSafe.withPadding(Base64.PaddingOption.ABSENT)
    private val decoder = Base64.UrlSafe.withPadding(Base64.PaddingOption.ABSENT_OPTIONAL)

    public fun encode(bytes: ByteArray): String = encoder.encode(bytes)

    /**
     * Decodes base64url with or without padding. The standard alphabet (`+`, `/`) is accepted too.
     * @throws IllegalArgumentException on malformed input.
     */
    public fun decode(text: String): ByteArray {
        val normalized = text.trim().replace('+', '-').replace('/', '_')
        return decoder.decode(normalized)
    }
}
