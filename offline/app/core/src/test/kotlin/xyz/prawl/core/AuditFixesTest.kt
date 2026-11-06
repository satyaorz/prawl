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
import xyz.prawl.core.Synth.int
import xyz.prawl.core.Synth.tagged
import xyz.prawl.core.attest.AppIdentity
import xyz.prawl.core.attest.AttestationPolicy
import xyz.prawl.core.attest.AttestationResult
import xyz.prawl.core.attest.AttestationVerifier
import xyz.prawl.core.attest.TrustAnchors
import xyz.prawl.core.certs.CertResolver
import xyz.prawl.core.certs.CertStore
import xyz.prawl.core.certs.MemoryCertStore
import xyz.prawl.core.deposit.CommitmentSnapshotDepositVerifier
import xyz.prawl.core.deposit.DepositCheck
import xyz.prawl.core.deposit.DepositSources
import xyz.prawl.core.deposit.DepositVerifier
import xyz.prawl.core.deposit.SnapshotDepositVerifier
import xyz.prawl.core.keys.ApprovalPrompt
import xyz.prawl.core.keys.KeySpec
import xyz.prawl.core.keys.SpendApprover
import xyz.prawl.core.model.Bundle
import xyz.prawl.core.model.CoinHeader
import xyz.prawl.core.model.Note
import xyz.prawl.core.model.ReceiveRequest
import xyz.prawl.core.protocol.Canonical
import xyz.prawl.core.protocol.Escrows
import xyz.prawl.core.protocol.OfflineWallet
import xyz.prawl.core.protocol.OfflineWallet.PayOutcome
import xyz.prawl.core.protocol.PaymentVerifier
import xyz.prawl.core.protocol.RecipientPolicy
import xyz.prawl.core.store.FileNoteStore
import xyz.prawl.core.store.MemoryNoteStore
import xyz.prawl.core.store.NoteStore
import xyz.prawl.core.transport.FramedLink
import xyz.prawl.core.transport.PaymentSession
import xyz.prawl.core.transport.SecureLink
import xyz.prawl.core.util.Bytes
import xyz.prawl.core.util.Eth
import xyz.prawl.core.util.Js
import xyz.prawl.core.util.arr
import xyz.prawl.core.util.obj
import xyz.prawl.core.util.objects
import xyz.prawl.core.util.str
import xyz.prawl.core.util.strings
import xyz.prawl.core.util.with
import java.io.File
import java.io.IOException
import java.math.BigInteger
import java.net.SocketTimeoutException
import java.nio.file.Files
import java.security.PublicKey
import java.util.concurrent.LinkedBlockingQueue
import kotlin.concurrent.thread

/**
 * The app audit (raw/v3/audit_app/FINDINGS.md) F-03 .. F-13, each flipped from "exploit works" to "refused", on the real code and
 * the real phone chains/bundles where possible. F-01/F-02 are in [CanonicalTest].
 */
class AuditFixesTest {
    private var now = Vectors.NOW_S * 1000
    private val permissive = object : DepositVerifier {
        override val name = "test: every coin is backed"
        override fun check(header: CoinHeader, genesisKey: PublicKey?, k0Hash: String?, bundle: Bundle, nowS: Long) = DepositCheck(true, name, "backed")
    }

    /** A NoteStore that fails on demand (a crash, a full disk) and records the order of operations. */
    class FlakyStore(val inner: NoteStore = MemoryNoteStore()) : NoteStore by inner {
        var failPuts = 0
        val failRecordKinds = HashMap<String, Int>()
        val ops = ArrayList<String>()
        override fun put(note: Note) { ops.add("put:${note.alias}"); if (failPuts > 0) { failPuts--; throw IOException("simulated disk failure") }; inner.put(note) }
        override fun putRecord(kind: String, name: String, json: JsonObject) {
            ops.add("putRecord:$kind")
            val n = failRecordKinds[kind] ?: 0
            if (n > 0) { failRecordKinds[kind] = n - 1; throw IOException("simulated disk failure") }
            inner.putRecord(kind, name, json)
        }
        override fun putAccepted(name: String, json: JsonObject) { ops.add("putAccepted"); inner.putAccepted(name, json) }
        override fun deletePending(name: String) { ops.add("deletePending"); inner.deletePending(name) }
    }

    inner class P(val store: NoteStore = MemoryNoteStore(), dv: DepositVerifier = permissive, ownerApproval: Boolean = false, val certStore: MemoryCertStore = MemoryCertStore()) {
        val keys = FakeKeyVault()
        val w = OfflineWallet(keys, store, certStore, Vectors.anchors, FakeChecker(), { RecipientPolicy() }, { dv }, { ownerApproval }, { now })
    }

    private fun fund(p: P, label: String, eth: String, escrow: String = Escrows.SEPOLIA_V31): Note {
        val m = p.w.mint(label, Eth.wei(eth), 7 * 86400, Escrows.SEPOLIA, escrow, "03a62b04abe69f382bd7582f492be735b1ddb47b", pendingDeposit = true)
        p.w.markDeposited(m.note.alias)
        return p.store.note(m.note.alias)!!
    }

    private fun paid(o: PayOutcome): PayOutcome.Paid { assertTrue((o as? PayOutcome.Refused)?.reason ?: "", o is PayOutcome.Paid); return o as PayOutcome.Paid }

    // ================================================================== F-03: destination binding

    private val kohaku = Vectors.kohaku
    private fun target(nonce: String?, value: String? = null, npk: String? = null): JsonObject {
        var req = kohaku.obj("request")
        if (value != null) req = req.with("value", value)
        if (npk != null) req = req.with("npk", npk)
        return buildJsonObject {
            put("v", 1); put("t", "shield-target"); put("chainId", 11155111); put("escrow", "0x" + Escrows.SEPOLIA_V31); put("request", req)
            if (nonce != null) put("nonce", nonce)
        }
    }

