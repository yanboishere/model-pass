package dev.modelpass.core

import dev.modelpass.core.StubHub.Companion.respond
import dev.modelpass.core.StubHub.Companion.sse
import dev.modelpass.core.StubHub.Companion.startSse
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import org.junit.jupiter.api.Test
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

@OptIn(ExperimentalCoroutinesApi::class)
class ApiIntegrationTest {
    private val api = ModelPassApi(connectTimeoutMillis = 5_000, readTimeoutMillis = 10_000, chatReadTimeoutMillis = 60_000)
    private val clientId = "com.example.chat"
    private val redirectUri = "com.example.chat:/modelpass/callback"

    private fun tokenJson(base: String, token: String = "mpk_e2e", issuer: String? = base) = buildString {
        append("""{"access_token":"$token","token_type":"Bearer","expires_in":3600,"scope":"chat tools","grant_id":"g_e2e","sub":"u_e2e",""")
        if (issuer != null) append(""""issuer":"$issuer","api_base":"$base/v1",""")
        append(""""api_formats":["openai-chat-completions"],"slots":[{"id":"default","label":"默认"},{"id":"fast","label":"快速"}]}""")
    }

    private fun session(base: String) = ModelPassSession(accessToken = "mpk_chat", issuer = base, apiBase = "$base/v1", grantId = "g_1")

    // ---- same-device flow -------------------------------------------------------------------

    @Test
    fun `same-device flow end to end with discovery and PKCE`(): Unit = runBlocking {
        StubHub().use { hub ->
            hub.discovery(tokenPath = "/custom/token")
            val issuedCode = "code_${Pkce.createState()}"
            val walletChallenge = AtomicReference<String>()
            hub.on("POST", "/custom/token") { req, ex ->
                val f = req.form
                val ok = f["grant_type"] == "authorization_code" && f["code"] == issuedCode && f["redirect_uri"] == redirectUri &&
                    f["client_id"] == clientId && Pkce.challengeS256(f.getValue("code_verifier")) == walletChallenge.get()
                if (ok) respond(ex, 200, tokenJson(hub.base)) else respond(ex, 400, """{"error":"invalid_grant","error_description":"PKCE failed"}""")
            }

            // App: build the wallet URL.
            val prepared = ModelPassAuthorization.prepare(clientId, redirectUri, listOf("chat", "tools"), listOf("fast"), "Example", 200_000)
            // Wallet: read the request, remember the challenge, redirect back with code + state + iss.
            val request = UrlCodec.queryParameters(prepared.url)
            assertEquals("200000", request["budget_hint"])
            walletChallenge.set(request.getValue("code_challenge"))
            val redirect = UrlCodec.appendQuery(
                request.getValue("redirect_uri"),
                UrlCodec.encodeQuery(listOf("code" to issuedCode, "state" to request["state"], "iss" to hub.base)),
            )
            // App: validate the redirect and exchange the code.
            val code = AuthorizationResponse.parse(redirect, prepared.pending.state)
            assertEquals(hub.base, code.issuer)
            val session = api.completeAuthorization(code, PendingAuthorization.fromJson(prepared.pending.toJson()))

            assertEquals("mpk_e2e", session.accessToken)
            assertEquals(hub.base, session.issuer)
            assertEquals("${hub.base}/v1", session.apiBase)
            assertEquals(listOf("default", "fast"), session.slots.map { it.id })
            assertTrue(session.expiresAt!! > System.currentTimeMillis() / 1000)
            assertEquals("application/x-www-form-urlencoded", hub.requests.last().header("Content-Type"))
        }
    }

    @Test
    fun `falls back to issuer oauth token and default api_base without discovery`(): Unit = runBlocking {
        StubHub().use { hub ->
            hub.json("POST", "/oauth/token") { tokenJson(hub.base, issuer = null) }
            val pending = PendingAuthorization("state-123456", Pkce.createVerifier(), clientId, redirectUri, System.currentTimeMillis())
            val session = api.completeAuthorization(AuthorizationCode("c", hub.base, "state-123456"), pending)
            assertEquals("${hub.base}/v1", session.apiBase)
            assertEquals(listOf("GET ${ModelPassProtocol.DISCOVERY_PATH}", "POST /oauth/token"), hub.requests.take(2).map { "${it.method} ${it.path}" })
        }
    }

