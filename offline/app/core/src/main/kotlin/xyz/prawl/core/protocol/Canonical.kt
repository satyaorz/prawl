package xyz.prawl.core.protocol

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import xyz.prawl.core.model.Bundle
import xyz.prawl.core.model.CoinHeader
import xyz.prawl.core.model.Note
import xyz.prawl.core.model.Output
import xyz.prawl.core.util.Bytes
import xyz.prawl.core.util.EcdsaDer
import xyz.prawl.core.util.arr
import xyz.prawl.core.util.objects
import xyz.prawl.core.util.optStr
import java.math.BigInteger

/** A string that goes into a signed message is not in the one form the escrow can rebuild. */
class NonCanonicalException(msg: String) : IllegalArgumentException(msg)

/**
 * Canonical text of everything that is concatenated into a spend message (audit F1).
 *
 * The spend message is plain TEXT: `PRAWL-OTK-v3|chainId|escrow40|coinId|expiry|depth|parentNoteId|outputsHash`, with
 * `outputsHash = sha256hex(join(";", value:keyHash))`. The escrow rebuilds it from `uint256` / `address` / `bytes32`, so it can
 * only produce ONE spelling: decimal without leading zeros, lowercase hex without `0x`. A wallet that rebuilds the text from the
 * raw strings of a bundle would also accept a signature over any other spelling (an uppercase sibling key hash, an uppercase
 * coinId, a `0x`-prefixed escrow, a chainId with leading zeros), which `redeem` can then never verify (`BadSig`), and the
 * depositor reclaims after expiry. So everything is rejected unless it is canonical.
 *
 * Covered, as raw strings: header chainId, escrow, coinId, expiry, value; every output value, key and the followed index; every
 * spend signature (strict DER: its lowercase hex is part of the child note id, and the escrow rebuilds DER from (r, s)); the
 * parent note id; and the number of outputs per spend ([Protocol.MAX_OUTPUTS], audit F2).
 */
object Canonical {
    private val HEX64 = Regex("^[0-9a-f]{64}$")
    private val HEX40 = Regex("^[0-9a-f]{40}$")
    private val DEC = Regex("^(0|[1-9][0-9]*)$")
    private val TWO_256 = BigInteger.ONE.shiftLeft(256)
    private val TWO_64 = BigInteger.ONE.shiftLeft(64)

    fun isHex64(s: String) = HEX64.matches(s)
    fun isHex40(s: String) = HEX40.matches(s)
    /** Decimal, no leading zeros, no sign, no exponent, fits uint256. */
    fun isUint256(s: String) = s.length <= 78 && DEC.matches(s) && BigInteger(s) < TWO_256
    fun isPositiveUint256(s: String) = isUint256(s) && s != "0"
    fun isUint64(s: String) = s.length <= 20 && DEC.matches(s) && BigInteger(s) < TWO_64

    /** Problems with the header strings that enter the message (empty = canonical). */
    fun headerProblems(h: JsonObject): List<String> {
        val p = ArrayList<String>()
        fun raw(k: String): String? = (h[k] as? JsonPrimitive)?.content
        raw("chainId").let { if (it == null || !isUint256(it)) p.add("chainId '${show(it)}' is not canonical decimal") }
        raw("escrow").let { if (it == null || !isHex40(it)) p.add("escrow '${show(it)}' is not 40 lowercase hex digits without 0x") }
        raw("coinId").let { if (it == null || !isHex64(it)) p.add("coinId '${show(it)}' is not 64 lowercase hex digits without 0x") }
        raw("expiry").let { if (it == null || !isUint64(it) || it == "0") p.add("expiry '${show(it)}' is not canonical decimal") }
        raw("value").let { if (it == null || !isPositiveUint256(it)) p.add("deposit value '${show(it)}' is not canonical positive decimal") }
        return p
    }

    /** Output-count rule of each spend: 1..[Protocol.MAX_OUTPUTS] (audit F2). Cheap: looks at array sizes only. */
    fun outputCountProblems(path: List<JsonObject>): List<String> {
        val p = ArrayList<String>()
        for ((d, s) in path.withIndex()) {
            val n = (s["outputs"] as? JsonArray)?.size
            if (n == null || n == 0) p.add("spend $d has no outputs")
            else if (n > Protocol.MAX_OUTPUTS) p.add("spend $d has too many outputs ($n > ${Protocol.MAX_OUTPUTS})")
        }
        return p
    }