    @Test fun f03_shieldAskHasTheAgreedShapeAndAFreshNonceEveryTime() {
        val a = P(); val n = fund(a, "k", "0.001")
        val ask1 = a.w.shieldAsk(n.alias); val ask2 = a.w.shieldAsk(n.alias)
        assertEquals(1, (ask1["v"] as JsonPrimitive).content.toInt()); assertEquals("shield-ask", ask1.str("t"))
        assertEquals(11155111L, (ask1["chainId"] as JsonPrimitive).content.toLong())          // a JSON number, as in HANDOFF §11
        assertEquals("0x" + Escrows.SEPOLIA_V31, ask1.str("escrow")); assertEquals(n.value.toString(), ask1.str("value"))
        assertTrue("32 lowercase hex chars (16 random bytes)", Regex("^[0-9a-f]{32}$").matches(ask1.str("nonce")))
        assertTrue("new for each ask", ask1.str("nonce") != ask2.str("nonce"))
        // v3 coins have no private cash-out: no ask
        val a3 = P(); val c3 = fund(a3, "v", "0.001", Escrows.SEPOLIA_V3)
        assertThrows { a3.w.shieldAsk(c3.alias) }
    }

    @Test fun f03_aTargetMustEchoTheLastAskAndEachNonceWorksOnce() {
        val a = P(); val n = fund(a, "k", "0.001")
        val old = a.w.shieldAsk(n.alias).str("nonce")
        val last = a.w.shieldAsk(n.alias).str("nonce")                      // a new ask invalidates the previous one
        a.w.checkShield(n, target(old)).let { assertFalse("an older ask's nonce is refused", it.ok); assertTrue(it.failures.joinToString(), it.failures.any { f -> f.contains("nonce") }) }
        assertFalse("a guessed nonce is refused", a.w.checkShield(n, target("00".repeat(16))).ok)
        assertFalse("another phone's nonce format is refused", a.w.checkShield(n, target("0x$last")).ok)
        val good = a.w.checkShield(n, target(last))
        assertTrue(good.failures.joinToString(), good.ok); assertTrue(good.bound); assertNull("a bound target has no warning", good.warning)
        // the nonce of note A cannot authorize a target for note B
        val b = fund(a, "j", "0.001")
        assertFalse(a.w.checkShield(b, target(last)).ok)
        // used once: signing consumes it, so the same target cannot be replayed on another note
        assertTrue(a.w.redeemShield(n.alias, target(last), null) is OfflineWallet.RedeemOutcome.Signed)
        val replay = a.w.checkShield(b, target(last))
        assertFalse("a used nonce is refused", replay.ok)
        assertTrue(replay.failures.joinToString(), replay.failures.any { it.contains("no open shield-ask") })
    }

    @Test fun f03_anAskExpires() {
        val a = P(); val n = fund(a, "k", "0.001")
        val nonce = a.w.shieldAsk(n.alias).str("nonce")
        assertTrue(a.w.checkShield(n, target(nonce)).ok)
        now += 31 * 60_000L
        assertFalse(a.w.checkShield(n, target(nonce)).ok)
    }

    @Test fun f03_aTargetWithoutANonceIsAcceptedButFlaggedNotBound() {
        val a = P(); val n = fund(a, "k", "0.001")
        val c = a.w.checkShield(n, target(null))
        assertTrue(c.failures.joinToString(), c.ok)
        assertFalse(c.bound); assertNotNull(c.warning); assertTrue(c.warning!!.contains("NOT BOUND"))
        assertTrue(a.w.redeemShield(n.alias, target(null), null) is OfflineWallet.RedeemOutcome.Signed)
    }

    /** The prompt the owner sees carries the WHOLE destination: a truncated address is what a look-alike address exploits. */
    @Test fun f03_theApprovalPromptShowsTheFullDestination() {
        val prompts = ArrayList<ApprovalPrompt>()
        val approver = SpendApprover { sig, prompt -> prompts.add(prompt); sig }
        val dest = "5aaeb6053f3e94c9b9a09f33669435e7ef1beaed"
        // plain cash-out
        run {
            val a = P(ownerApproval = true); val n = fund(a, "c", "0.1")
            assertTrue(a.w.redeem(n.alias, dest, approver) is OfflineWallet.RedeemOutcome.Signed)
            val d = prompts.last().description!!
            assertTrue("full checksummed address in: $d", d.contains(Eth.checksum(dest)))
            assertFalse("not abbreviated", prompts.last().subtitle.contains("…"))
        }
        // private cash-out: the whole npk
        run {
            val a = P(ownerApproval = true); val n = fund(a, "k", "0.001")
            assertTrue(a.w.redeemShield(n.alias, target(null), approver) is OfflineWallet.RedeemOutcome.Signed)
            val npk = "0x" + BigInteger(kohaku.obj("request").str("npk").removePrefix("0x"), 16).toString(16).padStart(64, '0')
            assertTrue("full 66-char npk in: ${prompts.last().description}", prompts.last().description!!.contains(npk))
        }
        // refresh: the whole reclaim address
        run {
            val a = P(ownerApproval = true); val n = fund(a, "r", "0.1")
            assertTrue(a.w.refresh(n.alias, 86400L, dest, approver) is OfflineWallet.RefreshOutcome.Signed)
            assertTrue(prompts.last().description!!.contains(Eth.checksum(dest)))
        }
        // pay: the amount and the payee's key
        run {
            val a = P(ownerApproval = true); val b = P(); fund(a, "p", "0.2")
            val req = b.w.request("x")
            assertTrue(a.w.pay(Eth.wei("0.1"), req, approver) is PayOutcome.Paid)
            assertTrue(prompts.last().description!!.contains(b.w.pendingKeyHash("x")!!.take(16)))
        }
    }

    // ================================================================== F-04: revocation, hex and decimal

    @Test fun f04_aDecimalListedSerialRevokesARealChain() {
        val res = CertResolver(Vectors.certStore(Vectors.split), Vectors.anchors)
        val chain = res.chain(ReceiveRequest(Vectors.json(Vectors.split, "req_bob1.json")).chain)
        val serial = TrustAnchors.parseCert(chain[1]).serialNumber
        fun ok(entry: String) = AttestationVerifier(TrustAnchors(Vectors.anchors.rootsDer, setOf(entry), Vectors.anchors.revocationFetchedAt), Vectors.harnessPolicy) { Vectors.NOW_S * 1000 }.verify(chain).ok
        assertFalse("hex entry revokes", ok(serial.toString(16)))
        assertFalse("the SAME serial in decimal (Google's format for 64-bit serials) now revokes too", ok(serial.toString(10)))
        assertTrue("an unrelated entry does not", ok("deadbeefdeadbeef"))
    }