    @Test
    fun `token errors and issuer mismatch`(): Unit = runBlocking {
        StubHub().use { hub ->
            hub.json("POST", "/oauth/token", status = 400) { """{"error":"invalid_grant","error_description":"Code expired"}""" }
            val pending = PendingAuthorization("state-123456", Pkce.createVerifier(), clientId, redirectUri, 0)
            val error = assertFailsWith<ModelPassException.TokenExchangeFailed> {
                api.completeAuthorization(AuthorizationCode("c", hub.base, "state-123456"), pending)
            }
            assertEquals("invalid_grant", error.error)
            assertEquals("Code expired", error.description)
            assertEquals(400, error.status)

            hub.json("POST", "/oauth/token") { tokenJson(hub.base, issuer = "https://other.example.com") }
            assertFailsWith<ModelPassException.InvalidResponse> {
                api.completeAuthorization(AuthorizationCode("c", hub.base, "state-123456"), pending)
            }
        }
    }

    // ---- link flow ----------------------------------------------------------------------------

    private fun StubHub.linkRoutes(onPoll: (Int, (Int, String) -> Unit) -> Unit): AtomicReference<String> {
        val challenge = AtomicReference<String>()
        val polls = AtomicInteger()
        json("POST", "/oauth/device_authorization") { req ->
            check(req.form["link_challenge_method"] == "S256" && req.form["client_id"] == "com.example.tv")
            challenge.set(req.form.getValue("link_challenge"))
            """{"device_code":"dc_1","user_code":"BCDF-GHJK","verification_uri":"$base/link","expires_in":600,"interval":2}"""
        }
        on("POST", "/oauth/token") { req, ex ->
            check(req.form["grant_type"] == ModelPassProtocol.DEVICE_CODE_GRANT_TYPE && req.form["device_code"] == "dc_1")
            onPoll(polls.incrementAndGet()) { status, body -> respond(ex, status, body) }
        }
        return challenge
    }

    @Test
    fun `link flow polls through pending and slow_down and decrypts the sealed token`() = runTest {
        StubHub().use { hub ->
            val sealed = AtomicReference<String?>()
            val pollCount = AtomicInteger()
            val challenge = hub.linkRoutes { n, reply ->
                pollCount.set(n)
                when {
                    n == 1 -> reply(400, """{"error":"authorization_pending"}""")
                    n == 2 -> reply(400, """{"error":"slow_down"}""")
                    sealed.get() == null -> reply(400, """{"error":"authorization_pending"}""")
                    else -> reply(200, """{"modelpass_sealed":"${sealed.get()}"}""")
                }
            }
            val link = api.startLink(hub.base, "com.example.tv", scopes = listOf("chat"), clientName = "TV")
            assertEquals("BCDF-GHJK", link.userCode)
            assertTrue(link.qrUrl.startsWith("${hub.base}/link#v=1&uc=BCDF-GHJK&s="), link.qrUrl)
            assertTrue(link.walletUrl.startsWith("modelpass://link?rv=http%3A%2F%2F127.0.0.1"), link.walletUrl)
            assertEquals(2L, link.intervalSeconds)

            // Wallet: scan the QR code, check the challenge like the rendezvous does, seal T with s.
            val fragment = UrlCodec.parseQueryValues(link.qrUrl.substringAfter('#'))
            val s = Base64Url.decode(fragment.getValue("s").single())
            assertEquals(challenge.get(), LinkCrypto.linkChallenge(LinkCrypto.linkVerifier(s)))
            sealed.set(LinkCrypto.seal(s, fragment.getValue("uc").single(), tokenJson("https://hub.example.com", "mpk_link").encodeToByteArray()))

            val session = link.awaitSession()
            assertEquals("mpk_link", session.accessToken)
            assertEquals("https://hub.example.com", session.issuer)
            assertEquals("https://hub.example.com/v1", session.apiBase)
            assertEquals(3, pollCount.get())
            assertEquals(2_000L + 2_000L + 7_000L, testScheduler.currentTime, "interval 2s, +5s after slow_down")
            assertEquals(session, link.awaitSession(), "result is cached")
        }
    }

    @Test
    fun `link flow reports denial and expiry`() = runTest {
        StubHub().use { hub ->
            hub.linkRoutes { _, reply -> reply(400, """{"error":"access_denied"}""") }
            val denied = api.startLink(hub.base, "com.example.tv")
            assertFailsWith<ModelPassException.LinkDenied> { denied.awaitSession() }
            assertFailsWith<ModelPassException.LinkDenied> { denied.awaitSession() }

            hub.linkRoutes { _, reply -> reply(400, """{"error":"expired_token"}""") }
            assertFailsWith<ModelPassException.LinkExpired> { api.startLink(hub.base, "com.example.tv").awaitSession() }
        }
    }

