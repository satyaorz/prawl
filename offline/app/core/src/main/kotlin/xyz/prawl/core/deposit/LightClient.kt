package xyz.prawl.core.deposit

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import xyz.prawl.core.store.FileNoteStore
import xyz.prawl.core.util.Bytes
import xyz.prawl.core.util.Js
import xyz.prawl.core.util.arr
import xyz.prawl.core.util.obj
import xyz.prawl.core.util.objects
import xyz.prawl.core.util.optObj
import xyz.prawl.core.util.optStr
import xyz.prawl.core.util.str
import xyz.prawl.otktest.DepositProof
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.math.BigInteger
import java.net.HttpURLConnection
import java.net.URL

/**
 * Light-client deposit proofs (raw/v3/deposit_proofs): the recipient checks OFFLINE that escrow slot
 * `deposits[coinId]` held keccak256(abi.encode(value, expiry, k0x, k0y, depositor)) at a finalized Sepolia block,
 * trusting only the sync committee (>= 342 of 512) and its own committee cache.
 *
 * The verifier is `xyz.prawl.otktest.DepositProof` (copied unchanged; BLS via blst/JNI in libprawlbls.so).
 * This file adds what the app needs around it: a persisted committee cache, online sync (bootstrap + updates),
 * building a proof for the phone's own coin, attaching updates for a recipient whose cache is older, and the
 * [DepositProofBackend] used by [LightClientDepositVerifier].
 */
class LightClientStore(private val dir: File) {
    private val updatesDir = File(dir, "updates")
    private val proofsDir = File(dir, "proofs")
    init { updatesDir.mkdirs(); proofsDir.mkdirs() }

    fun cacheJson(): String? = File(dir, "cache.json").takeIf { it.exists() }?.readText()
    fun saveCache(json: String) = FileNoteStore.atomicWrite(File(dir, "cache.json"), json)

    /** Raw LightClientUpdate (the `data` object) whose attested period is [period]; it teaches period+1. */
    fun update(period: Long): String? = File(updatesDir, "$period.json").takeIf { it.exists() }?.readText()
    fun saveUpdate(period: Long, dataJson: String) = FileNoteStore.atomicWrite(File(updatesDir, "$period.json"), dataJson)

    fun proof(coinId: String): String? = File(proofsDir, coinId.lowercase().removePrefix("0x") + ".json").takeIf { it.exists() }?.readText()
    fun saveProof(coinId: String, json: String) {
        val id = coinId.lowercase().removePrefix("0x")
        require(Bytes.isHex(id, 64)) { "bad coin id" }
        FileNoteStore.atomicWrite(File(proofsDir, "$id.json"), json)
    }

    var lastSync: Long
        get() = File(dir, "last_sync").takeIf { it.exists() }?.readText()?.trim()?.toLongOrNull() ?: 0
        set(v) = FileNoteStore.atomicWrite(File(dir, "last_sync"), v.toString())
}

/** Minimal HTTP client (GET / JSON-RPC POST). Replaceable in tests. */
interface Http {
    fun get(url: String): String
    fun post(url: String, body: String): String
}

class UrlHttp(private val timeoutMs: Int = 30_000, private val tries: Int = 3) : Http {
    private fun call(url: String, body: String?): String {
        var last: Exception? = null
        repeat(tries) { i ->
            try {
                val c = URL(url).openConnection() as HttpURLConnection
                c.connectTimeout = timeoutMs; c.readTimeout = timeoutMs
                c.setRequestProperty("Accept", "application/json")
                c.setRequestProperty("User-Agent", "prawl-offline/1")
                if (body != null) {
                    c.requestMethod = "POST"; c.doOutput = true
                    c.setRequestProperty("Content-Type", "application/json")
                    c.outputStream.use { it.write(body.toByteArray()) }
                }
                try {
                    if (c.responseCode != 200) throw IOException("HTTP ${c.responseCode} from ${URL(url).host}")
                    return c.inputStream.use { it.readBytes().toString(Charsets.UTF_8) }
                } finally { c.disconnect() }
            } catch (e: Exception) { last = e; Thread.sleep(500L * (i + 1)) }
        }
        throw IOException("request to ${URL(url).host} failed: ${last?.message}", last)
    }
    override fun get(url: String) = call(url, null)
    override fun post(url: String, body: String) = call(url, body)
}

/**
 * Endpoints (build-time config). Beacon: light-client routes (Nimbus serves bootstrap/updates/finality_update).
 * Checkers: independent beacon nodes that must confirm a first bootstrap checkpoint. RPC: eth_getProof at finalized
 * depth (Geth); rpc2 (optional) must return the identical proof.
 */
data class LightClientEndpoints(
    val beacon: String,
    val checkers: List<String>,
    val rpc: String,
    val rpc2: String? = null,
)