    @Test fun f04_everyDecimalEntryOfTheBundledListIsReachable() {
        val dec = Vectors.anchors.revokedSerials.filter { e -> e.all { it in '0'..'9' } && e.length in 17..20 }
        assertTrue("the bundled list has ${dec.size} decimal entries", dec.size > 900)
        assertTrue(dec.all { Vectors.anchors.isRevoked(BigInteger(it)) })
        val hexs = Vectors.anchors.revokedSerials.filter { it.length in 30..32 && it.any { c -> c in 'a'..'f' } }
        assertTrue(hexs.isNotEmpty() && hexs.all { Vectors.anchors.isRevoked(BigInteger(it, 16)) })
    }

    // ================================================================== idempotent accept must cover the WHOLE bundle (found by w3_split.sh S6 on the phones)

    /**
     * A bundle whose outputs were altered keeps the same final signature. The idempotent shortcut keyed on the signature alone answered
     * "ACCEPTED (again)" for it, confirming a payment whose contents were never verified. The record must cover the whole accepted bundle.
     */
    @Test fun idem_aTamperedCopyWithTheSameSignatureIsVerifiedAndRejectedNotConfirmed() {
        val alice = P(); val bob = P(); fund(alice, "c", "1.0")
        val pay = paid(alice.w.pay(Eth.wei("0.2"), bob.w.request("b1"), null))          // outputs [0.2 -> Bob, 0.8 -> Alice's change]
        assertTrue(bob.w.accept(pay.bundle, "b1").accepted)
        val spend = pay.bundle.arr("path").objects()[0]
        fun tamper(f: (JsonObject) -> JsonObject): JsonObject = pay.bundle.with("path", JsonArray(listOf(f(spend))))
        fun outs(a: String, b: String) = JsonArray(spend.arr("outputs").objects().mapIndexed { i, o -> o.with("value", if (i == 0) a else b) })
        val cases = mapOf(
            "S6: Bob gives himself 0.9 instead of 0.2 (same sig)" to tamper { it.with("outputs", outs("900000000000000000", "100000000000000000")) },
            "one output value changed, sum broken" to tamper { it.with("outputs", outs("200000000000000001", "800000000000000000")) },
            "sibling output key swapped" to tamper { it.with("outputs", JsonArray(it.arr("outputs").objects().mapIndexed { i, o -> if (i == 1) o.with("key", "ee".repeat(32)) else o })) },
            "followed index changed" to tamper { it.with("index", 1) },
            "next-key chain replaced by another key's" to tamper { it.with("next", pay.bundle.obj("header").arr("k0")) },
            "header expiry changed" to pay.bundle.with("header", pay.bundle.obj("header").with("expiry", (pay.bundle.obj("header")["expiry"] as JsonPrimitive).content.toLong() + 60)),
            "header value changed" to pay.bundle.with("header", pay.bundle.obj("header").with("value", "2000000000000000000")),
            "header coinId changed" to pay.bundle.with("header", pay.bundle.obj("header").with("coinId", "ab".repeat(32))),
        )
        for ((what, b) in cases) {
            val rep = bob.w.accept(b, "b1")
            assertFalse("$what must be REJECTED, not confirmed", rep.accepted)
            assertTrue("$what: went through full verification (${rep.lines.map { it.title }})", rep.lines.none { it.title == "Already accepted" })
        }
        assertEquals("the real payment is still credited exactly once", Eth.wei("0.2"), bob.w.spendableTotal())
        assertEquals(1, bob.w.notes.notes().size)
        // the S6 case specifically fails on the signature, as the previous build's expectation says
        val s6 = bob.w.accept(cases.values.first(), "b1")
        assertTrue(s6.fails.toString(), s6.fails.any { it.contains("signature invalid") })
    }

    @Test fun idem_aByteIdenticalResendIsStillConfirmedAgainAndCreditedOnce() {
        val alice = P(); val bob = P(); fund(alice, "c", "1.0")
        val pay = paid(alice.w.pay(Eth.wei("0.2"), bob.w.request("b1"), null))
        assertTrue(bob.w.accept(pay.bundle, "b1").accepted)
        val again = bob.w.accept(pay.bundle, "b1")
        assertTrue(again.accepted); assertTrue(again.lines.any { it.title == "Already accepted" })
        // the payer's real resend (same stored bytes, certificates re-attached) is also recognised
        val resend = paid(alice.w.pay(Eth.wei("0.2"), bob.w.request("b1"), null)); assertTrue(resend.resent)
        val again2 = bob.w.accept(resend.bundle, "b1")
        assertTrue(again2.accepted); assertTrue(again2.lines.any { it.title == "Already accepted" })
        assertEquals(Eth.wei("0.2"), bob.w.spendableTotal()); assertEquals(1, bob.w.notes.notes().size)
        // a record written by an older build (signature hash only) never short-circuits: it is verified in full
        val rec = bob.store.accepted("b1")!!
        bob.store.putAccepted("b1", JsonObject(rec.filterKeys { it != "bundleHash" }))
        assertFalse(bob.w.accept(pay.bundle, "b1").lines.any { it.title == "Already accepted" })
    }

    /** The REAL phone vectors of w3_split.sh S6: Bob edits Alice's spend (same signature) after the genuine payment was accepted. */
    @Test fun idem_realPhoneVectorS6IsNotConfirmed() {
        val bob = P()
        val orig = Vectors.json(Vectors.split, "pay3_s_bob1.json"); val tamper = Vectors.json(Vectors.split, "pay3_s_tamper.json")
        val ob = Bundle(orig)
        assertEquals("premise: the edited copy keeps the signature bytes", ob.path.last().sig, Bundle(tamper).path.last().sig)
        assertTrue("premise: the outputs differ", ob.path.last().outputs != Bundle(tamper).path.last().outputs)
        bob.store.putAccepted("bob1", buildJsonObject {
            put("chain", JsonArray(emptyList())); put("sigHash", Bytes.sha256Hex(Bytes.unb64(ob.path.last().sig))); put("bundleHash", Canonical.bundleDigest(ob)!!)
            put("value", "200000000000000000"); put("noteId", "00".repeat(32)); put("at", 1); put("until", Vectors.NOW_S + 1000)
        })
        assertTrue("the genuine bundle is recognised", bob.w.accept(orig, "bob1").lines.any { it.title == "Already accepted" })
        val rep = bob.w.accept(tamper, "bob1")
        assertFalse(rep.accepted); assertTrue(rep.lines.none { it.title == "Already accepted" })
    }