    @Test
    fun `link flow rejects a payload sealed with the wrong secret and supports cancel`() = runTest {
        StubHub().use { hub ->
            val bogus = LinkCrypto.seal(LinkCrypto.createSecret(), "BCDF-GHJK", tokenJson("https://hub.example.com").encodeToByteArray())
            hub.linkRoutes { _, reply -> reply(200, """{"modelpass_sealed":"$bogus"}""") }
            assertFailsWith<ModelPassException.InvalidResponse> { api.startLink(hub.base, "com.example.tv").awaitSession() }

            hub.linkRoutes { _, reply -> reply(400, """{"error":"authorization_pending"}""") }
            val link = api.startLink(hub.base, "com.example.tv")
            val waiting = async { runCatching { link.awaitSession() } }
            testScheduler.advanceTimeBy(5_000)
            link.cancel()
            assertIs<ModelPassException.Cancelled>(waiting.await().exceptionOrNull())
            assertTrue(link.isCancelled)
        }
    }

    // ---- model API ----------------------------------------------------------------------------

    @Test
    fun `chat completion with routing headers`(): Unit = runBlocking {
        StubHub().use { hub ->
            hub.json(
                "POST",
                "/v1/chat/completions",
                headers = mapOf("x-modelpass-slot" to "fast", "x-modelpass-fallback" to "false", "x-modelpass-budget-remaining" to "9000"),
            ) { req ->
                check(req.header("Authorization") == "Bearer mpk_chat")
                check(req.body.contains("\"model\":\"fast\"") && req.body.contains("\"stream\":false"))
                """{"id":"c1","model":"fast","choices":[{"index":0,"message":{"role":"assistant","content":"你好"},"finish_reason":"stop"}],
                   "usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}"""
            }
            val completion = api.chat(session(hub.base), ChatRequest(listOf(ChatMessage.user("hi")), model = Slots.FAST))
            assertEquals("你好", completion.text)
            assertEquals(RoutingInfo(slot = "fast", fallback = false, budgetRemaining = 9000), completion.routing)
            assertEquals(5L, completion.usage?.totalTokens)
            assertEquals("application/json", hub.requests.last().header("Content-Type"))
        }
    }

    @Test
    fun `API errors keep the status and code, including 401`(): Unit = runBlocking {
        StubHub().use { hub ->
            hub.json("POST", "/v1/chat/completions", status = 401) {
                """{"error":{"message":"Token revoked by the user","type":"modelpass_error","code":"grant_revoked"}}"""
            }
            hub.json("GET", "/v1/modelpass/grant", status = 503) {
                """{"error":{"message":"No model configured","type":"modelpass_error","code":"no_route"}}"""
            }
            val unauthorized = assertFailsWith<ModelPassException.Api> {
                api.chat(session(hub.base), ChatRequest(listOf(ChatMessage.user("hi"))))
            }
            assertEquals(401, unauthorized.status)
            assertEquals(ApiErrorCodes.GRANT_REVOKED, unauthorized.code)
            assertEquals("Token revoked by the user", unauthorized.message)
            assertTrue(unauthorized.requiresReauthorization)

            val noRoute = assertFailsWith<ModelPassException.Api> { api.grantInfo(session(hub.base)) }
            assertEquals(503, noRoute.status)
            assertEquals(ApiErrorCodes.NO_ROUTE, noRoute.code)
        }
    }

    @Test
    fun `streaming chat yields routing, deltas, finish and usage until DONE`(): Unit = runBlocking {
        StubHub().use { hub ->
            hub.on("POST", "/v1/chat/completions") { req, ex ->
                check(req.header("Accept") == "text/event-stream" && req.body.contains("\"include_usage\":true"))
                startSse(ex, mapOf("x-modelpass-slot" to "default", "x-modelpass-fallback" to "true"))
                ex.responseBody.write(": keep-alive\n\n".encodeToByteArray())
                sse(ex, """{"choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}""")
                sse(ex, """{"choices":[{"index":0,"delta":{"content":"Hel"}}]}""")
                sse(ex, """{"choices":[{"index":0,"delta":{"content":"lo 世界"}}]}""")
                sse(ex, """{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}""")
                sse(ex, """{"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}""")
                sse(ex, "[DONE]")
                sse(ex, """{"choices":[{"index":0,"delta":{"content":"after done"}}]}""")
            }
            val events = api.streamChat(session(hub.base), ChatRequest(listOf(ChatMessage.user("hi")), model = "gpt-4o-mini")).toList()
            assertEquals(
                listOf(
                    ChatStreamEvent.Routing(RoutingInfo(slot = "default", fallback = true)),
                    ChatStreamEvent.Delta("Hel"),
                    ChatStreamEvent.Delta("lo 世界"),
                    ChatStreamEvent.Finish("stop"),
                    ChatStreamEvent.Usage(ChatUsage(4, 2, 6)),
                ),
                events,
            )
            assertEquals("Hello 世界", api.streamChat(session(hub.base), ChatRequest(listOf(ChatMessage.user("hi")))).textDeltas().toList().joinToString(""))
        }
    }

