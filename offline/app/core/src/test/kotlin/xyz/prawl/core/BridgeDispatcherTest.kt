package xyz.prawl.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import xyz.prawl.core.bridge.BridgeConfirm
import xyz.prawl.core.bridge.BridgeDispatcher
import xyz.prawl.core.bridge.BridgeException
import xyz.prawl.core.bridge.BridgeHost
import xyz.prawl.core.certs.MemoryCertStore
import xyz.prawl.core.deposit.DepositCheck
import xyz.prawl.core.deposit.DepositVerifier
import xyz.prawl.core.keys.SpendApprover
import xyz.prawl.core.model.Bundle
import xyz.prawl.core.model.CoinHeader
import xyz.prawl.core.model.Note
import xyz.prawl.core.protocol.Escrows
import xyz.prawl.core.protocol.OfflineWallet
import xyz.prawl.core.protocol.RecipientPolicy
import xyz.prawl.core.store.MemoryNoteStore
import xyz.prawl.core.util.Eth
import xyz.prawl.core.util.Js
import xyz.prawl.core.util.obj
import xyz.prawl.core.util.str
import java.io.File

/** The bridge the wallet website calls: validation, no signing without the native confirmation, no secrets in answers. */
class BridgeDispatcherTest {
    private val permissive = object : DepositVerifier {
        override val name = "test: every coin is backed"
        override fun check(header: CoinHeader, genesisKey: java.security.PublicKey?, k0Hash: String?, bundle: Bundle, nowS: Long) = DepositCheck(true, name, "backed")
    }
    private val now = Vectors.NOW_S

    private inner class Host(var answer: Boolean = true) : BridgeHost {
        val store = MemoryNoteStore()
        val w = OfflineWallet(FakeKeyVault(), store, MemoryCertStore(), Vectors.anchors, FakeChecker(), { RecipientPolicy() }, { permissive }, nowMillis = { now * 1000 })
        val confirms = ArrayList<BridgeConfirm>()
        var changes = 0
        override fun wallet() = w
        override fun notes(): List<Note> = store.notes()
        override val chainId = Escrows.SEPOLIA
        override val publicEscrow40 = Escrows.SEPOLIA_V3
        override val privateEscrow40 = Escrows.SEPOLIA_V31
        override fun approver(): SpendApprover? = null
        override fun confirm(c: BridgeConfirm): Boolean { confirms.add(c); return answer }
        override fun changed() { changes++ }
        override fun nowS() = now
    }

    private val DEP = "0x03a62B04aBe69f382bd7582f492be735B1dDb47B"
    private fun call(d: BridgeDispatcher, m: String, args: String = "{}") = Js.parse(d.dispatch(m, args))
    private fun fails(code: String, block: () -> Unit) {
        try { block(); throw AssertionError("expected BridgeException($code)") } catch (e: BridgeException) { assertEquals(e.message, code, e.code) }
    }
    private fun mint(d: BridgeDispatcher, wei: String = "500000000000000000", mode: String = "public") =
        call(d, "mint", """{"depositor":"$DEP","valueWei":"$wei","mode":"$mode"}""")
    private fun coinOf(p: JsonObject) = (p["coinId"] ?: p.obj("params")["coinId"]).toString().trim('"')

    // ------------------------------------------------------------ argument validation

    @Test fun unknownMethodAndBadArgumentsAreRefused() {
        val d = BridgeDispatcher(Host())
        fails("unknown_method") { d.dispatch("signEverything", "{}") }
        fails("unknown_method") { d.dispatch("__proto__", "{}") }
        fails("invalid_args") { d.dispatch("coins", "[1,2]") }
        fails("invalid_args") { d.dispatch("coins", "not json") }
        fails("invalid_args") { d.dispatch("mint", "{" + "\"a\":\"" + "x".repeat(70_000) + "\"}") }
        fails("invalid_args") { d.dispatch("mint", "[" .repeat(100) + "]".repeat(100)) }
    }

    @Test fun mintValidatesEveryField() {
        val d = BridgeDispatcher(Host())
        for (bad in listOf("0", "-1", "01", "1.5", "1e18", "0x10", " 5", "", "9".repeat(80), "1" + "0".repeat(25)))
            fails("invalid_args") { mint(d, wei = bad) }
        fails("invalid_args") { call(d, "mint", """{"depositor":"0x1234","valueWei":"1"}""") }
        fails("invalid_args") { call(d, "mint", """{"depositor":"0x0000000000000000000000000000000000000000","valueWei":"1"}""") }
        fails("invalid_args") { call(d, "mint", """{"depositor":"$DEP","valueWei":"1","mode":"both"}""") }
        fails("invalid_args") { call(d, "mint", """{"valueWei":"1"}""") }
    }

