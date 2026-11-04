package dev.modelpass.core

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class AuthorizationTest {
    private val request = AuthorizationRequest(
        clientId = "com.example.chat",
        redirectUri = "com.example.chat:/modelpass/callback",
        state = "abcdefghijklmnopqrstuv",
        codeChallenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        scopes = listOf("chat", "tools"),
        slots = listOf("default", "fast"),
        clientName = "Example Chat 示例",
        budgetHint = 200000,
    )

    @Test
    fun `builds the wallet authorization URL with all parameters`() {
        assertEquals(
            "modelpass://authorize?response_type=code&client_id=com.example.chat" +
                "&redirect_uri=com.example.chat%3A%2Fmodelpass%2Fcallback&scope=chat%20tools" +
                "&state=abcdefghijklmnopqrstuv&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM" +
                "&code_challenge_method=S256&slots=default%20fast" +
                "&client_name=Example%20Chat%20%E7%A4%BA%E4%BE%8B&budget_hint=200000",
            request.toUrl(),
        )
    }

    @Test
    fun `optional parameters are omitted and existing query strings are preserved`() {
        val minimal = request.copy(clientName = null, budgetHint = null, slots = emptyList())
        val url = minimal.toUrl("https://wallet.example/authorize?ref=sdk#frag")
        assertTrue(url.startsWith("https://wallet.example/authorize?ref=sdk&response_type=code&"), url)
        assertTrue(url.endsWith("&code_challenge_method=S256#frag"), url)
        assertFalse("client_name" in url || "budget_hint" in url || "slots" in url)

        val params = UrlCodec.queryParameters(url)
        assertEquals("sdk", params["ref"])
        assertEquals("chat tools", params["scope"])
        assertEquals("com.example.chat:/modelpass/callback", params["redirect_uri"])
        assertEquals("exp://127.0.0.1:8081/--/authorize?response_type=code", request.toUrl("exp://127.0.0.1:8081/--/authorize?").substringBefore("&"))
    }

    @Test
    fun `prepare generates PKCE and state and always requests chat and default`() {
        val prepared = ModelPassAuthorization.prepare(
            clientId = "com.example.chat",
            redirectUri = "com.example.chat:/modelpass/callback",
            scopes = listOf("tools"),
            slots = listOf("fast"),
            clientName = "Example",
        )
        val params = UrlCodec.queryParameters(prepared.url)
        assertTrue(prepared.url.startsWith("modelpass://authorize?response_type=code&"))
        assertEquals("chat tools", params["scope"])
        assertEquals("default fast", params["slots"])
        assertEquals(prepared.pending.state, params["state"])
        assertEquals("S256", params["code_challenge_method"])
        assertEquals(Pkce.challengeS256(prepared.pending.codeVerifier), params["code_challenge"])
        assertEquals(43, prepared.pending.codeVerifier.length)
        assertFalse(prepared.pending.toString().contains(prepared.pending.codeVerifier))

        val restored = PendingAuthorization.fromJson(prepared.pending.toJson())
        assertEquals(prepared.pending, restored)
        assertFalse(restored.isExpired())
        assertTrue(restored.isExpired(nowMillis = restored.createdAtMillis + PendingAuthorization.DEFAULT_MAX_AGE_MILLIS + 1))
    }

    @Test
    fun `parses a successful redirect and validates iss`() {
        val code = AuthorizationResponse.parse(
            "com.example.chat:/modelpass/callback?code=c%2Fd+e&state=abcdefghijklmnopqrstuv&iss=https%3A%2F%2FHub.Example.com%2F",
            expectedState = "abcdefghijklmnopqrstuv",
        )
        assertEquals("c/d e", code.code)
        assertEquals("https://hub.example.com", code.issuer)
        assertFalse(code.toString().contains("c/d e"))
    }

    @Test
    fun `state must match`() {
        assertFailsWith<ModelPassException.InvalidState> {
            AuthorizationResponse.parse("app:/cb?code=x&state=other&iss=https%3A%2F%2Fhub.example.com", "expected-state")
        }
        assertFailsWith<ModelPassException.InvalidState> {
            AuthorizationResponse.parse("app:/cb?code=x&iss=https%3A%2F%2Fhub.example.com", "expected-state")
        }
        // An error response with the wrong state is also rejected as a state mismatch.
        assertFailsWith<ModelPassException.InvalidState> {
            AuthorizationResponse.parse("app:/cb?error=access_denied&state=nope", "expected-state")
        }
    }

    @Test
    fun `maps error and error_description`() {
        val denied = assertFailsWith<ModelPassException.AccessDenied> {
            AuthorizationResponse.parse("app:/cb?error=access_denied&error_description=User%20said%20no&state=s1234567", "s1234567")
        }
        assertEquals("User said no", denied.description)
        val failed = assertFailsWith<ModelPassException.AuthorizationFailed> {
            AuthorizationResponse.parse("app:/cb?error=invalid_scope&state=s1234567", "s1234567")
        }
        assertEquals("invalid_scope", failed.error)
        assertNull(failed.description)
    }

    @Test
    fun `missing code or iss and duplicated parameters are rejected`() {
        assertFailsWith<ModelPassException.InvalidResponse> {
            AuthorizationResponse.parse("app:/cb?state=s1234567&iss=https%3A%2F%2Fhub.example.com", "s1234567")
        }
        assertFailsWith<ModelPassException.InvalidResponse> {
            AuthorizationResponse.parse("app:/cb?code=x&state=s1234567", "s1234567")
        }
        assertFailsWith<ModelPassException.InvalidResponse> {
            AuthorizationResponse.parse("app:/cb?code=x&code=y&state=s1234567&iss=https%3A%2F%2Fhub.example.com", "s1234567")
        }
        assertFailsWith<ModelPassException.InvalidResponse> {
            AuthorizationResponse.parse("app:/cb?code=%zz&state=s1234567&iss=https%3A%2F%2Fhub.example.com", "s1234567")
        }
    }

    @Test
    fun `issuer policy requires https except for local development hosts`() {
        val policy = IssuerPolicy.Default
        assertEquals("https://hub.example.com", policy.validate("https://hub.example.com/"))
        assertEquals("https://hub.example.com/modelpass", policy.validate("HTTPS://hub.example.com:443/modelpass/"))
        for (local in listOf(
            "http://localhost:8787", "http://127.0.0.1:8787", "http://10.0.2.2:8787", "http://192.168.1.5",
            "http://172.16.0.1", "http://172.31.255.1", "http://my-mac.local:8787", "http://[::1]:8787",
        )) {
            assertEquals(IssuerPolicy.normalizeOrNull(local), policy.validate(local), local)
        }
        for (bad in listOf(
            "http://hub.example.com", "http://172.32.0.1", "http://8.8.8.8", "ftp://hub.example.com",
            "https://user@hub.example.com", "https://hub.example.com?x=1", "https://hub.example.com#f", "hub.example.com", "",
            "javascript:alert(1)",
        )) {
            assertFailsWith<ModelPassException.UntrustedIssuer>(bad) { policy.validate(bad) }
        }
        assertFailsWith<ModelPassException.UntrustedIssuer> { IssuerPolicy(allowLocalHttp = false).validate("http://localhost:8787") }
    }

    @Test
    fun `trusted issuer allowlist`() {
        val policy = IssuerPolicy(trustedIssuers = listOf("https://hub.example.com/", "https://self.example.org"))
        assertEquals("https://hub.example.com", policy.validate("https://HUB.example.com"))
        assertEquals("https://self.example.org", policy.validate("https://self.example.org/"))
        val error = assertFailsWith<ModelPassException.UntrustedIssuer> { policy.validate("https://evil.example.com") }
        assertEquals("https://evil.example.com", error.issuer)
        assertFailsWith<ModelPassException.UntrustedIssuer> {
            AuthorizationResponse.parse("app:/cb?code=x&state=s1234567&iss=https%3A%2F%2Fevil.example.com", "s1234567", policy)
        }
        // An empty list means "no allowlist".
        assertEquals("https://any.example.com", IssuerPolicy(trustedIssuers = emptyList()).validate("https://any.example.com"))
    }

    @Test
    fun `redirect target matching ignores query and scheme case`() {
        val redirect = "com.example.chat:/modelpass/callback"
        assertTrue(ModelPassAuthorization.isRedirectFor("com.example.chat:/modelpass/callback?code=1&state=2", redirect))
        assertTrue(ModelPassAuthorization.isRedirectFor("COM.EXAMPLE.CHAT:/modelpass/callback/", redirect))
        assertFalse(ModelPassAuthorization.isRedirectFor("com.example.chat:/other?code=1", redirect))
        assertFalse(ModelPassAuthorization.isRedirectFor("com.evil:/modelpass/callback?code=1", redirect))
        assertTrue(ModelPassAuthorization.isRedirectFor("https://app.example.com/mp?code=1", "https://app.example.com/mp"))
    }

    @Test
    fun `url codec behaves like encodeURIComponent`() {
        assertEquals("a%20b%2Bc%26d%3De%2F%3F%23-_.!~*'()", UrlCodec.encodeComponent("a b+c&d=e/?#-_.!~*'()"))
        assertEquals("%E6%A8%A1%E5%9E%8B%F0%9F%9A%80", UrlCodec.encodeComponent("模型🚀"))
        assertEquals("a b+c 模型🚀", UrlCodec.decodeComponent("a+b%2Bc%20%E6%A8%A1%E5%9E%8B%F0%9F%9A%80"))
        assertEquals("a+b", UrlCodec.decodeComponent("a+b", plusAsSpace = false))
        assertEquals(mapOf("a" to listOf("1", "3"), "b" to listOf(""), "c" to listOf("")), UrlCodec.parseQueryValues("?a=1&b=&c&a=3"))
        assertEquals("https://h/v1/chat/completions", UrlCodec.join("https://h/v1/", "/chat/completions"))
    }
}