    /**
     * Problems with the spends of [path] (the raw JSON of each spend record): output count (if [includeCounts]), output values and
     * keys, followed index, signature encoding.
     */
    fun pathProblems(path: List<JsonObject>, includeCounts: Boolean = true): List<String> {
        val p = ArrayList<String>()
        if (includeCounts) { p.addAll(outputCountProblems(path)); if (p.isNotEmpty()) return p }   // never walk an oversized list
        for ((d, s) in path.withIndex()) {
            val outs = (s["outputs"] as? JsonArray) ?: continue
            for ((i, o) in outs.withIndex()) {
                val oo = o as? JsonObject
                val v = (oo?.get("value") as? JsonPrimitive)?.content
                val k = (oo?.get("key") as? JsonPrimitive)?.content
                if (v == null || !isPositiveUint256(v)) p.add("spend $d output $i: value '${show(v)}' is not canonical positive decimal")
                if (k == null || !isHex64(k)) p.add("spend $d output $i: key '${show(k)?.take(70)}' is not 64 lowercase hex digits without 0x")
            }
            val idx = (s["index"] as? JsonPrimitive)?.content
            if (idx == null || !DEC.matches(idx) || idx.length > 6 || idx.toInt() >= outs.size) p.add("spend $d: index '${show(idx)}' is not a canonical index into the outputs")
            val sig = (s["sig"] as? JsonPrimitive)?.content
            val der = try { sig?.let { Bytes.unb64(it) } } catch (e: Exception) { null }
            if (der == null || !EcdsaDer.isCanonical(der)) p.add("spend $d: signature is not strict canonical DER (the escrow rebuilds it from r and s)")
        }
        return p
    }

    /** The raw spend records of a bundle, or null if the structure is wrong. */
    fun spendRecords(b: Bundle): List<JsonObject>? = try { b.json.arr("path").map { it as? JsonObject ?: return null } } catch (e: Exception) { null }

    /** Everything about a received [bundle]; empty = every string in every signed message is canonical. */
    fun bundleProblems(b: Bundle): List<String> {
        val hdr = try { b.json["header"] as? JsonObject } catch (e: Exception) { null } ?: return listOf("bundle has no header")
        val path = spendRecords(b) ?: return listOf("bundle has no valid path")
        val counts = outputCountProblems(path)
        if (counts.isNotEmpty()) return counts
        return headerProblems(hdr) + pathProblems(path, includeCounts = false)
    }

    /** The same for a note held by this wallet (header, path, parent note id): checked before anything is signed from it. */
    fun noteProblems(n: Note): List<String> {
        val p = ArrayList<String>()
        p.addAll(headerProblems(n.header.json))
        n.json.optStr("noteId").let { if (it == null || !isHex64(it)) p.add("noteId '${show(it)?.take(70)}' is not 64 lowercase hex digits") }
        p.addAll(pathProblems(n.json.arr("path").objects()))
        return p
    }

    // ---- hard requirements used by Protocol (a message is never built from non-canonical text)

    fun requireHeader(h: CoinHeader) {
        val p = headerProblems(h.json)
        if (p.isNotEmpty()) throw NonCanonicalException(p.first())
    }

    fun requireOutputs(outs: List<Output>) {
        if (outs.isEmpty()) throw NonCanonicalException("a spend needs at least one output")
        if (outs.size > Protocol.MAX_OUTPUTS) throw NonCanonicalException("a spend may have at most ${Protocol.MAX_OUTPUTS} outputs (${outs.size})")
        for (o in outs) {
            if (o.value.signum() <= 0 || o.value >= TWO_256) throw NonCanonicalException("output value ${o.value} is out of range")
            if (!isHex64(o.key)) throw NonCanonicalException("output key is not 64 lowercase hex digits")
        }
    }

    private fun show(s: String?) = s?.let { if (it.length > 40) it.take(40) + "…" else it }
}