    // ================================================================== F-05: accept order and key aliases

    @Test fun f05_aFailedAcceptKeepsThePendingKeyAndTheRetryWorks() {
        val flaky = FlakyStore(); val alice = P(); val bob = P(flaky)
        fund(alice, "c", "1.0")
        val req1 = bob.w.request("b1"); val oldKey = bob.w.pendingKeyHash("b1")!!
        val pay = paid(alice.w.pay(Eth.wei("0.4"), req1, null))
        flaky.failPuts = 1                                              // the received note cannot be written
        assertTrue(runCatching { bob.w.accept(pay.bundle, "b1") }.isFailure)
        assertNotNull("the pending record is NOT deleted before the note is saved", bob.store.pendingChain("b1"))
        val req2 = bob.w.request("b1")
        assertEquals("the retry gets the SAME key", req1.chain, req2.chain); assertEquals(oldKey, bob.w.pendingKeyHash("b1"))
        assertTrue(bob.w.accept(pay.bundle, "b1").accepted)
        assertEquals(Eth.wei("0.4"), bob.w.spendableTotal())
    }

    @Test fun f05_acceptWritesTheNoteThenTheRecordAndOnlyThenForgetsThePendingKey() {
        val flaky = FlakyStore(); val alice = P(); val bob = P(flaky)
        fund(alice, "c", "1.0")
        val pay = paid(alice.w.pay(Eth.wei("0.4"), bob.w.request("b1"), null))
        flaky.ops.clear()
        assertTrue(bob.w.accept(pay.bundle, "b1").accepted)
        val i = flaky.ops.indexOf("put:recv_b1"); val j = flaky.ops.indexOf("putAccepted"); val k = flaky.ops.indexOf("deletePending")
        assertTrue("order ${flaky.ops}", i in 0 until j && j < k)
    }

    @Test fun f05_requestNeverReplacesAKeyThatHasNoRecord() {
        val bob = P()
        bob.w.request("b1"); val key = bob.w.pendingKeyHash("b1")!!
        bob.store.deletePending("b1")                                   // the record is gone, the key is not
        assertThrows { bob.w.request("b1") }
        assertEquals("the key was not replaced", key, bob.w.pendingKeyHash("b1"))
    }

    // ================================================================== F-06: sign-then-persist

    @Test fun f06_aFailedWriteAfterSigningNeverStrandsTheChange() {
        val flaky = FlakyStore(); val alice = P(flaky); val bob = P()
        fund(alice, "coin", "1.0")
        val req = bob.w.request("b1")
        flaky.failPuts = 1                                              // was: spent note saved, change note write fails -> change key orphaned
        val r = alice.w.pay(Eth.wei("0.4"), req, null)
        assertTrue("no throw, the bundle is returned", r is PayOutcome.Paid)
        assertEquals("the immediate retry of the signed record healed it", Eth.wei("0.6"), alice.w.spendableTotal())
        assertTrue(flaky.inner.recordNames("signed").isEmpty() && flaky.inner.recordNames("intent").isEmpty())
        assertEquals("every key in the vault belongs to a note", alice.w.spendable().map { it.alias }.toSet(), alice.keys.aliases().toSet())
    }

    @Test fun f06_aCrashBeforeAnyNoteWriteIsFinishedByReconcile() {
        val flaky = FlakyStore(); val alice = P(flaky); val bob = P()
        val coin = fund(alice, "c", "1.0")
        val req = bob.w.request("b1")
        flaky.failPuts = 2                                              // both attempts to apply fail: the process "dies" with only the signed record
        val r = paid(alice.w.pay(Eth.wei("0.4"), req, null))
        assertTrue(r.persisted)
        assertEquals("until restart the store still shows the burnt note", Eth.wei("1.0"), alice.w.spendableTotal())
        assertEquals(1, flaky.inner.recordNames("signed").size)
        // startup
        val restarted = OfflineWallet(alice.keys, flaky.inner, alice.certStore, Vectors.anchors, FakeChecker(), { RecipientPolicy() }, { permissive }, { false }, { now })
        assertTrue(restarted.reconcile() >= 1)
        assertEquals(Eth.wei("0.6"), restarted.spendableTotal())
        assertTrue("the spent note keeps its signed bundle for the retry", flaky.inner.note(coin.alias)!!.signedBundle != null)
        assertTrue(flaky.inner.recordNames("signed").isEmpty() && flaky.inner.recordNames("intent").isEmpty())
        assertEquals(restarted.spendable().map { it.alias }.toSet(), alice.keys.aliases().toSet())
        assertTrue("and a retry to the same payee resends the identical bytes", restarted.pay(Eth.wei("0.4"), req, null).let { it is PayOutcome.Paid && it.resent })
    }

    @Test fun f06_ifEvenTheSignedRecordCannotBeWrittenTheNoteIsMarkedLostNotLeftAsPhantomBalance() {
        val flaky = FlakyStore(); val alice = P(flaky); val bob = P()
        val coin = fund(alice, "c", "1.0")
        val req = bob.w.request("b1")
        flaky.failRecordKinds["signed"] = 3; flaky.failPuts = 2
        val r = paid(alice.w.pay(Eth.wei("0.4"), req, null))
        assertFalse("the caller is told the signature is only in memory", r.persisted)
        assertTrue("the bundle is still returned so this payment can be delivered", Bundle(r.bundle).path.size == 1)
        alice.w.reconcile()
        assertTrue(flaky.inner.note(coin.alias)!!.json.containsKey("signatureLost"))
        assertEquals("no phantom 1.0 ETH", BigInteger.ZERO, alice.w.spendableTotal())
        assertTrue("the unused change key was deleted", alice.keys.aliases().isEmpty())
    }

    @Test fun f06_noIntentNoSignature() {
        val flaky = FlakyStore(); val alice = P(flaky); val bob = P()
        val coin = fund(alice, "c", "1.0")
        val req = bob.w.request("b1")
        flaky.failRecordKinds["intent"] = 1
        assertTrue(alice.w.pay(Eth.wei("0.4"), req, null) is PayOutcome.Refused)
        assertEquals("the one-time key was not used and no change key is left", setOf(coin.alias), alice.keys.aliases().toSet())
        assertFalse(alice.store.note(coin.alias)!!.spent)
    }