class LightClient(
    val store: LightClientStore,
    private val http: Http,
    private val ep: LightClientEndpoints,
    private val nowS: () -> Long = { System.currentTimeMillis() / 1000 },
    private val log: (String) -> Unit = {},
    /** False if libprawlbls.so could not be loaded (e.g. an unsupported ABI): proofs are then not checked. */
    private val nativeReady: () -> Boolean = { true },
) {
    fun cache(): DepositProof.Cache? = store.cacheJson()?.let { runCatching { DepositProof.Cache.fromJson(it) }.getOrNull() }

    fun currentPeriod(): Long = DepositProof.periodAtSlot((nowS() - DepositProof.GENESIS_TIME) / 12)

    data class Status(val minPeriod: Long?, val maxPeriod: Long?, val validUntil: Long?, val lastSync: Long)

    fun status(): Status {
        val c = store.cacheJson()?.let { runCatching { Js.parse(it) }.getOrNull() }
        val periods = c?.arr("committees")?.objects()?.mapNotNull { it.optStr("period")?.toLongOrNull() }.orEmpty()
        val cache = cache()
        return Status(periods.minOrNull(), periods.maxOrNull(), cache?.validUntilUnix(), store.lastSync)
    }

    /**
     * True when this phone cannot check deposits offline with what it has: no committees at all (nothing a payer can attach helps then,
     * the phone has no committee to trust an update with), or none for the current period. Sync while online.
     */
    fun needsSync(): Boolean = cache() == null || currentPeriod() > (status().maxPeriod ?: -1)

    /** Periods this phone can verify, advertised in receive requests so payers can attach missing updates. */
    fun advertisement(): JsonObject? {
        val s = status()
        if (s.minPeriod == null || s.maxPeriod == null) return null
        return buildJsonObject { put("min", s.minPeriod); put("max", s.maxPeriod) }
    }

    // ================================================================ online sync

    /**
     * Online: first run bootstraps from the finalized checkpoint of [LightClientEndpoints.beacon], confirmed by at
     * least one independent checker (same root, same state root); later runs only apply LightClientUpdates, each
     * verified by a committee the phone already trusts. Raw updates are kept to forward to recipients.
     */
    fun syncCommittees(): String {
        var cache = cache()
        if (cache == null) {
            val root = Js.parse(http.get(ep.beacon + "/eth/v1/beacon/states/head/finality_checkpoints")).obj("data").obj("finalized").str("root").lowercase()
            val bootRaw = http.get(ep.beacon + "/eth/v1/beacon/light_client/bootstrap/$root")
            val boot = Js.parse(bootRaw)
            require(boot.optStr("version") == "gloas") { "bootstrap version ${boot.optStr("version")}" }
            val stateRoot = boot.obj("data").obj("header").obj("beacon").str("state_root").lowercase()
            var confirmations = 0
            for (c in ep.checkers) {
                val ok = runCatching {
                    val h = Js.parse(http.get("$c/eth/v1/beacon/headers/$root")).obj("data")
                    h.str("root").lowercase() == root && h.obj("header").obj("message").str("state_root").lowercase() == stateRoot
                }.getOrDefault(false)
                log("checkpoint $root at $c: " + if (ok) "confirmed" else "not confirmed")
                if (ok) confirmations++
            }
            require(confirmations >= 1) { "no independent beacon node confirmed the checkpoint; not trusting a single server" }
            cache = DepositProof.Cache.fromBootstrap(bootRaw, Bytes.unhex(root))
            log("bootstrapped at period ${cache.maxPeriod()}")
        }
        val c = cache!!
        val cur = currentPeriod()
        val start = c.maxPeriod() - 1
        val count = (cur - start + 1).coerceIn(1, 16)
        val arr = Js.parseArray(http.get(ep.beacon + "/eth/v1/beacon/light_client/updates?start_period=$start&count=$count"))
        var learned = 0
        for (e in arr) {
            val o = e as? JsonObject ?: continue
            if (o.optStr("version") != "gloas") continue
            val data = o.obj("data")
            val p = DepositProof.periodAtSlot(data.obj("attested_header").obj("beacon").str("slot").toLong())
            try {
                c.applyUpdates(JsonArray(listOf(o)).toString())
                store.saveUpdate(p, data.toString())
                learned++
            } catch (ex: Exception) { log("update for period $p rejected: ${ex.message}") }
        }
        val pruned = prune(c.toJson(), cur - KEEP_PERIODS)
        store.saveCache(pruned)
        store.lastSync = nowS()
        val s = status()
        return "committees for periods ${s.minPeriod}–${s.maxPeriod} ($learned update(s) applied)"
    }

    private fun prune(cacheJson: String, minPeriod: Long): String {
        val j = Js.parse(cacheJson)
        val cs = j.arr("committees").objects()
        val keep = cs.filter { (it.optStr("period")?.toLongOrNull() ?: 0) >= minPeriod }.ifEmpty { cs.takeLast(2) }
        return JsonObject(LinkedHashMap(j).also { it["committees"] = JsonArray(keep) }).toString()
    }

    // ================================================================ proofs

    /**
     * Online: builds the DepositProof for [coinIdHex] at the latest finalized block (port of builder.build_proof)
     * and checks it with the offline verifier against this phone's cache and [expected] before storing it.
     */
    fun buildProof(escrow40: String, coinIdHex: String, expected: ByteArray): DepositProof.Result {
        check(nativeReady()) { "BLS library unavailable on this phone" }
        val cache = cache() ?: throw IllegalStateException("sync the light client first")
        val fuResp = Js.parse(http.get(ep.beacon + "/eth/v1/beacon/light_client/finality_update"))
        require(fuResp.optStr("version") == "gloas") { "finality update version ${fuResp.optStr("version")}" }
        val fu = fuResp.obj("data")
        val ebh = fu.obj("finalized_header").str("execution_block_hash").lowercase()
        val blk = rpc(ep.rpc, "eth_getBlockByHash", buildJsonArray { add(JsonPrimitive(ebh)); add(JsonPrimitive(false)) }) as? JsonObject
            ?: throw IOException("execution RPC does not know block $ebh")
        val (rlp, order) = ExecutionHeaderRlp.fromJson(blk)
        val number = blk.str("number")
        val address = "0x$escrow40"
        val key = "0x" + Bytes.hex(DepositProof.escrowStorageKey(Bytes.unhex(coinIdHex)))
        val params = buildJsonArray { add(JsonPrimitive(address)); add(buildJsonArray { add(JsonPrimitive(key)) }); add(JsonPrimitive(number)) }
        val gp = rpc(ep.rpc, "eth_getProof", params) as JsonObject
        ep.rpc2?.let { r2 ->
            val gp2 = runCatching { rpc(r2, "eth_getProof", params) as JsonObject }.getOrNull()
            if (gp2 != null) require(gp2["accountProof"] == gp["accountProof"] &&
                gp2.arr("storageProof").objects()[0]["proof"] == gp.arr("storageProof").objects()[0]["proof"]) { "second RPC returned a different proof" }
        }
        val sp = gp.arr("storageProof").objects()[0]
        val value = Bytes.hex32(BigInteger(sp.str("value").removePrefix("0x").ifEmpty { "0" }, 16))
        val proof = buildJsonObject {
            put("version", DepositProof.PROOF_VERSION); put("network", DepositProof.NETWORK); put("updates", JsonArray(emptyList()))
            put("finality_update", buildJsonObject { for (k in listOf("attested_header", "finalized_header", "finality_branch", "sync_aggregate", "signature_slot")) put(k, fu[k]!!) })
            put("execution", buildJsonObject {
                put("block_hash", ebh); put("block_number", BigInteger(number.removePrefix("0x"), 16).toLong())
                put("header_rlp", "0x" + Bytes.hex(rlp)); put("header_fields", JsonArray(order.map { JsonPrimitive(it) }))
            })
            put("account", buildJsonObject { put("address", address); put("proof", gp["accountProof"]!!) })
            put("storage", buildJsonObject { put("key", key); put("value", value); put("proof", sp["proof"]!!) })
            put("meta", buildJsonObject { put("beacon", ep.beacon); put("rpc", ep.rpc); put("built_at", nowS()) })
        }.toString()
        val r = DepositProof.verify(cache, proof, Bytes.unhex(escrow40), DepositProof.escrowStorageKey(Bytes.unhex(coinIdHex)), expected, nowS())
        if (r.ok) { store.saveProof(coinIdHex, proof); store.saveCache(r.updatedCache.toJson()) }
        log("deposit proof for ${coinIdHex.take(16)}…: ${r.summary()}")
        return r
    }

    private fun rpc(url: String, method: String, params: JsonArray): JsonElement {
        val body = buildJsonObject { put("jsonrpc", "2.0"); put("id", 1); put("method", method); put("params", params) }.toString()
        val resp = Js.parse(http.post(url, body))
        resp.optObj("error")?.let { throw IOException("$method: $it") }
        return resp["result"] ?: throw IOException("$method: no result")
    }

    /**
     * The stored proof of a coin, prepared for a recipient that can verify periods [recipientMin, recipientMax]:
     * LightClientUpdates are attached so it can step its cache to the proof's signature period. Null if this phone
     * has no proof for the coin, or the proof is older than the recipient's oldest committee.
     */
    fun proofFor(coinId: String, recipient: JsonObject?): JsonObject? {
        val p = store.proof(coinId)?.let { runCatching { Js.parse(it) }.getOrNull() } ?: return null
        val sigPeriod = DepositProof.periodAtSlot(p.obj("finality_update").str("signature_slot").toLong())
        val rMin = recipient?.optStr("min")?.toLongOrNull()
        val rMax = recipient?.optStr("max")?.toLongOrNull() ?: return p      // unknown recipient cache: send as built
        if (rMin != null && sigPeriod < rMin) return null                     // recipient cannot go back in time
        if (sigPeriod <= rMax) return JsonObject(LinkedHashMap(p).also { it["updates"] = JsonArray(emptyList()) })
        val ups = (rMax until sigPeriod).map { store.update(it)?.let { u -> Js.parse(u) } ?: return p }
        return JsonObject(LinkedHashMap(p).also { it["updates"] = JsonArray(ups) })
    }

    /** Offline verification against the persisted cache; learned committees are persisted on success. */
    val backend: DepositProofBackend = object : DepositProofBackend {
        override fun verifyStorage(proofJson: String, escrow: ByteArray, storageKey: ByteArray, expectedValue: ByteArray, nowS: Long): DepositCheck {
            if (!nativeReady()) return DepositCheck(false, NAME, "BLS library unavailable on this phone")
            val cache = cache() ?: return DepositCheck(false, NAME, "no light-client committee cache on this phone (sync while online)")
            val r = DepositProof.verify(cache, proofJson, escrow, storageKey, expectedValue, nowS)
            if (!r.ok) return DepositCheck(false, NAME, r.error ?: "proof rejected")
            runCatching { store.saveCache(r.updatedCache.toJson()) }
            return DepositCheck(true, NAME, "finalized block ${r.blockNumber}, ${r.participants}/512 sync-committee signatures, " +
                String.format("%.0f ms", r.totalNanos / 1e6))
        }
    }

    companion object {
        const val NAME = "light-client deposit proof"
        /** Committees kept: about 34 days (coins live at most 30 days). */
        const val KEEP_PERIODS = 30L
    }
}

