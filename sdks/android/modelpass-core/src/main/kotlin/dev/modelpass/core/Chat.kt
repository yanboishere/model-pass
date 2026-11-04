package dev.modelpass.core

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.flow.map
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.Transient
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

/**
 * An OpenAI Chat Completions message. [content] is either a JSON string or an array of content
 * parts (`text`, `image_url`), so any OpenAI-compatible payload can be expressed.
 */
@Serializable
public data class ChatMessage(
    val role: String,
    val content: JsonElement? = null,
    val name: String? = null,
    @SerialName("tool_calls") val toolCalls: List<ToolCall>? = null,
    @SerialName("tool_call_id") val toolCallId: String? = null,
    /** Reasoning text returned by some upstreams (never sent back in requests). */
    @SerialName("reasoning_content") val reasoningContent: String? = null,
) {
    /** Plain text of [content] (string content, or the concatenated `text` parts). */
    val text: String?
        get() = when (val c = content) {
            is JsonPrimitive -> c.contentOrNull
            is JsonArray -> c.mapNotNull { part ->
                val obj = part as? JsonObject
                if (obj != null && (obj["type"] as? JsonPrimitive)?.contentOrNull == "text") (obj["text"] as? JsonPrimitive)?.contentOrNull else null
            }.joinToString("")
            else -> null
        }

    public companion object {
        @JvmStatic public fun system(text: String): ChatMessage = ChatMessage("system", JsonPrimitive(text))
        @JvmStatic public fun user(text: String): ChatMessage = ChatMessage("user", JsonPrimitive(text))
        @JvmStatic public fun assistant(text: String): ChatMessage = ChatMessage("assistant", JsonPrimitive(text))

        /** Result of a tool call, answering [toolCallId]. Requires the `tools` scope. */
        @JvmStatic public fun tool(toolCallId: String, content: String): ChatMessage =
            ChatMessage("tool", JsonPrimitive(content), toolCallId = toolCallId)

        /** User message with images (`https://…` or `data:image/png;base64,…`). Requires the `vision` scope. */
        @JvmStatic public fun userWithImages(text: String, imageUrls: List<String>): ChatMessage =
            ChatMessage(
                "user",
                buildJsonArray {
                    add(buildJsonObject { put("type", "text"); put("text", text) })
                    for (url in imageUrls) {
                        add(buildJsonObject { put("type", "image_url"); putJsonObject("image_url") { put("url", url) } })
                    }
                },
            )
    }
}

@Serializable
public data class ToolCall(
    val id: String = "",
    val type: String = "function",
    val function: FunctionCall = FunctionCall(),
)

@Serializable
public data class FunctionCall(val name: String = "", val arguments: String = "")

/**
 * A chat completion request. [model] is normally a slot id (`default`, `fast`, `reasoning`,
 * `vision`); any other value falls back to the `default` slot unless the user allowed it (§8.3).
 */
public data class ChatRequest @JvmOverloads constructor(
    val messages: List<ChatMessage>,
    val model: String = Slots.DEFAULT,
    val temperature: Double? = null,
    val maxTokens: Int? = null,
    /** OpenAI `tools` array (requires the `tools` scope). */
    val tools: JsonArray? = null,
    val toolChoice: JsonElement? = null,
    /** Extra top-level request fields (e.g. `top_p`, `response_format`); explicit fields win. */
    val extra: Map<String, JsonElement> = emptyMap(),
) {
    public fun toJson(stream: Boolean): JsonObject = buildJsonObject {
        for ((key, value) in extra) put(key, value)
        put("model", model)
        put(
            "messages",
            JsonArray(
                messages.map { message ->
                    val encoded = ModelPassJson.encodeToJsonElement(ChatMessage.serializer(), message) as JsonObject
                    JsonObject(encoded - "reasoning_content")
                },
            ),
        )
        temperature?.let { put("temperature", it) }
        maxTokens?.let { put("max_tokens", it) }
        tools?.let { put("tools", it) }
        toolChoice?.let { put("tool_choice", it) }
        put("stream", stream)
        if (stream && "stream_options" !in extra) putJsonObject("stream_options") { put("include_usage", true) }
    }
}

/** Response of `POST {api_base}/chat/completions`. */
@Serializable
public data class ChatCompletion(
    val id: String = "",
    val model: String = "",
    val created: Long = 0,
    val choices: List<ChatChoice> = emptyList(),
    val usage: ChatUsage? = null,
    /** From the `x-modelpass-*` response headers (§8.5). */
    @Transient val routing: RoutingInfo = RoutingInfo(),
) {
    /** The first choice's message. */
    val message: ChatMessage? get() = choices.firstOrNull()?.message

    /** The first choice's text. */
    val text: String? get() = message?.text
}

@Serializable
public data class ChatChoice(
    val index: Int = 0,
    val message: ChatMessage? = null,
    @SerialName("finish_reason") val finishReason: String? = null,
)

@Serializable
public data class ChatUsage(
    @SerialName("prompt_tokens") val promptTokens: Long = 0,
    @SerialName("completion_tokens") val completionTokens: Long = 0,
    @SerialName("total_tokens") val totalTokens: Long = 0,
)

/** Routing details from the `x-modelpass-*` response headers (§8.5). */
public data class RoutingInfo(
    /** Slot actually used (`x-modelpass-slot`). */
    val slot: String? = null,
    /** True if the requested model did not match and the `default` slot was used. */
    val fallback: Boolean = false,
    /** Upstream model / provider (only if the user allows sharing them). */
    val model: String? = null,
    val provider: String? = null,
    /** Remaining daily token budget, if a budget is set. */
    val budgetRemaining: Long? = null,
) {
    internal companion object {
        fun fromHeaders(header: (String) -> String?): RoutingInfo = RoutingInfo(
            slot = header("x-modelpass-slot"),
            fallback = header("x-modelpass-fallback").equals("true", ignoreCase = true),
            model = header("x-modelpass-model"),
            // Percent-encoded UTF-8 (header values must be ASCII; provider names may be CJK).
            provider = header("x-modelpass-provider")?.let { runCatching { UrlCodec.decodeComponent(it, plusAsSpace = false) }.getOrDefault(it) },
            budgetRemaining = header("x-modelpass-budget-remaining")?.trim()?.toLongOrNull(),
        )
    }
}

/** Events of a streaming chat completion (`stream: true`, SSE). */
public sealed interface ChatStreamEvent {
    /** First event: response headers were received. */
    public data class Routing(val info: RoutingInfo) : ChatStreamEvent

    /** A piece of assistant text. */
    public data class Delta(val text: String, val choiceIndex: Int = 0) : ChatStreamEvent

    /** A piece of reasoning text (upstreams that expose `reasoning_content`). */
    public data class ReasoningDelta(val text: String, val choiceIndex: Int = 0) : ChatStreamEvent

    /** A fragment of a tool call; concatenate [argumentsDelta] per [index]. */
    public data class ToolCallDelta(
        val index: Int,
        val id: String?,
        val name: String?,
        val argumentsDelta: String?,
        val choiceIndex: Int = 0,
    ) : ChatStreamEvent

    /** The choice finished (`stop`, `length`, `tool_calls`, `content_filter`, …). */
    public data class Finish(val reason: String, val choiceIndex: Int = 0) : ChatStreamEvent

    /** Token usage (sent near the end of the stream). */
    public data class Usage(val usage: ChatUsage) : ChatStreamEvent
}

/** Only the text deltas of a chat stream. */
public fun Flow<ChatStreamEvent>.textDeltas(): Flow<String> =
    filterIsInstance<ChatStreamEvent.Delta>().map { it.text }
