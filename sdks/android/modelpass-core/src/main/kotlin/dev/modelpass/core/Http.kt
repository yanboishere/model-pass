package dev.modelpass.core

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URI

internal class HttpResponse(val status: Int, private val headers: Map<String, List<String>>, val body: ByteArray) {
    val isSuccessful: Boolean get() = status in 200..299
    val text: String get() = body.decodeToString()
    fun header(name: String): String? = headers.entries.firstOrNull { it.key.equals(name, ignoreCase = true) }?.value?.firstOrNull()
}

/**
 * Tiny HTTP layer over `java.net.HttpURLConnection` (no OkHttp dependency).
 *
 * Blocking I/O runs in [background] on [dispatcher], detached from the caller: when the caller is
 * cancelled it is released immediately and the connection is disconnected off-thread. On Android
 * (OkHttp-backed `HttpURLConnection`) `disconnect()` closes the socket so the blocked read ends at
 * once; on desktop JDKs a blocked chunked read can only end when data arrives or the read timeout
 * elapses (`disconnect()` waits for it there), which is why it must never run on the caller's thread.
 */
internal class HttpTransport(
    private val connectTimeoutMillis: Int,
    private val userAgent: String,
    dispatcher: CoroutineDispatcher,
) {
    val background: CoroutineScope =
        CoroutineScope(SupervisorJob() + dispatcher + CoroutineExceptionHandler { _, _ -> /* reported via the caller */ })

    fun open(url: String, method: String, headers: Map<String, String>, readTimeoutMillis: Int): HttpURLConnection {
        val connection = try {
            URI(url).toURL().openConnection()
        } catch (e: IllegalArgumentException) {
            throw ModelPassException.InvalidResponse("Invalid URL: $url", e)
        } catch (e: java.net.URISyntaxException) {
            throw ModelPassException.InvalidResponse("Invalid URL: $url", e)
        } catch (e: java.net.MalformedURLException) {
            throw ModelPassException.InvalidResponse("Invalid URL: $url", e)
        }
        val conn = connection as? HttpURLConnection ?: throw ModelPassException.InvalidResponse("Not an http(s) URL: $url")
        conn.requestMethod = method
        // Never follow redirects: that could forward the bearer token to another host.
        conn.instanceFollowRedirects = false
        conn.useCaches = false
        conn.connectTimeout = connectTimeoutMillis
        conn.readTimeout = readTimeoutMillis
        conn.setRequestProperty("User-Agent", userAgent)
        for ((name, value) in headers) conn.setRequestProperty(name, value)
        return conn
    }

    /** Sends the body (if any). Not using streaming mode keeps 401 bodies readable on the JDK. */
    fun writeBody(conn: HttpURLConnection, body: ByteArray?, contentType: String?) {
        if (body == null) return
        conn.doOutput = true
        if (contentType != null) conn.setRequestProperty("Content-Type", contentType)
        conn.outputStream.use { it.write(body) }
    }

    /** Disconnects without blocking the calling thread. */
    fun disconnectInBackground(conn: HttpURLConnection) {
        background.launch { conn.disconnect() }
    }

    suspend fun execute(
        url: String,
        method: String,
        headers: Map<String, String> = emptyMap(),
        body: ByteArray? = null,
        contentType: String? = null,
        readTimeoutMillis: Int,
    ): HttpResponse {
        val conn = open(url, method, headers, readTimeoutMillis)
        return try {
            runCancellable(conn) {
                try {
                    writeBody(conn, body, contentType)
                    val status = conn.responseCode
                    if (status < 0) throw ModelPassException.InvalidResponse("Invalid HTTP response from $url")
                    val stream = if (status >= 400) conn.errorStream else conn.inputStream
                    val bytes = stream?.use { readLimited(it) } ?: ByteArray(0)
                    val responseHeaders = conn.headerFields.entries
                        .filter { it.key != null }
                        .associate { it.key to it.value.orEmpty() }
                    HttpResponse(status, responseHeaders, bytes)
                } finally {
                    conn.disconnect()
                }
            }
        } catch (e: IOException) {
            throw ModelPassException.Network(e)
        }
    }

    /** Runs blocking connection work in [background]; if the caller is cancelled, disconnects [conn]. */
    suspend fun <T> runCancellable(conn: HttpURLConnection, block: () -> T): T {
        val task = background.async { block() }
        try {
            return task.await()
        } catch (e: CancellationException) {
            if (!task.isCompleted) {
                task.cancel()
                disconnectInBackground(conn)
            }
            throw e
        }
    }

    companion object {
        const val MAX_BODY_BYTES: Int = 16 * 1024 * 1024

        fun readLimited(input: InputStream, limit: Int = MAX_BODY_BYTES): ByteArray {
            val out = ByteArrayOutputStream()
            val buffer = ByteArray(8192)
            while (true) {
                val n = input.read(buffer)
                if (n < 0) break
                out.write(buffer, 0, n)
                if (out.size() > limit) throw ModelPassException.InvalidResponse("Response body exceeds $limit bytes")
            }
            return out.toByteArray()
        }
    }
}

/** Error details from either `{"error":{"message","type","code"}}` (§8.7) or `{"error":"…","error_description":"…"}` (RFC 6749). */
internal data class ErrorBody(val code: String?, val message: String?, val type: String?)

internal fun parseErrorBody(text: String): ErrorBody? {
    val obj = try {
        ModelPassJson.parseToJsonElement(text) as? JsonObject
    } catch (e: SerializationException) {
        null
    } ?: return null
    return errorBodyOf(obj)
}

private fun errorBodyOf(obj: JsonObject): ErrorBody? = when (val error = obj["error"]) {
    is JsonObject -> ErrorBody(
        code = (error["code"] as? JsonPrimitive)?.contentOrNull ?: (error["type"] as? JsonPrimitive)?.contentOrNull,
        message = (error["message"] as? JsonPrimitive)?.contentOrNull,
        type = (error["type"] as? JsonPrimitive)?.contentOrNull,
    )
    is JsonPrimitive -> error.contentOrNull?.let { code ->
        ErrorBody(code = code, message = (obj["error_description"] as? JsonPrimitive)?.contentOrNull, type = null)
    }
    else -> null
}

internal fun apiErrorFromJson(status: Int, obj: JsonObject): ModelPassException.Api {
    val err = errorBodyOf(obj)
    return ModelPassException.Api(status, err?.code, err?.message ?: err?.code ?: "HTTP $status", err?.type)
}

internal fun apiError(response: HttpResponse): ModelPassException.Api = apiError(response.status, response.text)

internal fun apiError(status: Int, body: String): ModelPassException.Api {
    val err = parseErrorBody(body)
    val message = err?.message ?: err?.code ?: body.take(200).ifBlank { "HTTP $status" }
    return ModelPassException.Api(status, err?.code, message, err?.type)
}

/** RFC 6749 §5.2 error of a token-style endpoint. */
internal data class OAuthError(val error: String, val description: String?)

internal fun oauthError(response: HttpResponse): OAuthError {
    val err = parseErrorBody(response.text)
    return OAuthError(err?.code ?: "http_${response.status}", err?.message)
}