/** Rebuilds the RLP execution header from eth_getBlockByHash JSON (port of builder.header_rlp_from_json). */
object ExecutionHeaderRlp {
    private val INT_FIELDS = setOf("difficulty", "number", "gasLimit", "gasUsed", "timestamp", "baseFeePerGas", "blobGasUsed", "excessBlobGas", "slotNumber")
    private val BASE = listOf("parentHash", "sha3Uncles", "miner", "stateRoot", "transactionsRoot", "receiptsRoot", "logsBloom",
        "difficulty", "number", "gasLimit", "gasUsed", "timestamp", "extraData", "mixHash", "nonce",
        "baseFeePerGas", "withdrawalsRoot", "blobGasUsed", "excessBlobGas", "parentBeaconBlockRoot", "requestsHash")
    private val TAILS = listOf(emptyList(), listOf("blockAccessListHash"), listOf("blockAccessListHash", "slotNumber"), listOf("slotNumber", "blockAccessListHash"))

    fun fromJson(blk: JsonObject): Pair<ByteArray, List<String>> {
        val want = blk.str("hash").lowercase().removePrefix("0x")
        for (tail in TAILS) {
            val order = BASE + tail
            if (order.any { !blk.containsKey(it) }) continue
            val raw = Rlp.list(order.map { k -> field(k, blk.str(k)) })
            if (Bytes.hex(DepositProof.keccak256(raw)) == want) return raw to order
        }
        throw IOException("could not rebuild an execution header that hashes to 0x$want")
    }

    private fun field(k: String, v: String): ByteArray =
        if (k in INT_FIELDS) BigInteger(v.removePrefix("0x").ifEmpty { "0" }, 16).let { n -> if (n.signum() == 0) ByteArray(0) else Bytes.fixed(n, (n.bitLength() + 7) / 8) }
        else Bytes.unhex(v)
}

/** RLP encoding of byte strings and lists of byte strings. */
object Rlp {
    fun string(b: ByteArray): ByteArray = if (b.size == 1 && (b[0].toInt() and 0xff) < 0x80) b else header(0x80, 0xb7, b.size) + b
    fun list(items: List<ByteArray>): ByteArray {
        val payload = ByteArrayOutputStream().also { o -> items.forEach { o.write(string(it)) } }.toByteArray()
        return header(0xc0, 0xf7, payload.size) + payload
    }
    private fun header(short: Int, long: Int, len: Int): ByteArray {
        if (len <= 55) return byteArrayOf((short + len).toByte())
        val l = BigInteger.valueOf(len.toLong()).toByteArray().dropWhile { it == 0.toByte() }.toByteArray()
        return byteArrayOf((long + l.size).toByte()) + l
    }
}
