package dev.modelpass.core

import java.net.URI
import java.net.URISyntaxException

/**
 * Decides which hubs (`iss`, RFC 9207) the app accepts (protocol §3, §6.2, §13.2).
 *
 * - `https://` is required, except `http://` to local development hosts (`localhost`, `127.x`,
 *   `::1`, `10.x`, `192.168.x`, `172.16–31.x`, `*.local`) when [allowLocalHttp] is true.
 * - If [trustedIssuers] is non-empty, the issuer must be one of them (after normalization).
 */
public class IssuerPolicy(
    trustedIssuers: Collection<String>? = null,
    public val allowLocalHttp: Boolean = true,
) {
    /** Normalized allowlist, or null when any acceptable issuer is allowed. */
    public val trustedIssuers: Set<String>? = trustedIssuers
        ?.takeIf { it.isNotEmpty() }
        ?.map { normalizeOrNull(it) ?: throw IllegalArgumentException("Invalid trusted issuer URL: $it") }
        ?.toSet()

    /**
     * Validates an issuer and returns its normalized form (lowercase scheme/host, no default port,
     * no trailing slash).
     * @throws ModelPassException.UntrustedIssuer
     */
    public fun validate(issuer: String): String {
        val normalized = normalizeOrNull(issuer)
            ?: throw ModelPassException.UntrustedIssuer(issuer, "not an absolute http(s) URL without query, fragment or user info")
        if (!isSecureUrl(normalized)) {
            throw ModelPassException.UntrustedIssuer(issuer, "https is required (http is only allowed for local development hosts)")
        }
        val allowlist = trustedIssuers
        if (allowlist != null && normalized !in allowlist) {
            throw ModelPassException.UntrustedIssuer(issuer, "not in the app's trusted issuer list")
        }
        return normalized
    }

    /** True for `https://` URLs, and `http://` URLs to local development hosts if allowed. */
    public fun isSecureUrl(url: String): Boolean {
        val uri = try {
            URI(url.trim())
        } catch (e: URISyntaxException) {
            return false
        }
        val host = uri.host ?: return false
        return when (uri.scheme?.lowercase()) {
            "https" -> true
            "http" -> allowLocalHttp && isLocalDevelopmentHost(host)
            else -> false
        }
    }

    public companion object {
        /** Any https issuer; http allowed for local development hosts. */
        @JvmField
        public val Default: IssuerPolicy = IssuerPolicy()

        /** Returns `scheme://host[:port][/path]` (lowercased scheme/host) or null if not a valid issuer URL. */
        @JvmStatic
        public fun normalizeOrNull(issuer: String): String? {
            val uri = try {
                URI(issuer.trim())
            } catch (e: URISyntaxException) {
                return null
            }
            val scheme = uri.scheme?.lowercase() ?: return null
            if (scheme != "https" && scheme != "http") return null
            if (uri.isOpaque || uri.rawUserInfo != null || uri.rawQuery != null || uri.rawFragment != null) return null
            val host = uri.host?.lowercase()?.takeIf { it.isNotEmpty() } ?: return null
            val defaultPort = if (scheme == "https") 443 else 80
            val port = if (uri.port == -1 || uri.port == defaultPort) "" else ":${uri.port}"
            val path = (uri.rawPath ?: "").trimEnd('/')
            return "$scheme://$host$port$path"
        }

        /** `localhost`, loopback, RFC 1918 private IPv4 ranges and mDNS `*.local` names. */
        @JvmStatic
        public fun isLocalDevelopmentHost(host: String): Boolean {
            val h = host.lowercase().removePrefix("[").removeSuffix("]")
            if (h == "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h == "::1") return true
            val parts = h.split('.')
            if (parts.size != 4) return false
            val octets = parts.map { part -> part.toIntOrNull()?.takeIf { it in 0..255 } ?: return false }
            return octets[0] == 127 || octets[0] == 10 ||
                (octets[0] == 192 && octets[1] == 168) ||
                (octets[0] == 172 && octets[1] in 16..31)
        }
    }
}