    @Test
    fun `streaming errors surface as Api exceptions`(): Unit = runBlocking {
        StubHub().use { hub ->
            hub.json("POST", "/v1/chat/completions", status = 429) {
                """{"error":{"message":"Daily budget exceeded","type":"modelpass_error","code":"budget_exceeded"}}"""
            }
            val error = assertFailsWith<ModelPassException.Api> {
                api.streamChat(session(hub.base), ChatRequest(listOf(ChatMessage.user("hi")))).toList()
            }
            assertEquals(429, error.status)
            assertEquals(ApiErrorCodes.BUDGET_EXCEEDED, error.code)

            hub.on("POST", "/v1/chat/completions") { _, ex ->
                startSse(ex)
                sse(ex, """{"choices":[{"index":0,"delta":{"content":"partial"}}]}""")
                sse(ex, """{"error":{"message":"Upstream failed","type":"modelpass_error","code":"upstream_error"}}""")
            }
            val midStream = assertFailsWith<ModelPassException.Api> {
                api.streamChat(session(hub.base), ChatRequest(listOf(ChatMessage.user("hi")))).toList()
            }
            assertEquals(ApiErrorCodes.UPSTREAM_ERROR, midStream.code)
        }
    }

    @Test
    fun `cancelling a stream closes the connection promptly`(): Unit = runBlocking {
        StubHub().use { hub ->
            hub.on("POST", "/v1/chat/completions") { _, ex ->
                startSse(ex)
                sse(ex, """{"choices":[{"index":0,"delta":{"content":"first"}}]}""")
                Thread.sleep(30_000) // the upstream "hangs"
            }
            val started = System.nanoTime()
            val first = withTimeout(10_000) {
                api.streamChat(session(hub.base), ChatRequest(listOf(ChatMessage.user("hi")))).filterIsInstance<ChatStreamEvent.Delta>().first()
            }
            assertEquals("first", first.text)
            assertTrue((System.nanoTime() - started) / 1_000_000 < 5_000, "stream was not torn down promptly")
        }
    }

    @Test
    fun `cancelling a non-streaming request aborts it promptly`(): Unit = runBlocking {
        StubHub().use { hub ->
            hub.on("POST", "/v1/chat/completions") { _, ex ->
                Thread.sleep(30_000)
                respond(ex, 200, "{}")
            }
            val started = System.nanoTime()
            val result = withTimeoutOrNull(500) { api.chat(session(hub.base), ChatRequest(listOf(ChatMessage.user("hi")))) }
            assertNull(result)
            assertTrue((System.nanoTime() - started) / 1_000_000 < 5_000, "request was not aborted promptly")
        }
    }

    @Test
    fun `grant info, models and revocation`(): Unit = runBlocking {
        StubHub().use { hub ->
            hub.json("GET", "/v1/modelpass/grant") { req ->
                check(req.header("Authorization") == "Bearer mpk_chat")
                """{"grant_id":"g_1","client_id":"com.example.chat","scope":"chat","status":"paused","slots":[{"id":"default","label":"默认"}],
                   "budget":{"tokens_per_day":null,"requests_per_day":100,"tokens_used_today":0,"requests_today":3},"created_at":1767225600,"expires_at":null}"""
            }
            hub.json("GET", "/v1/models") { """{"object":"list","data":[{"id":"default","object":"model","owned_by":"modelpass"},{"id":"fast"}]}""" }
            hub.json("POST", "/oauth/revoke") { "" }

            val info = api.grantInfo(session(hub.base))
            assertEquals("paused", info.status)
            assertEquals(100L, info.budget?.requestsPerDay)
            assertEquals(listOf("default", "fast"), api.models(session(hub.base)).map { it.id })

            api.revoke(session(hub.base))
            val revoke = hub.requests.last()
            assertEquals("/oauth/revoke", revoke.path)
            assertEquals(mapOf("token" to "mpk_chat"), revoke.form)
        }
    }

    @Test
    fun `redirects are not followed, so the bearer token never leaves the hub`(): Unit = runBlocking {
        StubHub().use { other ->
            StubHub().use { hub ->
                hub.json("GET", "/v1/modelpass/grant", status = 302, headers = mapOf("Location" to "${other.base}/steal")) { "" }
                val error = assertFailsWith<ModelPassException.Api> { api.grantInfo(session(hub.base)) }
                assertEquals(302, error.status)
                assertTrue(other.requests.isEmpty())
            }
        }
    }

    @Test
    fun `connection failures are reported as Network errors`(): Unit = runBlocking {
        val port = StubHub().use { it.base } // closed immediately: nothing listens there any more
        assertFailsWith<ModelPassException.Network> { api.grantInfo(session(port)) }
    }
}
