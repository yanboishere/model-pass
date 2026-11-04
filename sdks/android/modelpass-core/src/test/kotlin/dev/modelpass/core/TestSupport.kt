package dev.modelpass.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File

internal fun ByteArray.hex(): String = joinToString("") { "%02x".format(it) }

internal fun fromHex(hex: String): ByteArray = hex.chunked(2).map { it.toInt(16).toByte() }.toByteArray()

/** docs/test-vectors.json, shared with the TypeScript reference implementation. */
internal object TestVectors {
    private val root: JsonObject by lazy {
        val path = System.getProperty("modelpass.testVectors")
            ?: error("System property modelpass.testVectors is not set (run the tests through Gradle)")
        val file = File(path)
        check(file.isFile) { "Test vectors not found at $path" }
        Json.parseToJsonElement(file.readText()).jsonObject
    }

    val pkce: JsonObject get() = root.getValue("pkce").jsonObject
    val link: JsonObject get() = root.getValue("link").jsonObject

    fun JsonObject.string(key: String): String = getValue(key).jsonPrimitive.content
}