    @Test fun f06_reconcileRemovesTheKeysOfASigningThatNeverHappened() {
        val alice = P(); val coin = fund(alice, "c", "1.0")
        val orphan = "n_orphan_c1"; alice.keys.create(orphan, KeySpec())
        alice.store.putRecord("intent", coin.alias, buildJsonObject { put("op", "pay"); put("note", coin.alias); put("newKeys", JsonArray(listOf(JsonPrimitive(orphan)))); put("at", 1) })
        assertEquals(1, alice.w.reconcile())
        assertFalse(alice.keys.exists(orphan)); assertTrue("the note's own key is untouched", alice.keys.exists(coin.alias))
        assertTrue(alice.store.recordNames("intent").isEmpty())
    }

    /** The audit's refresh() bug: a failure after the old key signed deleted the NEW coin's key, so the refreshed value was gone. */
    @Test fun f06_aFailureAfterSigningNeverDeletesTheNewCoinKey() {
        val flaky = FlakyStore(); val a = P(flaky)
        val coin = fund(a, "coin", "0.5")
        flaky.failRecordKinds["signed"] = 1000; flaky.failRecordKinds["refresh"] = 1000
        val r = a.w.refresh(coin.alias, 14 * 86400L, "03a62b04abe69f382bd7582f492be735b1ddb47b", null)
        assertTrue("the signed refresh is handed on: $r", r is OfflineWallet.RefreshOutcome.Signed)
        assertFalse("old key is spent", a.keys.exists(coin.alias))
        assertEquals("the new coin's key SURVIVES", 1, a.keys.aliases().size)
        assertTrue("the old note is marked spent", flaky.inner.note(coin.alias)!!.spent)
    }

    // ================================================================== F-07: limits before work, deadlines

    private val dave1 get() = Vectors.json(Vectors.split, "pay3_s_dave1.json")

    private fun verify(b: JsonObject, policy: RecipientPolicy = RecipientPolicy()): Pair<Long, xyz.prawl.core.protocol.VerificationReport> {
        val req = ReceiveRequest(Vectors.json(Vectors.split, "req_dave1.json"))
        val res = CertResolver(Vectors.certStore(Vectors.split), Vectors.anchors)
        val t0 = System.nanoTime()
        val rep = PaymentVerifier(res, Vectors.verifier(), SnapshotDepositVerifier(Vectors.json(Vectors.split, "snapshot.json"), legacyUnbound = true), policy, Vectors.anchors.revocationFetchedAt)
            .verify(Bundle(b), req.name, res.leafKeyHash(req.chain, req.certs), Vectors.NOW_S)
        return (System.nanoTime() - t0) / 1_000_000 to rep
    }

    @Test fun f07_theHopLimitIsCheckedBeforeAnyCryptography() {
        val spends = dave1.arr("path").objects()
        val (msN, rep) = verify(dave1.with("path", JsonArray(List(2000) { spends[1] })))
        assertFalse(rep.accepted); assertTrue(rep.fails.joinToString(), rep.fails.any { it.startsWith("too many offline hops") })
        assertTrue("one line, no attestation work: ${rep.lines.map { it.title }}", rep.lines.size == 1)
        assertTrue("2000 spends rejected in $msN ms", msN < 500)
    }

    @Test fun f07_aHostileHugeNumberIsRefusedWithoutParsingIt() {
        for ((what, b) in listOf(
            "deposit value" to dave1.with("header", dave1.obj("header").with("value", "9".repeat(300_000))),
            "chainId" to dave1.with("header", dave1.obj("header").with("chainId", "9".repeat(300_000))),
            "expiry" to dave1.with("header", dave1.obj("header").with("expiry", JsonPrimitive("9".repeat(300_000)))),
            "output value" to dave1.with("path", JsonArray(dave1.arr("path").objects().let { l -> listOf(l[0].with("outputs", JsonArray(l[0].arr("outputs").objects().map { it.with("value", "9".repeat(300_000)) }))) + l.drop(1) })),
        )) {
            val (ms, rep) = verify(b)
            assertFalse("$what: refused", rep.accepted)
            assertTrue("$what: refused in $ms ms (a quadratic BigInteger parse of 300k digits takes seconds)", ms < 700)
        }
    }

    @Test fun f07_certificateChainsAreBounded() {
        val s0 = dave1.arr("path").objects()[0]
        val long = JsonArray((1..2000).flatMap { s0.arr("next").strings() }.map { JsonPrimitive(it) })
        val (ms, rep) = verify(dave1.with("path", JsonArray(listOf(s0.with("next", long)) + dave1.arr("path").objects().drop(1))))
        assertFalse(rep.accepted); assertTrue(rep.fails.joinToString(), rep.fails.any { it.contains("more than ${CertStore.MAX_CHAIN}") })
        assertTrue("$ms ms", ms < 500)
        assertTrue("honest bundles are untouched", verify(dave1).second.accepted)
    }

    @Test fun f07_deeplyNestedJsonIsAnExceptionNotAnError() {
        val doc = "[".repeat(200_000) + "]".repeat(200_000)
        val r = try { Js.parse("{\"a\":$doc}"); "parsed" } catch (e: IllegalArgumentException) { "rejected" } catch (e: Error) { "ERROR ${e.javaClass.simpleName}" }
        assertEquals("rejected", r)
        Js.parse("{\"a\":" + "[".repeat(Js.MAX_DEPTH - 1) + "]".repeat(Js.MAX_DEPTH - 1) + "}")                 // the limit is well above honest nesting
        Js.parse("{\"s\":\"" + "[".repeat(100_000) + "\"}")                                                    // brackets inside a string do not count
    }

    @Test fun f07_aHugeFrameIsRefusedAfterItsHeader() {
        val p = TestLinkPair()
        p.injectToA(byteArrayOf(0x00, 0x3d, 0x09, 0x00))                // 4,000,000
        val e = runCatching { p.a.recv() }.exceptionOrNull()
        assertTrue("bad frame: $e", e is IOException && e.message!!.contains("bad frame"))
        assertEquals(384 * 1024, FramedLink.MAX_FRAME)
        // a frame at the limit is still read
        val q = TestLinkPair(); q.b.sendBytes(ByteArray(FramedLink.MAX_FRAME) { 'x'.code.toByte() })
        assertEquals(FramedLink.MAX_FRAME, q.a.recvBytes().size)
    }