    @Test fun aPageCannotMintWithoutLimit() {
        val d = BridgeDispatcher(Host(), maxPendingMints = 3)
        repeat(3) { mint(d) }
        fails("too_many_pending") { mint(d) }
    }

    // ------------------------------------------------------------ mint / coins / mark*

    @Test fun mintGivesTheAgreedLoadPayloadsAndNeverAsksTheUser() {
        val h = Host(); val d = BridgeDispatcher(h)
        val pub = mint(d)
        assertEquals("load", pub.str("t")); assertEquals(Escrows.SEPOLIA_V3, pub.str("escrow").removePrefix("0x"))
        val priv = mint(d, mode = "private")
        assertEquals("load-private", priv.str("t")); assertTrue(priv.str("depositAddress").startsWith("0x"))
        assertEquals("a private load goes to the escrow that supports it", "0x" + Escrows.SEPOLIA_V31, priv.str("escrow"))
        assertTrue("minting needs no approval, it spends nothing", h.confirms.isEmpty())
    }

    @Test fun coinsListsStateAndLeaksNoSecrets() {
        val h = Host(); val d = BridgeDispatcher(h)
        val m = mint(d)
        val text = d.dispatch("coins", "{}")
        assertTrue("coins() is a bare array, as the website's BridgeCoin[] expects: $text", text.startsWith("[") && text.endsWith("]"))
        assertTrue(text, text.contains("awaiting_deposit"))
        for (secret in listOf("alias", "certs", "\"k0\"", "k0x", "sig", "noteKey", "privateKey", "path"))
            assertFalse("coins() must not expose '$secret': $text", text.contains(secret))
        call(d, "markDeposited", """{"coinId":"${coinOf(m)}","txHash":"0x${"ab".repeat(32)}"}""")
        val after = d.dispatch("coins", "{}")
        assertTrue(after, after.contains("\"spendable\""))
        assertTrue("the note id is offered so the page can name a note", after.contains("noteId"))
    }

    @Test fun markDepositedAndRefreshedValidate() {
        val d = BridgeDispatcher(Host())
        val m = mint(d)
        fails("invalid_args") { call(d, "markDeposited", """{"coinId":"${coinOf(m)}","txHash":"0xNOPE"}""") }
        fails("no_such_coin") { call(d, "markDeposited", """{"coinId":"0x${"11".repeat(32)}"}""") }
        fails("invalid_args") { call(d, "markDeposited", """{"coinId":"short"}""") }
    }

    // ------------------------------------------------------------ nothing signs without the native confirmation

    private fun funded(h: Host, d: BridgeDispatcher, mode: String = "public"): String {
        val m = mint(d, mode = mode); val id = coinOf(m)
        call(d, "markDeposited", """{"coinId":"$id"}""")
        return id
    }

    @Test fun cashOutIsDeclinedWithoutSigningWhenTheUserSaysNo() {
        val h = Host(answer = false); val d = BridgeDispatcher(h)
        val id = funded(h, d)
        val e = try { call(d, "cashOut", """{"coinId":"$id","to":{"address":"$DEP"}}"""); null } catch (e: BridgeException) { e }
        assertNotNull(e)
        assertEquals("declined", e!!.code); assertTrue(e.message!!.contains("declined")); assertTrue(e.message!!.contains("Nothing was signed".lowercase()) || e.message!!.contains("nothing was signed"))
        assertTrue("the note is untouched: still spendable, not spent", h.notes().single().let { !it.spent && it.redeemedTo == null })
        assertEquals(1, h.confirms.size)
    }

    @Test fun cashOutShowsTheFullAddressNativelyAndThenSigns() {
        val h = Host(); val d = BridgeDispatcher(h)
        val id = funded(h, d)
        val r = call(d, "cashOut", """{"coinId":"$id","to":{"address":"$DEP"}}""")
        assertEquals("redeem", r.str("t"))
        assertEquals("the WHOLE checksummed address is what the user sees", Eth.checksum("03a62b04abe69f382bd7582f492be735b1ddb47b"), h.confirms.single().mono)
        assertTrue(h.notes().single().spent)
        for (secret in listOf("alias", "privateKey")) assertFalse(r.toString().contains(secret))
    }

