package xyz.prawl.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test
import xyz.prawl.core.certs.CertResolver
import xyz.prawl.core.deposit.CompositeDepositVerifier
import xyz.prawl.core.deposit.DepositCommitment
import xyz.prawl.core.deposit.ExecutionHeaderRlp
import xyz.prawl.core.deposit.Http
import xyz.prawl.core.deposit.LightClient
import xyz.prawl.core.deposit.LightClientDepositVerifier
import xyz.prawl.core.deposit.LightClientEndpoints
import xyz.prawl.core.deposit.LightClientStore
import xyz.prawl.core.deposit.Rlp
import xyz.prawl.core.model.Bundle
import xyz.prawl.core.model.CoinHeader
import xyz.prawl.core.model.ReceiveRequest
import xyz.prawl.core.protocol.PaymentVerifier
import xyz.prawl.core.protocol.RecipientPolicy
import xyz.prawl.core.protocol.VerificationReport
import xyz.prawl.core.util.Bytes
import xyz.prawl.core.util.Js
import xyz.prawl.core.util.obj
import xyz.prawl.core.util.str
import xyz.prawl.core.util.with
import xyz.prawl.otktest.DepositProof
import java.io.File
import java.nio.file.Files

/**
 * The light-client deposit verifier (raw/v3/deposit_proofs, DepositProof.java + blst JNI) behind DepositVerifier,
 * on the REAL Sepolia proof of the real escrow deposit of coin "web1" (0xa63e5cb3…), and the real bundle that
 * spent it (Samsung -> OnePlus).
 */
class LightClientTest {
    companion object {
        val dp = File(Vectors.raw, "v3/deposit_proofs/data")
        val vec = File(dp, "vectors")
        @JvmStatic @BeforeClass fun native() { DepositProof.loadNative(System.getProperty("prawl.native")) }
    }

    private fun tmpStore(cache: String = "cache_now.json"): LightClientStore {
        val d = Files.createTempDirectory("lc").toFile()
        return LightClientStore(d).also { it.saveCache(File(vec, cache).readText()) }
    }

    private val noHttp = object : Http {
        override fun get(url: String) = error("offline")
        override fun post(url: String, body: String) = error("offline")
    }
    private val ep = LightClientEndpoints("https://beacon", listOf("https://checker"), "https://rpc")
    private fun lc(store: LightClientStore) = LightClient(store, noHttp, ep, { Vectors.NOW_S })

    private val web1 = CoinHeader(Vectors.json(Vectors.ho, "mint3_web1.json"))
    private val realProof get() = Js.parse(File(dp, "proof_escrow_v3_a63e5cb3b32f1457.json").readText())

