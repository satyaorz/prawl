package xyz.prawl.core.util

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * Tiny org.json-style accessors over kotlinx JSON trees.
 *
 * The wire objects are kept as JSON trees (not data classes) so unknown fields written by other
 * versions (the Java harness, a future light-client `depositProof`, ...) pass through unchanged, and
 * the coercions match org.json on Android: `getString` of a number yields its decimal text, and
 * `getLong` of a decimal string parses it.
 */
object Js {
    val parser = Json { ignoreUnknownKeys = true; isLenient = false }

    fun parse(s: String): JsonObject = parser.parseToJsonElement(s) as? JsonObject
        ?: throw IllegalArgumentException("not a JSON object")

    fun parseArray(s: String): JsonArray = parser.parseToJsonElement(s) as? JsonArray
        ?: throw IllegalArgumentException("not a JSON array")
}

class JsonFieldException(msg: String) : IllegalArgumentException(msg)

private fun JsonObject.need(k: String): JsonElement = this[k]?.takeIf { it !is JsonNull } ?: throw JsonFieldException("missing field '$k'")

fun JsonObject.str(k: String): String = (need(k) as? JsonPrimitive)?.contentOrNull ?: throw JsonFieldException("field '$k' is not a string")
fun JsonObject.optStr(k: String, def: String? = null): String? = (this[k] as? JsonPrimitive)?.contentOrNull ?: def
fun JsonObject.long(k: String): Long = str(k).let { it.toLongOrNull() ?: it.toDoubleOrNull()?.toLong() ?: throw JsonFieldException("field '$k' is not a number") }
fun JsonObject.int(k: String): Int = long(k).let { if (it < Int.MIN_VALUE || it > Int.MAX_VALUE) throw JsonFieldException("field '$k' out of range") else it.toInt() }
fun JsonObject.arr(k: String): JsonArray = need(k) as? JsonArray ?: throw JsonFieldException("field '$k' is not an array")
fun JsonObject.optArr(k: String): JsonArray? = this[k] as? JsonArray
fun JsonObject.obj(k: String): JsonObject = need(k) as? JsonObject ?: throw JsonFieldException("field '$k' is not an object")
fun JsonObject.optObj(k: String): JsonObject? = this[k] as? JsonObject
fun JsonObject.has(k: String): Boolean = this.containsKey(k) && this[k] !is JsonNull
fun JsonObject.bool(k: String, def: Boolean = false): Boolean = (this[k] as? JsonPrimitive)?.contentOrNull?.toBooleanStrictOrNull() ?: def

fun JsonArray.strings(): List<String> = map { (it as? JsonPrimitive)?.contentOrNull ?: throw JsonFieldException("array element is not a string") }
fun JsonArray.objects(): List<JsonObject> = map { it as? JsonObject ?: throw JsonFieldException("array element is not an object") }

/** Returns a copy with [k] set (insertion order kept; an existing key keeps its position, like org.json's put). */
fun JsonObject.with(k: String, v: JsonElement): JsonObject = JsonObject(LinkedHashMap(this).also { it[k] = v })
fun JsonObject.with(k: String, v: String): JsonObject = with(k, JsonPrimitive(v))
fun JsonObject.with(k: String, v: Number): JsonObject = with(k, JsonPrimitive(v))
fun JsonObject.with(k: String, v: Boolean): JsonObject = with(k, JsonPrimitive(v))
fun JsonObject.without(vararg ks: String): JsonObject = JsonObject(LinkedHashMap(this).also { m -> ks.forEach { m.remove(it) } })

fun jsonArrayOf(items: List<String>): JsonArray = JsonArray(items.map { JsonPrimitive(it) })