    @Test fun f07_aStalledFrameCannotHoldTheReader() {
        val p = TestLinkPair(); p.a.frameTimeoutMs = 300
        p.injectToA(byteArrayOf(0x00, 0x01, (0x86).toByte(), (0xa0).toByte())); p.injectToA(ByteArray(100))   // announces 100,000 bytes, delivers 100, stalls
        val t0 = System.nanoTime()
        val e = runCatching { p.a.recv() }.exceptionOrNull()
        val ms = (System.nanoTime() - t0) / 1_000_000
        assertTrue("timed out, got $e", e is SocketTimeoutException); assertTrue("after $ms ms", ms in 250..3000)
    }

    @Test fun f07_aSilentPeerIsDroppedByTheIdleDeadline() {
        val p = TestLinkPair()
        val t0 = System.nanoTime()
        assertTrue(runCatching { p.a.recv(300) }.exceptionOrNull() is SocketTimeoutException)
        assertTrue((System.nanoTime() - t0) / 1_000_000 in 250..3000)
    }

    private val secret = ByteArray(16) { 1 }; private val sid = ByteArray(16) { 2 }

    @Test fun f07_aSilentConnectionDoesNotHoldTheReceiveSession() {
        val bob = P(); val req = bob.w.request("z"); val p = TestLinkPair()
        val link = SecureLink(p.a, secret, sid, SecureLink.Role.PAYEE)
        val t0 = System.nanoTime()
        val res = PaymentSession.payee(link, req, true, { bob.w.accept(it, "z") }, helloTimeoutMs = 300)
        assertEquals(PaymentSession.PayeeStatus.UNAUTHENTICATED, res.status)
        assertTrue((System.nanoTime() - t0) / 1_000_000 < 3000)
        assertNotNull("the receive key is untouched", bob.w.pendingKeyHash("z"))
    }

    /** Silent stranger, garbage stranger, wrong-secret stranger, THEN the real payer: the listener serves the real payer. */
    @Test fun f07_theListenerKeepsListeningUntilAnAuthenticatedPeerArrives() {
        val alice = P(); val bob = P(); fund(alice, "c", "0.5")
        val req = bob.w.request("z")
        val silent = TestLinkPair(); val garbage = TestLinkPair(); val wrong = TestLinkPair(); val real = TestLinkPair()
        val queue = LinkedBlockingQueue<xyz.prawl.core.transport.Link>()
        queue.add(SecureLink(silent.a, secret, sid, SecureLink.Role.PAYEE))
        queue.add(SecureLink(garbage.a, secret, sid, SecureLink.Role.PAYEE))
        queue.add(SecureLink(wrong.a, secret, sid, SecureLink.Role.PAYEE))
        queue.add(SecureLink(real.a, secret, sid, SecureLink.Role.PAYEE))
        garbage.b.sendBytes(ByteArray(48) { 9 })                                         // 48 bytes that do not authenticate
        thread(isDaemon = true) { // a stranger who knows neither secret: sends HELLO under a wrong key
            val l = SecureLink(wrong.b, ByteArray(16) { 7 }, sid, SecureLink.Role.PAYER); runCatching { l.send(PaymentSession.HELLO) }
        }
        var payerResult: PaymentSession.PayerResult? = null
        thread(isDaemon = true) {
            payerResult = PaymentSession.payer(SecureLink(real.b, secret, sid, SecureLink.Role.PAYER), { r -> alice.w.pay(Eth.wei("0.2"), r, null) })
        }
        var dropped = 0
        val res = PaymentSession.payeeListen({ queue.poll() }, req, { bob.w.accept(it, "z") }, totalMs = 20_000,
            onUnauthenticated = { dropped++ }, helloTimeoutMs = 400)
        assertEquals(PaymentSession.PayeeStatus.ACCEPTED, res.status)
        assertEquals("silent, garbage and wrong-secret connections were dropped", 3, dropped)
        assertEquals(Eth.wei("0.2"), bob.w.spendableTotal())
        Thread.sleep(200)
        assertTrue(payerResult is PaymentSession.PayerResult.Answered)
    }

    // ================================================================== F-08: snapshot binding

    private fun entry(n: Note, k0: String, chainId: String? = n.header.chainId, escrow: String? = n.header.escrow, depositor: String? = n.header.depositor) = buildJsonObject {
        put("coinId", n.header.coinId); put("value", n.header.value.toString()); put("expiry", n.header.expiry); put("k0", k0)
        chainId?.let { put("chainId", it) }; escrow?.let { put("escrow", it) }; depositor?.let { put("depositor", it) }
    }
    private fun snap(vararg e: JsonObject) = buildJsonObject { put("deposits", JsonArray(e.toList())) }

    @Test fun f08_aSnapshotMustBindChainEscrowAndDepositor() {
        val m = P(); val coin = fund(m, "c", "1.0", Escrows.SEPOLIA_V3)               // really deposited in escrow v3
        val k0 = m.w.certs.leafKeyHash(coin.header.k0)
        fun accepts(snapshot: JsonObject, legacy: Boolean = false, tweak: (Note) -> Note = { it }): Boolean {
            val bob = P(dv = SnapshotDepositVerifier(snapshot, legacyUnbound = legacy)); val m2 = P()
            val c2 = tweak(coin)
            m.keys.entries.forEach { (k, v) -> m2.keys.entries[k] = FakeKeyVault.Entry(v.kp, v.spec) }      // a fresh single-use key each time
            m2.store.put(c2); m.certStore.ids().forEach { id -> m2.certStore.put(m.certStore.get(id)!!) }
            val req = bob.w.request("b1")
            val bundle = (m2.w.pay(Eth.wei("0.3"), req, null) as PayOutcome.Paid).bundle
            return bob.w.accept(bundle, "b1").accepted
        }
        assertTrue("control: a fully bound entry is accepted", accepts(snap(entry(coin, k0))))
        // the audit PoC: the same coin presented as another escrow's (and signed that way)
        assertFalse("another escrow", accepts(snap(entry(coin, k0)), tweak = { n -> Note(n.json.with("header", n.json.obj("header").with("escrow", Escrows.SEPOLIA_V31))) }))
        assertFalse("another depositor", accepts(snap(entry(coin, k0)), tweak = { n -> Note(n.json.with("header", n.json.obj("header").with("depositor", "0".repeat(37) + "bad"))) }))
        assertFalse("another chain", accepts(snap(entry(coin, k0, chainId = "1"))))
        assertFalse("entry without chainId", accepts(snap(entry(coin, k0, chainId = null))))
        assertFalse("entry without escrow", accepts(snap(entry(coin, k0, escrow = null))))
        assertFalse("entry without depositor (the harness's legacy format)", accepts(snap(entry(coin, k0, chainId = null, escrow = null, depositor = null))))
        assertTrue("the debug harness may still use legacy entries", accepts(snap(entry(coin, k0, chainId = null, escrow = null, depositor = null)), legacy = true))
    }

