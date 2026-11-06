package xyz.prawl.core.model

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import xyz.prawl.core.util.arr
import xyz.prawl.core.util.bool
import xyz.prawl.core.util.has
import xyz.prawl.core.util.int
import xyz.prawl.core.util.long
import xyz.prawl.core.util.objects
import xyz.prawl.core.util.obj
import xyz.prawl.core.util.optObj
import xyz.prawl.core.util.optStr
import xyz.prawl.core.util.str
import xyz.prawl.core.util.strings
import java.math.BigInteger

/*
 * v3 wire objects (raw/v3/SPEC.md), byte-compatible with Wallet3Activity. Each wraps the JSON tree it was
 * read from, so fields this version does not know are carried along untouched.
 *
 * header  {"v":3,"label","coinId"(hex64),"chainId"(decimal string),"escrow"(hex40),"expiry"(number),
 *          "value"(wei string),"k0"[cert ids],"k0x","k0y"(hex, no 0x, no leading zeros),"depositor"(hex40)}
 * output  {"value"(wei string),"key"(sha256 hex of the SPKI, or the PRAWL-REDEEM key)}
 * spend   {"outputs":[...],"index":n,"sig"(base64 DER),"next":[cert ids of outputs[index]'s key]}
 * bundle  {"header","path":[spend...],"certs":{id: base64 DER}} (+ "redeem" for a redemption)
 * request {"name","chain":[ids],"certs":{...},"known":[ids]}
 */

class CoinHeader(val json: JsonObject) {
    val v: Int get() = if (json.has("v")) json.int("v") else 0
    val label: String get() = json.optStr("label", "coin")!!
    val coinId: String get() = json.str("coinId")
    val chainId: String get() = json.str("chainId")
    val escrow: String get() = json.str("escrow")
    val expiry: Long get() = json.long("expiry")
    val value: BigInteger get() = BigInteger(json.str("value"))
    val k0: List<String> get() = json.arr("k0").strings()
    val k0x: String? get() = json.optStr("k0x")
    val k0y: String? get() = json.optStr("k0y")
    val depositor: String get() = json.optStr("depositor", "0".repeat(40))!!
}

data class Output(val value: BigInteger, val key: String) {
    fun toJson(): JsonObject = buildJsonObject { put("value", value.toString()); put("key", key) }

    companion object {
        fun list(a: JsonArray): List<Output> = a.objects().map { Output(BigInteger(it.str("value")), it.str("key")) }
        fun toJson(outs: List<Output>) = JsonArray(outs.map { it.toJson() })
    }
}

class SpendRecord(val json: JsonObject) {
    val outputs: List<Output> get() = Output.list(json.arr("outputs"))
    val index: Int get() = json.int("index")
    val sig: String get() = json.str("sig")
    val next: List<String> get() = json.arr("next").strings()
}

class Bundle(val json: JsonObject) {
    val header: CoinHeader get() = CoinHeader(json.obj("header"))
    val path: List<SpendRecord> get() = json.arr("path").objects().map { SpendRecord(it) }
    val certs: JsonObject? get() = json.optObj("certs")
    val redeem: JsonObject? get() = json.optObj("redeem")
}

class ReceiveRequest(val json: JsonObject) {
    val name: String get() = json.str("name")
    val chain: List<String> get() = json.arr("chain").strings()
    val certs: JsonObject get() = json.optObj("certs") ?: JsonObject(emptyMap())
    val known: List<String> get() = json["known"]?.let { (it as? JsonArray)?.strings() } ?: emptyList()
    /** Payee's light-client committee range {"min","max"} (absent from harness requests). */
    val lc: JsonObject? get() = json.optObj("lc")
}

/**
 * A note held by this wallet: `files/wallet/note_<alias>.json`, same fields as the harness
 * (header, path, alias, value, noteId, spent, signedTo, signedBundle, redeemedTo) plus app-only fields:
 *  - pendingDeposit: minted here, the wallet has not yet confirmed the on-chain deposit
 *  - depositedAt / createdAt: unix seconds (display only)
 */
class Note(val json: JsonObject) {
    val header: CoinHeader get() = CoinHeader(json.obj("header"))
    val path: List<SpendRecord> get() = json.arr("path").objects().map { SpendRecord(it) }
    val depth: Int get() = json.arr("path").size
    val alias: String get() = json.str("alias")
    val value: BigInteger get() = BigInteger(json.str("value"))
    val noteId: String get() = json.str("noteId")
    val spent: Boolean get() = json.has("spent")
    val signedTo: String? get() = json.optStr("signedTo")
    val signedBundle: String? get() = json.optStr("signedBundle")
    val redeemedTo: String? get() = json.optStr("redeemedTo")
    val pendingDeposit: Boolean get() = json.bool("pendingDeposit")
    val createdAt: Long? get() = json.optStr("createdAt")?.toLongOrNull()
    val label: String get() = header.label
    val isGenesis: Boolean get() = depth == 0
}