    @Test fun cashOutRefusesBadAddressesAndUnknownCoinsBeforeAskingAnyone() {
        val h = Host(); val d = BridgeDispatcher(h)
        val id = funded(h, d)
        fails("invalid_args") { call(d, "cashOut", """{"coinId":"$id","to":{"address":"0x12"}}""") }
        fails("invalid_args") { call(d, "cashOut", """{"coinId":"$id","to":{"address":"0x03a62b04abe69f382bd7582f492be735b1ddb47B"}}""") }  // bad EIP-55
        fails("no_such_coin") { call(d, "cashOut", """{"coinId":"0x${"22".repeat(32)}","to":{"address":"$DEP"}}""") }
        fails("invalid_args") { call(d, "cashOut", """{"coinId":"$id","to":{}}""") }
        assertTrue("nothing reached the user", h.confirms.isEmpty())
    }

    @Test fun refreshNeedsTheUsersApprovalAndShowsTheReclaimAddress() {
        val h = Host(); val d = BridgeDispatcher(h)
        val id = funded(h, d, "private")
        h.answer = false
        fails("declined") { call(d, "refresh", """{"coinId":"$id","depositor":"$DEP"}""") }
        assertFalse(h.notes().single().spent)
        h.answer = true
        val r = call(d, "refresh", """{"coinId":"$id","depositor":"$DEP"}""")
        assertEquals("refresh", r.str("t")); assertNotNull(r["refresh"])
        assertEquals(Eth.checksum("03a62b04abe69f382bd7582f492be735b1ddb47b"), h.confirms.last().mono)
    }

    @Test fun refreshOfAPlainV3CoinIsRefused() {
        val h = Host(); val d = BridgeDispatcher(h)
        val id = funded(h, d, "public")   // plain escrow v3: cannot refresh
        fails("refused") { call(d, "refresh", """{"coinId":"$id","depositor":"$DEP"}""") }
    }

    // ------------------------------------------------------------ shield flow, the order the website follows

    private val kohaku = Js.parse(File(Vectors.raw, "v3/escrow_v31/fixtures/railgun_shield_1e15.json").readText())
    private fun target(nonce: String, npk: String? = null): JsonObject {
        var req = kohaku.obj("request")
        if (npk != null) req = JsonObject(LinkedHashMap(req).also { it["npk"] = kotlinx.serialization.json.JsonPrimitive(npk) })
        return buildJsonObject { put("v", 1); put("t", "shield-target"); put("chainId", 11155111); put("escrow", "0x" + Escrows.SEPOLIA_V31); put("nonce", nonce); put("request", req) }
    }

    @Test fun privateCashOutFollowsAskAcceptCashOutAndBindsTheRequest() {
        val h = Host(); val d = BridgeDispatcher(h)
        val id = funded(h, d, "private")   // 0.5 ETH note; the real kohaku request is for 0.001, so mint that value instead
        // the fixture request is for exactly 0.001 ETH: use a coin of that value
        val h2 = Host(); val d2 = BridgeDispatcher(h2)
        val m = mint(d2, wei = "1000000000000000", mode = "private"); val id2 = coinOf(m)
        call(d2, "markDeposited", """{"coinId":"$id2"}""")
        // cashOut to a shield before any ask/accept is refused
        fails("invalid_args") { call(d2, "cashOut", """{"coinId":"$id2","to":{"shield":${kohaku.obj("request")}}}""") }
        val nonce = call(d2, "shieldAsk", """{"valueWei":"1000000000000000"}""").str("nonce")
        assertTrue(Regex("^[0-9a-f]{32}$").matches(nonce))
        // a target answering a different nonce is refused at acceptance
        fails("invalid_target") { call(d2, "acceptShieldTarget", target("00".repeat(16)).toString()) }
        val ok = call(d2, "acceptShieldTarget", target(nonce).toString())
        assertEquals("true", ok["ok"].toString())
        // presenting a different request than the accepted one is refused (npk swapped)
        val swapped = kohaku.obj("request").toString().replace(kohaku.obj("request").str("npk"), "0x" + "11".repeat(32))
        fails("invalid_args") { call(d2, "cashOut", """{"coinId":"$id2","to":{"shield":$swapped}}""") }
        h2.answer = false
        fails("declined") { call(d2, "cashOut", """{"coinId":"$id2","to":{"shield":${kohaku.obj("request")}}}""") }
        assertFalse(h2.notes().single().spent)
        h2.answer = true
        val r = call(d2, "cashOut", """{"coinId":"$id2","to":{"shield":${kohaku.obj("request")}}}""")
        assertEquals("redeem-shield", r.str("t"))
        assertEquals("the user saw the WHOLE npk", "0x" + kohaku.obj("request").str("npk").removePrefix("0x").padStart(64, '0'), h2.confirms.last().mono)
        assertTrue(h2.notes().single().spent)
        assertNotNull(h.notes())
    }
}