    @Test fun f08_theProductImportRefusesLegacySnapshotsAndDebugAllowsThem() {
        val dir = Files.createTempDirectory("dep").toFile()
        val legacy = snap(buildJsonObject { put("coinId", "ab".repeat(32)); put("value", "1"); put("expiry", 1); put("k0", "cd".repeat(32)) })
        assertThrows { DepositSources(dir).install(legacy) }
        DepositSources(dir, allowLegacySnapshots = true).install(legacy)
        val bound = snap(buildJsonObject { put("coinId", "ab".repeat(32)); put("value", "1"); put("expiry", 1); put("k0", "cd".repeat(32)); put("chainId", "11155111"); put("escrow", "0x" + Escrows.SEPOLIA_V31); put("depositor", "0x" + "11".repeat(20)) })
        DepositSources(Files.createTempDirectory("dep2").toFile()).install(bound)
    }

    // ================================================================== F-09: labels

    @Test fun f09_anAttackerChosenLabelCannotBlockSplittingTheReceivedNote() {
        val mallory = P(); val dir = Files.createTempDirectory("bob").toFile(); val bob = P(FileNoteStore(dir)); val carol = P()
        val coin = fund(mallory, "c", "0.9")
        mallory.store.put(Note(coin.json.with("header", coin.json.obj("header").with("label", "Lunch money/../x"))))   // never looked at by the verifier
        assertTrue(bob.w.accept(paid(mallory.w.pay(Eth.wei("0.9"), bob.w.request("b1"), null)).bundle, "b1").accepted)
        val held = bob.w.spendable().single()
        assertTrue("label sanitised on accept: '${held.label}'", Regex("^[0-9a-f]{6}$").matches(held.label))
        val r = bob.w.pay(Eth.wei("0.5"), carol.w.request("c1"), null)               // was: IllegalArgumentException from FileNoteStore.safe
        assertTrue((r as? PayOutcome.Refused)?.reason ?: "", r is PayOutcome.Paid)
        assertTrue("change alias is derived from the coin id, not the label", bob.keys.aliases().all { Regex("^(recv_b1|n_[0-9a-f]{8}_c[0-9]+(_[0-9a-f]{6})?)$").matches(it) })
        assertEquals(Eth.wei("0.4"), bob.w.spendableTotal())
    }

    @Test fun f09_mintValidatesLabelsAndNeverOverwritesAnUnconfirmedSignedPayment() {
        val a = P(); val b = P()
        for (bad in listOf("Lunch money", "a/b", "..", "", "x".repeat(25), "é")) assertThrows { a.w.mint(bad, Eth.wei("0.1"), 86400, Escrows.SEPOLIA, Escrows.SEPOLIA_V31, "03a62b04abe69f382bd7582f492be735b1ddb47b") }
        val coin = fund(a, "x", "0.5")
        a.w.pay(Eth.wei("0.5"), b.w.request("b1"), null)                             // signed; the verdict may never arrive
        assertNotNull(a.store.note(coin.alias)!!.signedBundle)
        assertThrows { fund(a, "x", "0.1") }                                         // was: allowed, destroying the only copy of the signed bundle
        assertNotNull("the stored bundle is intact", a.store.note(coin.alias)!!.signedBundle)
        // a spent note with nothing to lose may have its label reused
        val c = fund(a, "y", "0.1"); a.store.put(Note(c.json.with("spent", true))); a.keys.delete(c.alias)
        fund(a, "y", "0.1")
    }

    // ================================================================== F-10: requested amount

    @Test fun f10_aShortfallIsFlaggedAndATinyAmountIsNotZero() {
        val m = P(); val bob = P(); fund(m, "c", "1.0")
        val bundle = paid(m.w.pay(BigInteger.ONE, bob.w.request("b1"), null)).bundle
        val rep = bob.w.accept(bundle, "b1", Eth.wei("0.5"))
        assertTrue("still the payee's money", rep.accepted)
        assertTrue(rep.shortfall); assertEquals(Eth.wei("0.5"), rep.requestedWei)
        val line = rep.lines.first { it.title == "Amount matches the request" }
        assertFalse(line.ok); assertTrue(line.detail, line.detail.contains("paid") && line.detail.contains("0.5"))
        // enough, and no request at all
        val ok = P(); val m2 = P(); fund(m2, "c", "1.0")
        val r2 = ok.w.accept(paid(m2.w.pay(Eth.wei("0.5"), ok.w.request("b1"), null)).bundle, "b1", Eth.wei("0.5"))
        assertFalse(r2.shortfall); assertTrue(r2.lines.first { it.title == "Amount matches the request" }.ok)
        val none = P(); val m3 = P(); fund(m3, "c", "1.0")
        val r3 = none.w.accept(paid(m3.w.pay(BigInteger.ONE, none.w.request("b1"), null)).bundle, "b1")
        assertFalse(r3.shortfall); assertNull(r3.requestedWei); assertTrue(r3.lines.none { it.title == "Amount matches the request" })
    }

    // ================================================================== F-12: attestation parser and chain rules (synthetic chains)

    private val pkg = "xyz.prawl.offline"; private val dig = AttestationPolicy.DEBUG_CERT_SHA256
    private val policy = AttestationPolicy(listOf(AppIdentity(pkg, dig)))
    private val rootKey = Synth.newKey(); private val leafKey = Synth.newKey()
    private val caExt = Synth.ext("2.5.29.19", Synth.seq(Synth.bool(true)))                  // basicConstraints CA:TRUE

