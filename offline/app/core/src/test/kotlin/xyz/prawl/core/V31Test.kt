package xyz.prawl.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import xyz.prawl.core.certs.MemoryCertStore
import xyz.prawl.core.deposit.CompositeDepositVerifier
import xyz.prawl.core.handoff.Handoff
import xyz.prawl.core.model.Bundle
import xyz.prawl.core.model.Output
import xyz.prawl.core.protocol.DepositParamsV31
import xyz.prawl.core.protocol.Escrows
import xyz.prawl.core.protocol.OfflineWallet
import xyz.prawl.core.protocol.OfflineWallet.RedeemOutcome
import xyz.prawl.core.protocol.OfflineWallet.RefreshOutcome
import xyz.prawl.core.protocol.Protocol
import xyz.prawl.core.protocol.RecipientPolicy
import xyz.prawl.core.protocol.Refresh
import xyz.prawl.core.protocol.ShieldRequest
import xyz.prawl.core.store.MemoryNoteStore
import xyz.prawl.core.util.Bytes
import xyz.prawl.core.util.Eth
import xyz.prawl.core.util.Js
import xyz.prawl.core.util.arr
import xyz.prawl.core.util.obj
import xyz.prawl.core.util.objects
import xyz.prawl.core.util.str
import xyz.prawl.core.util.with
import java.io.File
import java.math.BigInteger
import java.security.Signature

/** v3.1 phone side: shield cash-out, refresh, private load. Pure-function vectors come from escrow_v31 (Python reference + real kohaku request). */
class V31Test {
    private val v31 = File(Vectors.raw, "v3/escrow_v31")
    private val vectors = Js.parse(File(v31, "fixtures/v31_vectors.json").readText())
    private val kohaku = Js.parse(File(v31, "fixtures/railgun_shield_1e15.json").readText())
    private val escrows = vectors.arr("escrows").objects().map { it.str("chainId") to it.str("escrow").removePrefix("0x") }

    private fun names(k: String) = vectors.arr(k).map { (it as JsonPrimitive).content }

    // ------------------------------------------------------------------ pure vectors

    /** The real kohaku ShieldRequest: abi bytes and the sha256 the coordinator named. */
    @Test fun kohakuShieldHash() {
        val r = ShieldRequest.parse(kohaku)
        assertEquals("2b5ff8a94e78d1c735aa2ff9bee40b7497fa4b90d8faaedbc1beb0218255cd7c", r.hash())
        assertEquals(kohaku.str("abiEncoded").removePrefix("0x"), Bytes.hex(r.abi()))
        assertEquals(288, r.abi().size)
        assertEquals(kohaku.str("shieldHashSha256").removePrefix("0x"), r.hash())
        // also accepted wrapped in a shield-target object
        val wrapped = buildJsonObject { put("v", 1); put("t", "shield-target"); put("request", kohaku["request"]!!) }
        assertEquals(r.hash(), ShieldRequest.parse(wrapped).hash())
    }

    /** 4 requests (1 real, 3 synthetic incl. values near uint120) x 2 escrows: abi, hash and PRAWL-REDEEM-SHIELD output key equal tools/prawl_v3.py. */
    @Test fun shieldVectorsMatchPython() {
        for (n in names("shieldNames")) {
            val v = vectors.obj("shields").obj(n)
            val r = ShieldRequest.parse(v.obj("request"))
            assertEquals("$n abi", v.str("abi").removePrefix("0x"), Bytes.hex(r.abi()))
            assertEquals("$n hash", v.str("shieldHash").removePrefix("0x"), r.hash())
            val keys = v.arr("keyHash").map { (it as JsonPrimitive).content.removePrefix("0x") }
            escrows.forEachIndexed { i, (chain, esc) -> assertEquals("$n key[$i]", keys[i], r.outputKey(chain, esc)) }
        }
    }

