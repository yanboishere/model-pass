package dev.modelpass.core

import java.io.ByteArrayOutputStream

/**
 * URL helpers that behave the same on the JVM and on Android (and like the TypeScript reference,
 * which uses `encodeURIComponent`). Works with custom schemes such as `modelpass://authorize`.
 */
public object UrlCodec {
    private const val UNRESERVED = "-_.!~*'()"
    private const val HEX = "0123456789ABCDEF"

    /** Percent-encodes like JavaScript's `encodeURIComponent` (UTF-8, space → `%20`). */
    public fun encodeComponent(value: String): String {
        val bytes = value.encodeToByteArray()
        val out = StringBuilder(bytes.size + 8)
        for (b in bytes) {
            val c = (b.toInt() and 0xff).toChar()
            if (c in 'A'..'Z' || c in 'a'..'z' || c in '0'..'9' || c in UNRESERVED) {
                out.append(c)
            } else {
                val v = b.toInt() and 0xff
                out.append('%').append(HEX[v shr 4]).append(HEX[v and 0x0f])
            }
        }
        return out.toString()
    }

    /**
     * Decodes `%XX` escapes (UTF-8). `+` is decoded as a space by default, matching
     * `application/x-www-form-urlencoded` and the reference implementation.
     * @throws IllegalArgumentException on malformed escapes.
     */
    public fun decodeComponent(value: String, plusAsSpace: Boolean = true): String {
        if (value.none { it == '%' || (plusAsSpace && it == '+') }) return value
        val out = ByteArrayOutputStream(value.length)
        var i = 0
        while (i < value.length) {
            val c = value[i]
            when {
                c == '%' -> {
                    require(i + 2 < value.length) { "Malformed percent-encoding in URL" }
                    val hi = Character.digit(value[i + 1], 16)
                    val lo = Character.digit(value[i + 2], 16)
                    require(hi >= 0 && lo >= 0) { "Malformed percent-encoding in URL" }
                    out.write((hi shl 4) or lo)
                    i += 3
                }
                c == '+' && plusAsSpace -> {
                    out.write(' '.code)
                    i++
                }
                else -> {
                    // Copy a run of literal characters (may include non-ASCII) as UTF-8.
                    val start = i
                    while (i < value.length && value[i] != '%' && !(plusAsSpace && value[i] == '+')) i++
                    out.write(value.substring(start, i).encodeToByteArray())
                }
            }
        }
        return out.toByteArray().decodeToString()
    }

    /** `k1=v1&k2=v2`; entries with a null or empty value are skipped (like the reference `encodeQuery`). */
    public fun encodeQuery(params: List<Pair<String, String?>>): String =
        params.filter { !it.second.isNullOrEmpty() }
            .joinToString("&") { (k, v) -> "${encodeComponent(k)}=${encodeComponent(v!!)}" }

    /** Parses `a=1&b=2&a=3` into all values per key (in order). A leading `?` or `#` is ignored. */
    public fun parseQueryValues(query: String): Map<String, List<String>> {
        val out = LinkedHashMap<String, MutableList<String>>()
        for (part in query.removePrefix("?").removePrefix("#").split('&')) {
            if (part.isEmpty()) continue
            val eq = part.indexOf('=')
            val key = decodeComponent(if (eq < 0) part else part.substring(0, eq))
            val value = if (eq < 0) "" else decodeComponent(part.substring(eq + 1))
            out.getOrPut(key) { mutableListOf() }.add(value)
        }
        return out
    }

    /** Query parameters of any URL (custom schemes included). Later duplicates are ignored. */
    public fun queryParameters(url: String): Map<String, String> =
        queryParameterValues(url).mapValues { it.value.first() }

    public fun queryParameterValues(url: String): Map<String, List<String>> {
        val withoutFragment = url.substringBefore('#')
        val q = withoutFragment.indexOf('?')
        return if (q < 0) emptyMap() else parseQueryValues(withoutFragment.substring(q + 1))
    }

    /** Appends an encoded query to a URL that may already contain a query string and/or fragment. */
    public fun appendQuery(url: String, query: String): String {
        if (query.isEmpty()) return url
        val hash = url.indexOf('#')
        val base = if (hash >= 0) url.substring(0, hash) else url
        val fragment = if (hash >= 0) url.substring(hash) else ""
        val separator = when {
            !base.contains('?') -> "?"
            base.endsWith("?") || base.endsWith("&") -> ""
            else -> "&"
        }
        return base + separator + query + fragment
    }

    /** Joins a base URL and a path (`https://hub/v1` + `/chat/completions`). */
    public fun join(base: String, path: String): String = base.trimEnd('/') + "/" + path.trimStart('/')
}
