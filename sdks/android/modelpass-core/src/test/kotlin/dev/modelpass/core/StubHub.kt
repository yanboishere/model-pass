package dev.modelpass.core

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/** A scriptable fake ModelPass hub on 127.0.0.1 built on the JDK's `com.sun.net.httpserver`. */
internal class StubHub : AutoCloseable {
    class Request(
        val method: String,
        val path: String,
        private val headers: Map<String, List<String>>,
        val body: String,
    ) {
        val form: Map<String, String> get() = UrlCodec.parseQueryValues(body).mapValues { it.value.single() }
        fun header(name: String): String? = headers.entries.firstOrNull { it.key.equals(name, ignoreCase = true) }?.value?.firstOrNull()
    }

    private val executor: ExecutorService = Executors.newCachedThreadPool()
    private val server: HttpServer = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    private val routes = ConcurrentHashMap<String, (Request, HttpExchange) -> Unit>()
    val requests = CopyOnWriteArrayList<Request>()

    val base: String get() = "http://127.0.0.1:${server.address.port}"

    init {
        server.executor = executor
        server.createContext("/") { exchange ->
            try {
                val request = Request(
                    method = exchange.requestMethod,
                    path = exchange.requestURI.rawPath,
                    headers = exchange.requestHeaders,
                    body = exchange.requestBody.readBytes().decodeToString(),
                )
                requests += request
                val handler = routes["${request.method} ${request.path}"]
                if (handler == null) respond(exchange, 404, """{"error":"not_found"}""") else handler(request, exchange)
            } catch (e: Throwable) {
                if (e !is InterruptedException) e.printStackTrace()
            } finally {
                exchange.close()
            }
        }
        server.start()
    }

    fun on(method: String, path: String, handler: (Request, HttpExchange) -> Unit) {
        routes["$method $path"] = handler
    }

    fun json(method: String, path: String, status: Int = 200, headers: Map<String, String> = emptyMap(), body: (Request) -> String) =
        on(method, path) { request, exchange -> respond(exchange, status, body(request), headers) }

    fun discovery(tokenPath: String = "/oauth/token") = json("GET", ModelPassProtocol.DISCOVERY_PATH) {
        """
        {"issuer":"$base","protocol_version":"0.1","token_endpoint":"$base$tokenPath",
         "device_authorization_endpoint":"$base/oauth/device_authorization","revocation_endpoint":"$base/oauth/revoke",
         "api_base":"$base/v1","grant_types_supported":["authorization_code"],"code_challenge_methods_supported":["S256"]}
        """.trimIndent()
    }

    override fun close() {
        server.stop(0)
        executor.shutdownNow()
    }

    companion object {
        fun respond(exchange: HttpExchange, status: Int, body: String, headers: Map<String, String> = emptyMap()) {
            val bytes = body.encodeToByteArray()
            exchange.responseHeaders.add("Content-Type", "application/json")
            headers.forEach { (k, v) -> exchange.responseHeaders.add(k, v) }
            exchange.sendResponseHeaders(status, if (bytes.isEmpty()) -1 else bytes.size.toLong())
            if (bytes.isNotEmpty()) exchange.responseBody.use { it.write(bytes) }
        }

        /** Starts a chunked `text/event-stream` response; write events with [sse]. */
        fun startSse(exchange: HttpExchange, headers: Map<String, String> = emptyMap()) {
            exchange.responseHeaders.add("Content-Type", "text/event-stream")
            headers.forEach { (k, v) -> exchange.responseHeaders.add(k, v) }
            exchange.sendResponseHeaders(200, 0)
        }

        fun sse(exchange: HttpExchange, data: String) {
            exchange.responseBody.write("data: $data\n\n".encodeToByteArray())
            exchange.responseBody.flush()
        }
    }
}