    private fun run(hw: Synth.Hw = Synth.Hw(), sw: List<ByteArray> = listOf(Synth.appId(pkg, dig)), rootExt: List<ByteArray> = listOf(caExt),
                    leafIssuerCn: String = "Root", trailing: ByteArray = ByteArray(0)): AttestationResult {
        val kd = Synth.keyDescription(2, 2, sw, hw.der()) + trailing
        val leafDer = Synth.cert(leafKey.public, rootKey.private, "leaf", leafIssuerCn, 11, listOf(Synth.ext(Synth.OID_KD, kd)))
        val rootDer = Synth.cert(rootKey.public, rootKey.private, "Root", "Root", 1, rootExt)
        return AttestationVerifier(TrustAnchors(listOf(rootDer), emptySet(), 1793878668L), policy) { 1793952000_000L }.verify(listOf(leafDer, rootDer))
    }

    @Test fun f12_aWellFormedSyntheticChainStillPasses() { val r = run(); assertTrue(r.summary(), r.ok) }

    @Test fun f12_duplicateTagsAreRefused() {
        assertFalse("[5,1]", run(Synth.Hw(usage = listOf(tagged(405, int(5)), tagged(405, int(1))))).ok)
        assertFalse("[1,5]", run(Synth.Hw(usage = listOf(tagged(405, int(1)), tagged(405, int(5))))).ok)
        val locked = tagged(704, Synth.seq(Synth.oct(ByteArray(32)), Synth.bool(true), Synth.enum(0), Synth.oct(ByteArray(32))))
        val unlocked = tagged(704, Synth.seq(Synth.oct(ByteArray(32)), Synth.bool(false), Synth.enum(2), Synth.oct(ByteArray(32))))
        assertFalse("two rootOfTrust", run(Synth.Hw(extra = listOf(unlocked, locked))).ok)
        assertFalse("two patch levels", run(Synth.Hw(extra = listOf(tagged(706, int(202001))))).ok)
        assertFalse("duplicate in the software list", run(sw = listOf(Synth.appId(pkg, dig), Synth.appId("evil.app", dig))).ok)
    }

    @Test fun f12_onlyContextSpecificTagsAreRead() {
        assertFalse("APPLICATION-class [405]", run(Synth.Hw(usage = listOf(tagged(405, int(1), cls = 0x40)))).ok)
        assertFalse("PRIVATE-class [405]", run(Synth.Hw(usage = listOf(tagged(405, int(1), cls = 0xc0)))).ok)
    }

    @Test fun f12_trailingBytesAfterTheKeyDescriptionAreRefused() {
        val r = run(trailing = byteArrayOf(0x30, 0x00, 0x05)); assertFalse(r.ok); assertTrue(r.fails.joinToString(), r.fails.any { it.contains("trailing") })
    }

    @Test fun f12_theChainMustBeIssuedByAndSignedByCAs() {
        assertFalse("issuer name differs", run(leafIssuerCn = "Completely Different Issuer").ok)
        val notCa = run(rootExt = listOf(Synth.ext("2.5.29.19", Synth.seq(Synth.bool(false)))))
        assertFalse("root with CA:FALSE", notCa.ok); assertTrue(notCa.fails.joinToString(), notCa.fails.any { it.contains("is a CA") })
        assertFalse("root without basicConstraints", run(rootExt = emptyList()).ok)
    }

    @Test fun f12_realChainsStillPassTheStricterRules() {
        val res = CertResolver(Vectors.certStore(Vectors.split, Vectors.e2e, Vectors.ho), Vectors.anchors)
        for (f in listOf("req_bob1.json", "req_dave1.json")) assertTrue(f, Vectors.verifier().verify(res.chain(ReceiveRequest(Vectors.json(Vectors.split, f)).chain)).ok)
        assertTrue(Vectors.verifier().verify(res.chain(Vectors.json(Vectors.split, "mint3_s.json").arr("k0").strings())).ok)
    }

    // ================================================================== F-13: the payer's certificate store

    @Test fun f13_aHostilePayeeCannotMakeThePayerStoreJunk() {
        val m = P(); fund(m, "c", "1.0")
        val junk = (1..5).map { i -> ByteArray(1_000_000) { (it * 31 + i).toByte() } }
        val ids = junk.map { CertStore.certId(it) }
        val req = ReceiveRequest(buildJsonObject {
            put("name", "x"); put("chain", JsonArray(ids.map { JsonPrimitive(it) }))
            put("certs", JsonObject(ids.zip(junk).associate { (id, d) -> id to JsonPrimitive(Bytes.b64(d)) })); put("known", JsonArray(emptyList()))
        })
        val before = m.certStore.ids().size
        assertTrue(m.w.pay(Eth.wei("0.1"), req, null) is PayOutcome.Refused)
        assertEquals("nothing was stored", before, m.certStore.ids().size)
        // also: a long chain is refused up front
        val long = ReceiveRequest(buildJsonObject { put("name", "x"); put("chain", JsonArray(List(100) { JsonPrimitive(ids[0]) })); put("certs", JsonObject(emptyMap())); put("known", JsonArray(emptyList())) })
        assertTrue((m.w.pay(Eth.wei("0.1"), long, null) as PayOutcome.Refused).reason.contains("entries"))
    }

    @Test fun f13_onlyCertificatesAnAcceptedChainUsesAreKept() {
        val alice = P(); val bob = P(); fund(alice, "c", "1.0")
        val pay = paid(alice.w.pay(Eth.wei("0.4"), bob.w.request("b1"), null))
        val junk = ByteArray(5000) { it.toByte() }; val junkId = CertStore.certId(junk)
        val padded = pay.bundle.with("certs", pay.bundle.obj("certs").let { c -> JsonObject(LinkedHashMap(c).also { it[junkId] = JsonPrimitive(Bytes.b64(junk)) }) })
        assertTrue(bob.w.accept(padded, "b1").accepted)
        assertNull("the unreferenced blob was dropped", bob.certStore.get(junkId))
    }

    @Test fun f13_theStoreRefusesOversizedCertificatesAndHasACap() {
        val s = MemoryCertStore()
        assertThrows { s.put(ByteArray(CertStore.MAX_CERT_BYTES + 1)) }
        assertThrows { s.put(ByteArray(0)) }
        repeat(CertStore.MAX_CERTS) { i -> s.put(ByteArray(40) { b -> (i shr (b % 8)).toByte() } + i.toString().toByteArray()) }
        assertEquals(CertStore.MAX_CERTS, s.ids().size)
        assertThrows { s.put("one more".toByteArray()) }
        s.put(s.get(s.ids().first())!!)           // re-storing a known certificate is fine
    }
}
