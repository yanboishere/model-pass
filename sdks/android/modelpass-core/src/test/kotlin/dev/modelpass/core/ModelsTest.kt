package dev.modelpass.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ModelsTest {
    private val specTokenResponse = """
        {
          "access_token": "mpk_3wq6oX8d",
          "token_type": "Bearer",
          "expires_in": 2592000,
          "scope": "chat tools",
          "grant_id": "g_9xKc2",
          "sub": "u2b1c",
          "issuer": "https://hub.example.com",
          "api_base": "https://hub.example.com/v1",
          "api_formats": ["openai-chat-completions", "anthropic-messages"],
          "slots": [
            { "id": "default", "label": "默认" },
            { "id": "fast", "label": "快速", "model": "deepseek-flash", "provider": "DeepSeek" }
          ],
          "some_future_field": { "ignored": true }
        }
    """.trimIndent()

    @Test
    fun `parses the spec token response and ignores unknown fields`() {
        val token = TokenResponse.parse(specTokenResponse)
        assertEquals("mpk_3wq6oX8d", token.accessToken)
        assertEquals(2592000L, token.expiresIn)
        assertEquals("g_9xKc2", token.grantId)
        assertEquals(listOf("default", "fast"), token.slots.map { it.id })
        assertEquals("deepseek-flash", token.slots[1].model)
        assertNull(token.slots[0].model)
        assertFalse(token.toString().contains("mpk_3wq6oX8d"))
    }

    @Test
    fun `minimal and malformed token responses`() {
        val minimal = TokenResponse.parse("""{"access_token":"mpk_x","scope":null}""")
        assertEquals("Bearer", minimal.tokenType)
        assertEquals("", minimal.scope)
        assertNull(minimal.expiresIn)
        assertFailsWith<ModelPassException.InvalidResponse> { TokenResponse.parse("""{"token_type":"Bearer"}""") }
        assertFailsWith<ModelPassException.InvalidResponse> { TokenResponse.parse("not json") }
    }

    @Test
    fun `parse errors of secret-bearing payloads do not quote the input`() {
        val broken = """{"access_token":"mpk_super_secret_value","scope":"chat" "oops"}"""
        for (error in listOf(
            assertFailsWith<ModelPassException.InvalidResponse> { TokenResponse.parse(broken) },
            assertFailsWith<ModelPassException.InvalidResponse> { ModelPassSession.fromJson(broken) },
            assertFailsWith<ModelPassException.InvalidResponse> { PendingAuthorization.fromJson("""{"code_verifier":"mpk_super_secret_value" x}""") },
        )) {
            assertFalse(error.stackTraceToString().contains("mpk_super_secret_value"), error.stackTraceToString())
        }
    }

    @Test
    fun `builds a session, computes expiry and round-trips through JSON`() {
        val now = 1_767_225_600_000L
        val session = ModelPassSession.fromTokenResponse(
            TokenResponse.parse(specTokenResponse),
            issuer = "https://hub.example.com",
            apiBase = "https://hub.example.com/v1/",
            nowMillis = now,
        )
        assertEquals("https://hub.example.com/v1", session.apiBase)
        assertEquals(now / 1000 + 2592000, session.expiresAt)
        assertEquals(listOf("chat", "tools"), session.scopes)
        assertTrue(session.hasScope(Scopes.TOOLS))
        assertFalse(session.hasScope(Scopes.VISION))
        assertFalse(session.isExpired(now))
        assertTrue(session.isExpired(now + 2592000L * 1000))
        assertEquals("Bearer mpk_3wq6oX8d", session.authorizationHeader)
        assertEquals("modelpass://grants/g_9xKc2", session.manageUrl)
        assertFalse(session.toString().contains("mpk_3wq6oX8d"))
        assertEquals(session, ModelPassSession.fromJson(session.toJson()))
        assertFailsWith<ModelPassException.InvalidResponse> { ModelPassSession.fromJson("{}") }
    }

    @Test
    fun `rejects unsafe api_base and non-bearer tokens`() {
        val token = TokenResponse.parse(specTokenResponse)
        assertFailsWith<ModelPassException.InvalidResponse> {
            ModelPassSession.fromTokenResponse(token, "https://hub.example.com", "http://evil.example.com/v1")
        }
        assertFailsWith<ModelPassException.InvalidResponse> {
            ModelPassSession.fromTokenResponse(token.copy(tokenType = "mac"), "https://hub.example.com", "https://hub.example.com/v1")
        }
        assertFailsWith<ModelPassException.InvalidResponse> {
            ModelPassSession.fromTokenResponse(token.copy(accessToken = " "), "https://hub.example.com", "https://hub.example.com/v1")
        }
    }

    @Test
    fun `parses the spec grant info`() {
        val info = ModelPassJson.decodeFromString(
            GrantInfo.serializer(),
            """
            {
              "grant_id": "g_1", "client_id": "com.example.chat", "scope": "chat tools", "status": "active",
              "slots": [{ "id": "default", "label": "默认", "model": "deepseek-flash", "provider": "DeepSeek" }],
              "budget": { "tokens_per_day": 200000, "requests_per_day": null, "tokens_used_today": 5120, "requests_today": 7 },
              "created_at": 1767225600, "expires_at": null
            }
            """.trimIndent(),
        )
        assertTrue(info.isActive)
        assertEquals(listOf("chat", "tools"), info.scopes)
        assertEquals(200000L, info.budget?.tokensPerDay)
        assertNull(info.budget?.requestsPerDay)
        assertEquals(5120L, info.budget?.tokensUsedToday)
        assertNull(info.expiresAt)
    }

    @Test
    fun `chat request JSON and completion parsing`() {
        val request = ChatRequest(
            messages = listOf(
                ChatMessage.system("Be brief."),
                ChatMessage.userWithImages("What is this?", listOf("https://example.com/cat.png")),
                ChatMessage("assistant", JsonPrimitive("Hi"), reasoningContent = "secret thoughts"),
            ),
            model = Slots.FAST,
            temperature = 0.2,
            maxTokens = 128,
            extra = mapOf("top_p" to JsonPrimitive(0.9), "model" to JsonPrimitive("ignored")),
        )
        val json = request.toJson(stream = true)
        assertEquals("fast", json["model"]!!.jsonPrimitive.content)
        assertEquals("0.9", json["top_p"]!!.jsonPrimitive.content)
        assertEquals("128", json["max_tokens"]!!.jsonPrimitive.content)
        assertEquals("true", json["stream"]!!.jsonPrimitive.content)
        assertEquals("true", json["stream_options"]!!.jsonObject["include_usage"]!!.jsonPrimitive.content)
        val messages = json["messages"]!!.jsonArray
        assertEquals(buildJsonObject { put("role", "system"); put("content", "Be brief.") }, messages[0])
        assertEquals("image_url", (messages[1].jsonObject["content"] as JsonArray)[1].jsonObject["type"]!!.jsonPrimitive.content)
        assertFalse("reasoning_content" in messages[2].jsonObject)
        assertFalse("name" in (messages[0] as JsonObject), "null fields are omitted")
        assertFalse("stream_options" in request.toJson(stream = false))

        val completion = ModelPassJson.decodeFromString(
            ChatCompletion.serializer(),
            """
            {"id":"chatcmpl-1","object":"chat.completion","created":1767225600,"model":"default",
             "choices":[{"index":0,"message":{"role":"assistant","content":"你好！","reasoning_content":"r"},"finish_reason":"stop"}],
             "usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}
            """.trimIndent(),
        )
        assertEquals("你好！", completion.text)
        assertEquals("r", completion.message?.reasoningContent)
        assertEquals("stop", completion.choices.single().finishReason)
        assertEquals(8L, completion.usage?.totalTokens)
        assertEquals("What is this?", ChatMessage.userWithImages("What is this?", listOf("x")).text)
    }

    @Test
    fun `error bodies in both formats`() {
        val api = apiError(401, """{"error":{"message":"Token revoked","type":"modelpass_error","code":"grant_revoked"}}""")
        assertEquals(401, api.status)
        assertEquals(ApiErrorCodes.GRANT_REVOKED, api.code)
        assertEquals("Token revoked", api.message)
        assertEquals("modelpass_error", api.type)
        assertTrue(api.requiresReauthorization)

        val paused = apiError(403, """{"error":{"message":"Paused","type":"modelpass_error","code":"grant_paused"}}""")
        assertFalse(paused.requiresReauthorization)

        val oauth = parseErrorBody("""{"error":"invalid_grant","error_description":"Code expired"}""")
        assertEquals(ErrorBody("invalid_grant", "Code expired", null), oauth)

        val plain = apiError(502, "Bad Gateway")
        assertNull(plain.code)
        assertEquals("Bad Gateway", plain.message)
        assertEquals("HTTP 500", apiError(500, "").message)
    }

    @Test
    fun `routing info from headers`() {
        val headers = mapOf(
            "x-modelpass-slot" to "default",
            "x-modelpass-fallback" to "true",
            "x-modelpass-model" to "deepseek-flash",
            "x-modelpass-budget-remaining" to "1234",
        )
        val info = RoutingInfo.fromHeaders { headers[it] }
        assertEquals(RoutingInfo("default", true, "deepseek-flash", null, 1234L), info)
        assertEquals(RoutingInfo(), RoutingInfo.fromHeaders { null })
    }
}
