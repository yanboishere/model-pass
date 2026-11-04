package dev.modelpass.core

import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull

/**
 * Minimal Server-Sent Events parser (WHATWG HTML §9.2): feed it lines (without terminators);
 * it returns the `data` of each completed event. Comments and other fields are ignored.
 */
internal class SseParser {
    private val data = StringBuilder()
    private var hasData = false

    /** Returns the event data when [line] completes an event (blank line), else null. */
    fun feed(rawLine: String): String? {
        val line = rawLine.removePrefix("\uFEFF")
        if (line.isEmpty()) return flush()
        if (line.startsWith(":")) return null
        val colon = line.indexOf(':')
        val field = if (colon < 0) line else line.substring(0, colon)
        var value = if (colon < 0) "" else line.substring(colon + 1)
        if (value.startsWith(" ")) value = value.substring(1)
        if (field == "data") {
            if (hasData) data.append('\n')
            data.append(value)
            hasData = true
        }
        return null
    }

    /** Ends the current event (also call at end of stream). */
    fun flush(): String? {
        if (!hasData) return null
        val out = data.toString()
        data.setLength(0)
        hasData = false
        return out
    }
}

/** Turns one `chat.completion.chunk` JSON payload into [ChatStreamEvent]s. */
internal object ChatStreamDecoder {
    const val DONE: String = "[DONE]"

    fun decode(data: String, status: Int): List<ChatStreamEvent> {
        val root = try {
            ModelPassJson.parseToJsonElement(data)
        } catch (e: SerializationException) {
            // No parser message: it would quote (possibly private) model output.
            throw ModelPassException.InvalidResponse("Invalid chat stream chunk")
        }
        val obj = root as? JsonObject ?: throw ModelPassException.InvalidResponse("Stream chunk is not a JSON object")
        if (obj["error"].let { it != null && it !is JsonNull }) {
            throw apiErrorFromJson(status, obj)
        }
        val events = ArrayList<ChatStreamEvent>(2)
        (obj["choices"] as? JsonArray)?.forEach { element ->
            val choice = element as? JsonObject ?: return@forEach
            val index = (choice["index"] as? JsonPrimitive)?.intOrNull ?: 0
            val delta = choice["delta"] as? JsonObject
            if (delta != null) {
                delta["reasoning_content"].string()?.takeIf { it.isNotEmpty() }?.let { events += ChatStreamEvent.ReasoningDelta(it, index) }
                delta["content"].string()?.takeIf { it.isNotEmpty() }?.let { events += ChatStreamEvent.Delta(it, index) }
                (delta["tool_calls"] as? JsonArray)?.forEachIndexed { position, call ->
                    val c = call as? JsonObject ?: return@forEachIndexed
                    val fn = c["function"] as? JsonObject
                    events += ChatStreamEvent.ToolCallDelta(
                        index = (c["index"] as? JsonPrimitive)?.intOrNull ?: position,
                        id = c["id"].string(),
                        name = fn?.get("name").string(),
                        argumentsDelta = fn?.get("arguments").string(),
                        choiceIndex = index,
                    )
                }
            }
            choice["finish_reason"].string()?.takeIf { it.isNotEmpty() }?.let { events += ChatStreamEvent.Finish(it, index) }
        }
        (obj["usage"] as? JsonObject)?.let { usage ->
            runCatching { ModelPassJson.decodeFromJsonElement(ChatUsage.serializer(), usage) }
                .getOrNull()?.let { events += ChatStreamEvent.Usage(it) }
        }
        return events
    }

    private fun JsonElement?.string(): String? = (this as? JsonPrimitive)?.contentOrNull
}
