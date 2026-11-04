package dev.modelpass.core

import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

class SseTest {
    private fun events(stream: String): List<String> {
        val parser = SseParser()
        val out = mutableListOf<String>()
        for (line in stream.split("\n")) parser.feed(line.removeSuffix("\r"))?.let(out::add)
        parser.flush()?.let(out::add)
        return out
    }

    @Test
    fun `parses data lines, multi-line events, comments and CRLF`() {
        val stream = "\uFEFF: keep-alive\n" +
            "data: {\"a\":1}\n\n" +
            "event: message\r\nid: 7\r\ndata:first\r\ndata: second\r\n\r\n" +
            "retry: 1000\n\n" +
            "data: [DONE]\n\n" +
            "data: trailing-without-blank-line"
        assertEquals(listOf("{\"a\":1}", "first\nsecond", "[DONE]", "trailing-without-blank-line"), events(stream))
    }

    @Test
    fun `decodes content, reasoning, tool call, finish and usage chunks`() {
        assertEquals(
            listOf(ChatStreamEvent.Delta("你好")),
            ChatStreamDecoder.decode("""{"choices":[{"index":0,"delta":{"role":"assistant","content":"你好"},"finish_reason":null}],"usage":null}""", 200),
        )
        assertEquals(
            listOf(ChatStreamEvent.ReasoningDelta("think")),
            ChatStreamDecoder.decode("""{"choices":[{"index":0,"delta":{"reasoning_content":"think","content":""}}]}""", 200),
        )
        assertEquals(
            listOf(
                ChatStreamEvent.ToolCallDelta(index = 0, id = "call_1", name = "get_weather", argumentsDelta = "{\"ci"),
                ChatStreamEvent.Finish("tool_calls"),
            ),
            ChatStreamDecoder.decode(
                """{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":"{\"ci"}}]},"finish_reason":"tool_calls"}]}""",
                200,
            ),
        )
        assertEquals(
            listOf(ChatStreamEvent.Usage(ChatUsage(5, 7, 12))),
            ChatStreamDecoder.decode("""{"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":7,"total_tokens":12}}""", 200),
        )
        assertTrue(ChatStreamDecoder.decode("""{"id":"x","choices":[{"index":0,"delta":{}}]}""", 200).isEmpty())
    }

    @Test
    fun `mid-stream error chunks become Api exceptions`() {
        val error = assertFailsWith<ModelPassException.Api> {
            ChatStreamDecoder.decode("""{"error":{"message":"Daily budget exceeded","type":"modelpass_error","code":"budget_exceeded"}}""", 200)
        }
        assertEquals(ApiErrorCodes.BUDGET_EXCEEDED, error.code)
        assertEquals("Daily budget exceeded", error.message)
        assertFailsWith<ModelPassException.InvalidResponse> { ChatStreamDecoder.decode("{not json", 200) }
        assertNull(SseParser().flush())
    }
}
