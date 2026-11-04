package dev.modelpass.core

import kotlinx.coroutines.async
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.Test
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Cross-language interop against a real hub (`npm run hub`) and the headless wallet in
 * `scripts/interop/wallet.mts`. Skipped unless `MODELPASS_INTEROP_HUB` is set, e.g.
 *   MODELPASS_INTEROP_HUB=http://localhost:8787 gradle -p sdks/android :modelpass-core:test --tests '*LiveHubInteropTest*'
 */
class LiveHubInteropTest {
    private val hub = System.getenv("MODELPASS_INTEROP_HUB")
    private val api = ModelPassApi(connectTimeoutMillis = 5_000, readTimeoutMillis = 20_000, chatReadTimeoutMillis = 60_000)

    private fun repoRoot(): File {
        var dir: File? = File("").absoluteFile
        while (dir != null && !File(dir, "scripts/interop/wallet.mts").exists()) dir = dir.parentFile
        return dir ?: error("repository root not found")
    }

    /** Runs the headless wallet and returns the last line it printed. */
    private fun wallet(vararg args: String): String {
        val process = ProcessBuilder(listOf("npx", "tsx", "scripts/interop/wallet.mts") + args)
            .directory(repoRoot())
            .redirectErrorStream(true)
            .apply { environment()["HUB_URL"] = hub }
            .start()
        val out = process.inputStream.bufferedReader().readText()
        check(process.waitFor() == 0) { "wallet failed: $out" }
        return out.trim().lines().last()
    }

    @Test
    fun sameDeviceFlowAndChat() = runBlocking {
        assumeTrue(hub != null, "MODELPASS_INTEROP_HUB not set")
        val redirectUri = "dev.interop.kotlin://cb"
        val prepared = ModelPassAuthorization.prepare(
            clientId = "dev.interop.kotlin",
            redirectUri = redirectUri,
            scopes = listOf("chat"),
            slots = listOf("default", "reasoning"),
            clientName = "Kotlin Interop",
        )
        val redirect = wallet("approve-authorize", prepared.url)
        val code = AuthorizationResponse.parse(redirect, prepared.pending.state)
        val session = api.completeAuthorization(code, prepared.pending)
        assertTrue(session.accessToken.startsWith("mpk_"))

        val reply = api.chat(session, ChatRequest(listOf(ChatMessage.user("hello from Kotlin"))))
        assertTrue(reply.text.orEmpty().contains("mock-gpt-mini"), reply.text)
        assertEquals("演示模型 · OpenAI 协议", reply.routing.provider)

        val deltas = api.streamChat(session, ChatRequest(listOf(ChatMessage.user("stream from Kotlin")), model = "reasoning"))
            .filterIsInstance<ChatStreamEvent.Delta>()
            .toList()
        assertTrue(deltas.joinToString("") { it.text }.contains("Anthropic"))

        val info = api.grantInfo(session)
        assertTrue((info.budget?.requestsToday ?: 0) >= 2)
        api.revoke(session)
        val revoked = runCatching { api.chat(session, ChatRequest(listOf(ChatMessage.user("after revoke")))) }.exceptionOrNull()
        assertTrue(revoked is ModelPassException.Api && revoked.code == "grant_revoked", "expected grant_revoked, got $revoked")
    }

    @Test
    fun crossDeviceLinkFlow() = runBlocking {
        assumeTrue(hub != null, "MODELPASS_INTEROP_HUB not set")
        val link = api.startLink(rendezvous = hub!!, clientId = "dev.modelpass.webdemo", clientName = "Kotlin Link")
        val approval = async { wallet("approve-link", link.qrUrl) }
        val session = link.awaitSession()
        assertTrue(approval.await().startsWith("approved"))
        val reply = api.chat(session, ChatRequest(listOf(ChatMessage.user("hi via QR from Kotlin"))))
        assertTrue(!reply.text.isNullOrEmpty())
    }
}