    @Test fun refreshVectorsMatchPython() {
        for (n in names("refreshNames")) {
            val v = vectors.obj("refreshes").obj(n)
            val x = BigInteger(v.str("k0x").removePrefix("0x"), 16); val y = BigInteger(v.str("k0y").removePrefix("0x"), 16)
            val k0Hash = Refresh.keyHashXy(x, y)
            val keys = v.arr("keyHash").map { (it as JsonPrimitive).content.removePrefix("0x") }
            escrows.forEachIndexed { i, (chain, esc) ->
                assertEquals("$n key[$i]", keys[i], Refresh.outputKey(chain, esc, v.str("expiry").toLong(), k0Hash, v.str("depositor").removePrefix("0x")))
            }
        }
        for (e in vectors.arr("ids").objects()) {
            assertEquals(e.str("coinId").removePrefix("0x"), Refresh.coinId(e.str("msgHash"), e["index"].let { (it as JsonPrimitive).content.toInt() }))
            assertTrue(Refresh.isReserved(e.str("coinId")))
        }
    }

    @Test fun spkiHashOfPointEqualsEncodedKeyHash() {
        val kp = java.security.KeyPairGenerator.getInstance("EC").apply { initialize(java.security.spec.ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        val w = (kp.public as java.security.interfaces.ECPublicKey).w
        assertEquals(Bytes.sha256Hex(kp.public.encoded), Refresh.keyHashXy(w.affineX, w.affineY))
    }

    /** Deposit addresses (CREATE2 forwarder) for 4 parameter sets x 2 escrows. */
    @Test fun depositAddressesMatchPython() {
        for (n in names("depositNames")) {
            val v = vectors.obj("deposits").obj(n)
            val p = v.obj("params")
            val params = DepositParamsV31.Params(p.str("coinId"), p.str("expiry").toLong(), BigInteger(p.str("k0x").removePrefix("0x"), 16), BigInteger(p.str("k0y").removePrefix("0x"), 16),
                p.str("depositor").removePrefix("0x"), BigInteger(p.str("minValue")), BigInteger(p.str("maxValue")), BigInteger(p.str("tip")))
            val addrs = v.arr("address").map { (it as JsonPrimitive).content.removePrefix("0x") }
            escrows.forEachIndexed { i, (_, esc) -> assertEquals("$n addr[$i]", addrs[i], DepositParamsV31.depositAddress(esc, params)) }
        }
    }

    @Test fun shieldRequestIsParsedStrictly() {
        val good = kohaku.obj("request")
        fun bad(f: (JsonObject) -> JsonObject) = assertThrows { ShieldRequest.parse(f(good)) }
        bad { it.with("value", "-1") }
        bad { it.with("value", "01") }
        bad { it.with("value", (BigInteger.ONE.shiftLeft(120)).toString()) }          // > uint120
        bad { it.with("npk", "0xzz") }
        bad { it.with("npk", "0x" + "11".repeat(33)) }
        bad { it.with("encryptedBundle", JsonArray(listOf(JsonPrimitive("0x01")))) }
        bad { it.with("tokenAddress", "0x" + "11".repeat(21)) }
        bad { JsonObject(it.filterKeys { k -> k != "shieldKey" }) }
    }

    // ------------------------------------------------------------------ wallet flows (software keys)

    private var now = Vectors.NOW_S * 1000
    private fun wallet(v31: Set<Pair<String, String>> = Escrows.V31) = OfflineWallet(FakeKeyVault(), MemoryNoteStore(), MemoryCertStore(), Vectors.anchors, FakeChecker(),
        { RecipientPolicy() }, { CompositeDepositVerifier(emptyList()) }, nowMillis = { now }, v31Escrows = v31)

    private fun coin(w: OfflineWallet, eth: String, escrow: String = Escrows.SEPOLIA_V31, label: String = "c"): xyz.prawl.core.model.Note {
        val m = w.mint(label, Eth.wei(eth), 7 * 86400, Escrows.SEPOLIA, escrow, "03a62b04abe69f382bd7582f492be735b1ddb47b", pendingDeposit = true)
        w.markDeposited(m.note.alias)
        return w.notes.note(m.note.alias)!!
    }

    private fun verifies(w: OfflineWallet, b: Bundle, message: ByteArray, sigB64: String, signerChain: List<String>): Boolean {
        val s = Signature.getInstance("SHA256withECDSA"); s.initVerify(w.certs.leafKey(signerChain, b.certs)); s.update(message)
        return s.verify(Bytes.unb64(sigB64))
    }

    @Test fun shieldCashOutOfTheKohakuRequest() {
        val w = wallet(); val n = coin(w, "0.001")
        val o = w.redeemShield(n.alias, kohaku, null)
        assertTrue((o as? RedeemOutcome.Refused)?.reason ?: "", o is RedeemOutcome.Signed)
        val bundle = (o as RedeemOutcome.Signed).bundle
        val rd = bundle.obj("redeem")
        assertEquals("shield", rd.str("kind"))
        assertEquals("0x" + "0".repeat(40), rd.str("payout"))
        assertEquals("0x2b5ff8a94e78d1c735aa2ff9bee40b7497fa4b90d8faaedbc1beb0218255cd7c", rd.str("shieldHash"))
        assertEquals(kohaku["request"], rd["shield"])
        // the signed output is exactly the REDEEM-SHIELD key for this escrow, and the signature covers it
        val b = Bundle(bundle); val h = b.header
        val outs = Output.list(rd.arr("outputs"))
        assertEquals(1, outs.size); assertEquals(n.value, outs[0].value)
        assertEquals(ShieldRequest.parse(kohaku).outputKey(h.chainId, h.escrow), outs[0].key)
        assertTrue(verifies(w, b, Protocol.spendMessage(h, 0, n.noteId, outs), rd.str("sig"), h.k0))
        // note spent, cannot be shielded or redeemed again
        assertTrue(w.notes.note(n.alias)!!.spent)
        assertTrue(w.redeemShield(n.alias, kohaku, null) is RedeemOutcome.Refused)
        // website payload: HANDOFF v1.1 §7
        val ho = o.handoff
        assertEquals("redeem-shield", ho.str("t"))
        assertEquals(kohaku["request"], ho["shield"])
        assertEquals("0x" + "0".repeat(40), ho.obj("redemption").str("payout"))
        assertEquals(h.escrow, ho.str("escrow").removePrefix("0x"))
        assertEquals(ho, Handoff.parseLink(Handoff.httpsLink("https://<site>", "redeem-shield", Handoff.encode(ho))).payload)
    }

    @Test fun shieldRefusals() {
        val w = wallet(); val n = coin(w, "0.001")
        val req = kohaku.obj("request")
        fun refused(target: JsonObject, what: String, wlt: OfflineWallet = w, alias: String = n.alias) {
            val o = wlt.redeemShield(alias, target, null)
            assertTrue("$what must be refused", o is RedeemOutcome.Refused)
            assertFalse("$what: note stays unspent", wlt.notes.note(alias)!!.spent)
            assertTrue("$what: key untouched", wlt.keys.exists(alias))
        }
        refused(req.with("value", "1000000000000001"), "value above the note")
        refused(req.with("value", "999999999999999"), "value below the note")
        refused(req.with("tokenType", "1"), "ERC721")
        refused(req.with("tokenAddress", "0x" + "ab".repeat(20)), "other token")
        refused(req.with("tokenSubID", "5"), "subID")
        refused(buildJsonObject { put("v", 1); put("t", "shield-target"); put("chainId", 1); put("escrow", "0x" + Escrows.SEPOLIA_V31); put("request", req) }, "another chain")
        refused(buildJsonObject { put("v", 1); put("t", "shield-target"); put("chainId", 11155111); put("escrow", "0x" + Escrows.SEPOLIA_V3); put("request", req) }, "another escrow")
        refused(JsonObject(req.filterKeys { it != "npk" }), "malformed")
        // a v3 coin cannot be shielded: v3 has no redeemToShield
        val w3 = wallet(); val c3 = coin(w3, "0.001", Escrows.SEPOLIA_V3)
        refused(req, "v3 escrow", w3, c3.alias)
        assertTrue(w3.checkShield(c3, req).failures.single().contains("v3.1") || w3.checkShield(c3, req).failures.any { it.contains("cannot pay into RAILGUN") })
        // value check lines are all green for the matching note
        assertTrue(w.checkShield(n, req).ok)
        assertEquals(listOf(n.alias), w.notesForShield(Eth.wei("0.001")).map { it.alias })
        assertTrue(w.notesForShield(Eth.wei("0.002")).isEmpty())
        // an expired note is refused
        now += 8 * 86400_000L
        assertTrue(w.redeemShield(n.alias, req, null) is RedeemOutcome.Refused)
    }

    @Test fun plainRedeemStillWorksOnBothEscrows() {
        for (esc in listOf(Escrows.SEPOLIA_V3, Escrows.SEPOLIA_V31)) {
            val w = wallet(); val n = coin(w, "0.01", esc)
            val o = w.redeem(n.alias, "03a62b04abe69f382bd7582f492be735b1ddb47b", null)
            assertTrue(o is RedeemOutcome.Signed)
            val ho = (o as RedeemOutcome.Signed).handoff
            assertEquals("redeem", ho.str("t")); assertEquals("0x$esc", ho.str("escrow"))
        }
    }

    @Test fun refreshSignsDerivesTheCoinIdAndMarkRefreshedCreatesTheNote() {
        val w = wallet(); val n = coin(w, "0.2")
        val keysBefore = w.keys.aliases().size
        val reclaim = "5aaeb6053f3e94c9b9a09f33669435e7ef1beaed"
        val o = w.refresh(n.alias, 14 * 86400L, reclaim, null)
        assertTrue((o as? RefreshOutcome.Refused)?.reason ?: "", o is RefreshOutcome.Signed)
        o as RefreshOutcome.Signed
        val bundle = o.bundle; val rd = bundle.obj("redeem"); val b = Bundle(bundle); val h = b.header
        assertEquals("refresh", rd.str("kind"))
        assertEquals("0x$reclaim", rd.str("payout"))
        val rf = rd.obj("refresh")
        // the new coin is NOT a spendable note yet, but the old one is spent and the new key is kept
        assertTrue(w.notes.note(n.alias)!!.spent)
        assertTrue(w.spendable().isEmpty())
        assertEquals(1, w.pendingRefreshes().size)
        assertTrue("the new genesis key is kept for the pending coin", w.keys.exists(w.pendingRefreshes().single().alias))
        assertFalse("the old single-use key is gone", w.keys.exists(n.alias))
        assertEquals(keysBefore, w.keys.aliases().size)     // one key spent, one created
        // outputs: one REFRESH output bound to (expiry, new key, reclaim); coin id derived from the signed message
        val outs = Output.list(rd.arr("outputs"))
        val newK0Hash = w.certs.leafKeyHash(rf.arr("k0").map { (it as JsonPrimitive).content }, b.certs)
        val expiry = (rf["expiry"] as JsonPrimitive).content.toLong()
        assertEquals(Vectors.NOW_S + 14 * 86400, expiry)
        assertEquals(Refresh.outputKey(h.chainId, h.escrow, expiry, newK0Hash, reclaim), outs.single().key)
        assertEquals(Refresh.keyHashXy(BigInteger(rf.str("k0x"), 16), BigInteger(rf.str("k0y"), 16)), newK0Hash)
        assertEquals(n.value, outs.single().value)
        val msg = Protocol.spendMessage(h, 0, n.noteId, outs)
        assertTrue(verifies(w, b, msg, rd.str("sig"), h.k0))
        val expectId = Refresh.coinId(Bytes.sha256Hex(msg), 0)
        assertEquals(expectId, o.newCoinId); assertEquals(expectId, rf.str("coinId"))
        assertTrue(expectId.startsWith("52465348"))
        // carried certificates include the new genesis key chain
        assertTrue(rf.arr("k0").all { id -> b.certs!!.containsKey((id as JsonPrimitive).content) || w.certs.rootIds.contains(id.content) })
        // website payload (provisional)
        val ho = o.handoff
        assertEquals("refresh", ho.str("t"))
        assertEquals("0x$reclaim", ho.obj("redemption").str("payout"))
        assertEquals("0x$expectId", ho.obj("refresh").str("newCoinId"))
        assertEquals(Bytes.hex32(BigInteger(rf.str("k0x"), 16)), ho.obj("refresh").str("newK0x"))
        // confirm: the genesis note of the new coin appears, spendable, with the new header
        val nn = w.markRefreshed(o.newCoinId)
        assertEquals(expectId, nn.header.coinId); assertEquals(0, nn.depth); assertEquals(n.value, nn.value)
        assertEquals(expiry, nn.header.expiry); assertEquals(reclaim, nn.header.depositor)
        assertEquals(Protocol.genesisNoteId(expectId), nn.noteId)
        assertEquals(1, w.spendable().size); assertTrue(w.pendingRefreshes().isEmpty())
        assertThrows { w.markRefreshed(o.newCoinId) }
        // and the new coin is a real coin: it can itself be cashed out with its own key
        assertTrue(w.redeem(nn.alias, reclaim, null) is RedeemOutcome.Signed)
        // an already-refreshed note cannot be refreshed or redeemed again
        assertTrue(w.refresh(n.alias, 86400L, reclaim, null) is RefreshOutcome.Refused)
    }

    @Test fun refreshRefusals() {
        val reclaim = "5aaeb6053f3e94c9b9a09f33669435e7ef1beaed"
        val w = wallet(); val n = coin(w, "0.2")
        val keys0 = w.keys.aliases().size
        fun refused(o: RefreshOutcome, what: String) { assertTrue("$what must be refused", o is RefreshOutcome.Refused); assertEquals("$what: no key left behind", keys0, w.keys.aliases().size); assertFalse(w.notes.note(n.alias)!!.spent) }
        refused(w.refresh(n.alias, 0, reclaim, null), "zero lifetime")
        refused(w.refresh(n.alias, 60, reclaim, null), "lifetime below a day")
        refused(w.refresh(n.alias, 29 * 86400L, reclaim, null), "lifetime above the window")
        refused(w.refresh(n.alias, 86400L, "0x" + "0".repeat(40), null), "zero reclaim")
        refused(w.refresh(n.alias, 86400L, "0x1234", null), "bad reclaim")
        // v3 coin: no refresh
        val w3 = wallet(); val c3 = coin(w3, "0.2", Escrows.SEPOLIA_V3)
        val k3 = w3.keys.aliases().size
        assertTrue(w3.refresh(c3.alias, 86400L, reclaim, null) is RefreshOutcome.Refused)
        assertEquals(k3, w3.keys.aliases().size)
        // hardware refuses (old key gone): the freshly made new key is deleted again
        w.keys.delete(n.alias)
        val k1 = w.keys.aliases().size
        assertTrue(w.refresh(n.alias, 86400L, reclaim, null) is RefreshOutcome.Refused)
        assertEquals(k1, w.keys.aliases().size)
        assertTrue(w.pendingRefreshes().isEmpty())
        // expired
        val w2 = wallet(); val c2 = coin(w2, "0.2"); now += 8 * 86400_000L
        assertTrue(w2.refresh(c2.alias, 86400L, reclaim, null) is RefreshOutcome.Refused)
    }

    @Test fun refreshedLabelsStayUnique() {
        val w = wallet(); val a = coin(w, "0.1", label = "x")
        val r1 = w.refresh(a.alias, 86400L, "5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", null) as RefreshOutcome.Signed
        val n1 = w.markRefreshed(r1.newCoinId)
        assertEquals("xr", n1.label)
        val r2 = w.refresh(n1.alias, 86400L, "5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", null) as RefreshOutcome.Signed
        assertEquals("xrr", w.markRefreshed(r2.newCoinId).label)
    }

    @Test fun privateLoadPayload() {
        val w = wallet()
        val m = w.mint("p", Eth.wei("0.005"), 14 * 86400, Escrows.SEPOLIA, Escrows.SEPOLIA_V31, "5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", pendingDeposit = true, privateLoad = true, tipWei = BigInteger("1000"))
        assertTrue(m.note.privateLoad); assertEquals(BigInteger("1000"), m.note.tipWei); assertTrue(m.note.pendingDeposit)
        val p = m.handoffPrivate
        assertEquals("load-private", p.str("t")); assertEquals("0x" + Escrows.SEPOLIA_V31, p.str("escrow"))
        val params = p.obj("params"); val h = m.note.header
        assertEquals("0x" + h.coinId, params.str("coinId"))
        assertEquals("5000000000000000", params.str("minValue")); assertEquals("5000000000000000", params.str("maxValue")); assertEquals("1000", params.str("tip"))
        assertEquals("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", params.str("depositor"))
        assertEquals(h.expiry, (params["expiry"] as JsonPrimitive).content.toLong())
        assertEquals(66, params.str("k0x").length)
        // the deposit address is the CREATE2 forwarder of exactly these parameters
        val dp = DepositParamsV31.Params(h.coinId, h.expiry, BigInteger(h.k0x!!, 16), BigInteger(h.k0y!!, 16), h.depositor, h.value, h.value, BigInteger("1000"))
        assertEquals("0x" + DepositParamsV31.depositAddress(Escrows.SEPOLIA_V31, dp), p.str("depositAddress"))
        // header k0 is the attested key; reclaim address = the header's depositor
        assertTrue(xyz.prawl.core.deposit.DepositCommitment.headerKeyMatches(h, w.certs.leafKey(h.k0)))
        assertEquals(p, Handoff.parseLink(Handoff.prawlLink("load-private", Handoff.encode(p))).payload)
        // refused on v3 (no commitDeposit), and a tip needs private load
        assertThrows { w.mint("q", Eth.wei("0.005"), 86400, Escrows.SEPOLIA, Escrows.SEPOLIA_V3, "5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", privateLoad = true) }
        assertThrows { w.mint("r", Eth.wei("0.005"), 86400, Escrows.SEPOLIA, Escrows.SEPOLIA_V31, "5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", tipWei = BigInteger.ONE) }
        assertEquals(1, w.notes.notes().size)       // the refused mints created nothing (and no key)
        assertEquals(1, w.keys.aliases().size)
    }

    @Test fun shieldTargetLinkParses() {
        val target = buildJsonObject { put("v", 1); put("t", "shield-target"); put("chainId", 11155111); put("escrow", "0x" + Escrows.SEPOLIA_V31); put("request", kohaku["request"]!!) }
        val p = Handoff.parseLink(Handoff.httpsLink("https://x.vercel.app", "shield-target", Handoff.encode(target)))
        assertEquals("shield-target", p.kind)
        assertEquals("2b5ff8a94e78d1c735aa2ff9bee40b7497fa4b90d8faaedbc1beb0218255cd7c", ShieldRequest.parse(p.payload).hash())
        assertNull(runCatching { Handoff.parseLink(Handoff.prawlLink("redeem", Handoff.encode(target))) }.getOrNull())   // kind/type mismatch
        assertNotNull(p.payload)
    }
}