    /** The 50 shared accept/reject vectors still pass through the copied class and native library. */
    @Test fun sharedVectors() {
        val manifest = Js.parseArray(File(vec, "manifest.json").readText())
        var ok = 0
        for (e in manifest) {
            val v = e as JsonObject
            val cache = DepositProof.Cache.fromJson(File(vec, v.str("cache")).readText())
            if (v["min_participants"] !is kotlinx.serialization.json.JsonNull) continue   // needs package-private threshold override
            val exp = (v["expected_value"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.let { Bytes.unhex(it) }
            val now = (v["now"] as? JsonPrimitive)?.content?.toLongOrNull() ?: -1L
            val r = DepositProof.verify(cache, File(vec, v.str("proof")).readText(), Bytes.unhex(v.str("address")), Bytes.unhex(v.str("key")), exp, now)
            val got = if (r.ok) "accept" else "reject"
            assertEquals(v.str("name") + ": " + r.summary(), v.str("expect"), got)
            ok++
        }
        assertTrue(ok >= 49)
    }

    @Test fun realEscrowDepositProofBacksTheRealCoin() {
        val store = tmpStore()
        var saved: String? = null
        val v = LightClientDepositVerifier(lc(store).backend) { id, _ -> saved = id }
        val res = CertResolver(Vectors.certStore(Vectors.ho), Vectors.anchors)
        val k0 = res.leafKey(web1.k0)
        val b = Bundle(buildJsonObject { put("header", web1.json); put("path", JsonArray(emptyList())); put("depositProof", realProof) })
        val c = v.check(web1, k0, null, b, Vectors.NOW_S)
        assertTrue(c.detail, c.backed)
        assertEquals(web1.coinId, saved)
        // the commitment the escrow stored equals the one computed from the header
        assertEquals(realProof.obj("storage").str("value").removePrefix("0x"), Bytes.hex(DepositCommitment.commitment(web1)))
    }

    @Test fun proofRejectsAlteredHeaderOtherCoinUntrustedEscrowAndMissingCache() {
        val res = CertResolver(Vectors.certStore(Vectors.ho), Vectors.anchors)
        val k0 = res.leafKey(web1.k0)
        fun check(h: CoinHeader, proof: JsonObject, store: LightClientStore = tmpStore()) =
            LightClientDepositVerifier(lc(store).backend).check(h, k0, null,
                Bundle(buildJsonObject { put("header", h.json); put("path", JsonArray(emptyList())); put("depositProof", proof) }), Vectors.NOW_S)
        assertFalse(check(CoinHeader(web1.json.with("value", "6000000000000000")), realProof).backed)
        assertFalse(check(CoinHeader(web1.json.with("depositor", "03a62b04abe69f382bd7582f492be735b1ddb47b")), realProof).backed)
        assertFalse(check(CoinHeader(web1.json.with("expiry", web1.expiry + 1)), realProof).backed)
        // a real proof about another coin id (absent slot)
        assertFalse(check(web1, Js.parse(File(dp, "proof_escrow_v3_absent.json").readText())).backed)
        // a look-alike escrow: the proof's contract must be the trusted escrow
        val fake = CoinHeader(web1.json.with("escrow", "7b79995e5f793a07bc00c21412e50ecae098e7f9"))
        assertTrue(check(fake, realProof).detail.contains("not the trusted escrow"))
        // no committee cache on this phone
        val empty = LightClientStore(Files.createTempDirectory("lc0").toFile())
        assertFalse(check(web1, realProof, empty).backed)
        // header key swapped
        assertFalse(LightClientDepositVerifier(lc(tmpStore()).backend).check(web1, res.leafKey(ReceiveRequest(Vectors.json(Vectors.ho, "req_bobw.json")).chain),
            null, Bundle(buildJsonObject { put("header", web1.json); put("path", JsonArray(emptyList())); put("depositProof", realProof) }), Vectors.NOW_S).backed)
    }

    /** Recipient-side verify of the REAL web1 bundle with only the light-client proof (no snapshot at all). */
    @Test fun realBundleAcceptedOnLightClientProofAlone() {
        val rep = verifyWeb1(Vectors.json(Vectors.ho, "pay3_web1_bobw.json").with("depositProof", realProof), tmpStore())
        assertTrue(rep.fails.toString(), rep.accepted)
        assertTrue(rep.lines.first { it.step == "1" }.detail.startsWith(LightClient.NAME))
        // without the proof (and no snapshot) the same bundle is rejected
        val rep2 = verifyWeb1(Vectors.json(Vectors.ho, "pay3_web1_bobw.json"), tmpStore())
        assertTrue(rep2.fails.contains("not backed by a known deposit"))
    }

    private fun verifyWeb1(bundle: JsonObject, store: LightClientStore): VerificationReport {
        val req = ReceiveRequest(Vectors.json(Vectors.ho, "req_bobw.json"))
        val res = CertResolver(Vectors.certStore(Vectors.ho), Vectors.anchors)
        val deposits = CompositeDepositVerifier(listOf(LightClientDepositVerifier(lc(store).backend)))
        return PaymentVerifier(res, Vectors.verifier(), deposits, RecipientPolicy(), Vectors.anchors.revocationFetchedAt)
            .verify(Bundle(bundle), req.name, res.leafKeyHash(req.chain, req.certs), Vectors.NOW_S)
    }

    /** A recipient whose cache is 3 periods old: the payer attaches the LightClientUpdates it stored at its sync. */
    @Test fun payerAttachesUpdatesForAStaleRecipient() {
        val payer = tmpStore()
        payer.saveProof(web1.coinId, realProof.toString())
        for (e in Js.parseArray(File(dp, "raw/updates_1403_1405.json").readText())) {
            val d = (e as JsonObject).obj("data")
            payer.saveUpdate(DepositProof.periodAtSlot(d.obj("attested_header").obj("beacon").str("slot").toLong()), d.toString())
        }
        val recipient = tmpStore("cache_1403_stale.json")
        val stale = lc(recipient).advertisement()!!
        assertEquals("1403", (stale["max"] as JsonPrimitive).content)
        // as built (no updates): the stale recipient cannot verify it
        assertFalse(verifyWeb1(Vectors.json(Vectors.ho, "pay3_web1_bobw.json").with("depositProof", realProof), recipient).accepted)
        val forwarded = lc(payer).proofFor(web1.coinId, stale)!!
        assertEquals(3, (forwarded["updates"] as JsonArray).size)
        val rep = verifyWeb1(Vectors.json(Vectors.ho, "pay3_web1_bobw.json").with("depositProof", forwarded), recipient)
        assertTrue(rep.fails.toString(), rep.accepted)
        // and the recipient learned the committees (persisted)
        assertEquals("1406", (lc(recipient).advertisement()!!["max"] as JsonPrimitive).content)
        // a recipient with a fresh cache gets the proof without updates
        assertEquals(0, (lc(payer).proofFor(web1.coinId, lc(tmpStore()).advertisement())!!["updates"] as JsonArray).size)
        // a recipient that bootstrapped after the proof was signed cannot verify it: nothing to send
        assertEquals(null, lc(payer).proofFor(web1.coinId, buildJsonObject { put("min", 1407); put("max", 1408) }))
    }

    /** First sync: bootstrap from the beacon's finalized checkpoint, which an independent node must confirm. */
    @Test fun bootstrapRequiresAnIndependentConfirmation() {
        val raw = File(dp, "raw")
        val root = File(raw, "bootstrap_anchor_now.root").readText().trim()
        val boot = File(raw, "bootstrap_anchor_now.json").readText()
        val stateRoot = Js.parse(boot).obj("data").obj("header").obj("beacon").str("state_root")
        fun http(checkerStateRoot: String) = object : Http {
            override fun get(url: String): String = when {
                url.endsWith("/finality_checkpoints") -> """{"data":{"finalized":{"root":"$root","epoch":"1"}}}"""
                url.contains("/light_client/bootstrap/") -> boot
                url.contains("/light_client/updates") -> File(raw, "updates_1403_1405.json").readText()
                url.startsWith("https://checker/eth/v1/beacon/headers/") -> """{"data":{"root":"$root","canonical":true,"header":{"message":{"state_root":"$checkerStateRoot"}}}}"""
                else -> error("unexpected $url")
            }
            override fun post(url: String, body: String) = error("no rpc")
        }
        val s1 = LightClientStore(Files.createTempDirectory("lcb").toFile())
        val msg = LightClient(s1, http(stateRoot), ep, { Vectors.NOW_S }).syncCommittees()
        assertTrue(msg, lc(s1).advertisement() != null)
        assertNotNull(s1.update(1405))
        val s2 = LightClientStore(Files.createTempDirectory("lcb2").toFile())
        assertThrows { LightClient(s2, http("0x" + "00".repeat(32)), ep, { Vectors.NOW_S }).syncCommittees() }
        assertEquals(null, s2.cacheJson())
    }

    /** The RLP encoder reproduces the real Gloas/Amsterdam execution header carried in the proof. */
    @Test fun rlpReencodesRealExecutionHeader() {
        val ex = realProof.obj("execution")
        val raw = Bytes.unhex(ex.str("header_rlp"))
        val fields = decodeList(raw)
        assertEquals((ex["header_fields"] as JsonArray).size, fields.size)
        assertTrue(Rlp.list(fields).contentEquals(raw))
        assertEquals(ex.str("block_hash").removePrefix("0x"), Bytes.hex(DepositProof.keccak256(raw)))
        // and from eth_getBlockByHash-style JSON
        val names = (ex["header_fields"] as JsonArray).map { (it as JsonPrimitive).content }
        val ints = setOf("difficulty", "number", "gasLimit", "gasUsed", "timestamp", "baseFeePerGas", "blobGasUsed", "excessBlobGas", "slotNumber")
        val blk = buildJsonObject {
            put("hash", ex.str("block_hash"))
            names.zip(fields).forEach { (k, v) -> put(k, if (k in ints) "0x" + (if (v.isEmpty()) "0" else java.math.BigInteger(1, v).toString(16)) else "0x" + Bytes.hex(v)) }
        }
        val (re, order) = ExecutionHeaderRlp.fromJson(blk)
        assertTrue(re.contentEquals(raw)); assertEquals(names, order)
    }

    private fun decodeList(b: ByteArray): List<ByteArray> {
        fun len(off: Int, n: Int): Int { var l = 0; for (i in 0 until n) l = (l shl 8) or (b[off + i].toInt() and 0xff); return l }
        val p0 = b[0].toInt() and 0xff
        var i = if (p0 <= 0xf7) 1 else 1 + (p0 - 0xf7)
        val out = ArrayList<ByteArray>()
        while (i < b.size) {
            val x = b[i].toInt() and 0xff
            when {
                x < 0x80 -> { out.add(byteArrayOf(b[i])); i++ }
                x <= 0xb7 -> { val l = x - 0x80; out.add(b.copyOfRange(i + 1, i + 1 + l)); i += 1 + l }
                else -> { val n = x - 0xb7; val l = len(i + 1, n); out.add(b.copyOfRange(i + 1 + n, i + 1 + n + l)); i += 1 + n + l }
            }
        }
        return out
    }
}
