package xyz.prawl.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import xyz.prawl.core.certs.MemoryCertStore
import xyz.prawl.core.deposit.DepositVerifier
import xyz.prawl.core.deposit.SnapshotDepositVerifier
import xyz.prawl.core.handoff.Handoff
import xyz.prawl.core.keys.KeySpec
import xyz.prawl.core.keys.SpendApprover
import xyz.prawl.core.protocol.OfflineWallet
import xyz.prawl.core.protocol.OfflineWallet.PayOutcome
import xyz.prawl.core.protocol.RecipientPolicy
import xyz.prawl.core.store.MemoryNoteStore
import xyz.prawl.core.transport.FramedLink
import xyz.prawl.core.transport.PayQr
import xyz.prawl.core.transport.PaymentSession
import xyz.prawl.core.transport.SecureLink
import xyz.prawl.core.util.Bytes
import xyz.prawl.core.util.Eth
import java.io.PipedInputStream
import java.io.PipedOutputStream
import java.math.BigInteger
import java.util.UUID
import kotlin.concurrent.thread

/** End-to-end wallet logic on the JVM with software keys (single-use emulated), three phones. */
class WalletFlowTest {
    private val deposits = ArrayList<kotlinx.serialization.json.JsonObject>()
    private val depositVerifier: () -> DepositVerifier = {
        SnapshotDepositVerifier(buildJsonObject { put("deposits", JsonArray(deposits.toList())) })
    }
    private var now = Vectors.NOW_S * 1000

    inner class Phone(val name: String, val checker: FakeChecker = FakeChecker(), var ownerApproval: Boolean = false) {
        val keys = FakeKeyVault()
        val log = ArrayList<String>()
        val w = OfflineWallet(keys, MemoryNoteStore(), MemoryCertStore(), Vectors.anchors, checker, { RecipientPolicy() },
            depositVerifier, { ownerApproval }, { now }, { log.add("[$name] $it") })
    }

    private fun mint(p: Phone, label: String, eth: String, expiresIn: Long = 14 * 86400): OfflineWallet.MintResult {
        val m = p.w.mint(label, Eth.wei(eth), expiresIn, "11155111", "70b3b7edcd18087c999ec80e3c3b0227c7e0d6e5",
            "03a62b04abe69f382bd7582f492be735b1ddb47b", pendingDeposit = true)
        val k0 = p.w.certs.leafKeyHash(m.note.header.k0)
        deposits.add(buildJsonObject { put("coinId", m.note.header.coinId); put("value", m.note.header.value.toString()); put("expiry", m.note.header.expiry); put("k0", k0) })
        return m
    }

    private fun paid(o: PayOutcome): PayOutcome.Paid { assertTrue((o as? PayOutcome.Refused)?.reason ?: "", o is PayOutcome.Paid); return o as PayOutcome.Paid }

    @Test fun splitChangeTwoHopsRedeemAndDoubleSpend() {
        val alice = Phone("alice"); val bob = Phone("bob"); val carol = Phone("carol")
        val m = mint(alice, "s", "1.0")
        // not spendable until the deposit is confirmed
        val req1 = bob.w.request("b1")
        assertTrue(alice.w.pay(Eth.wei("0.3"), req1, null) is PayOutcome.Refused)
        alice.w.markDeposited(m.note.alias, "0xabc")
        // handoff load payload carries the mint fields
        val load = m.handoff
        assertEquals("load", (load["t"] as kotlinx.serialization.json.JsonPrimitive).content)

        val p1 = paid(alice.w.pay(Eth.wei("0.3"), req1, null))
        assertEquals(Eth.wei("0.7"), p1.change)
        val r1 = bob.w.accept(p1.bundle, "b1")
        assertTrue(r1.fails.toString(), r1.accepted)
        assertEquals(Eth.wei("0.3"), bob.w.spendableTotal())
        assertEquals(Eth.wei("0.7"), alice.w.spendableTotal())

        // retry to the same key resends the identical signed bytes
        val again = paid(alice.w.pay(Eth.wei("0.3"), req1, null))
        assertTrue(again.resent)
        assertEquals(p1.bundle["path"], again.bundle["path"])
        assertTrue("accepting the same payment again is idempotent", bob.w.accept(again.bundle, "b1").accepted)

        // malicious wallet: re-spend the genesis note -> the (emulated) hardware refuses; the change key is deleted
        val before = alice.keys.entries.size
        val ds = alice.w.pay(Eth.wei("0.9"), carol.w.request("c0"), null, OfflineWallet.PayOptions(forceNote = m.note.alias))
        assertTrue(ds is PayOutcome.Refused)
        assertTrue((ds as PayOutcome.Refused).reason.contains("secure hardware"))
        assertEquals(before, alice.keys.entries.size)

        // hop 2: Bob -> Carol 0.1, over an encrypted in-memory link
        val qrSecret = ByteArray(16).also { java.security.SecureRandom().nextBytes(it) }
        val req = carol.w.request("c1")
        val qr = PayQr("c1", carol.w.pendingKeyHash("c1")!!, qrSecret, PayQr.L2CAP, UUID.randomUUID(), psm = 0x80)
        val parsed = PayQr.parse(qr.link())
        assertEquals(qr, parsed)
        val (payeeLink, payerLink) = pipePair(parsed.secret, parsed.sessionId(), parsed.secret)
        var payeeRes: PaymentSession.PayeeResult? = null
        val t = thread { payeeRes = PaymentSession.payee(payeeLink, req, true, { carol.w.accept(it, "c1") }) }
        val pr = PaymentSession.payer(payerLink, { r ->
            bob.w.pay(Eth.wei("0.1"), r, null, OfflineWallet.PayOptions(expectedKeyHash = parsed.keyHash))
        })
        t.join()
        assertTrue(pr is PaymentSession.PayerResult.Answered)
        val verdict = (pr as PaymentSession.PayerResult.Answered).verdict
        assertTrue(verdict.fails.toString(), verdict.accepted)
        assertEquals(Eth.wei("0.1"), verdict.value)
        assertTrue(verdict.lines.isNotEmpty() && verdict.lines.all { it.ok })
        assertEquals(PaymentSession.PayeeStatus.ACCEPTED, payeeRes!!.status)
        assertEquals(2, carol.w.spendable().single().depth)

        // conservation across all phones: 0.7 + 0.2 + 0.1 = deposit
        assertEquals(Eth.wei("1.0"), alice.w.spendableTotal() + bob.w.spendableTotal() + carol.w.spendableTotal())

        // Carol cashes out: phone-signed redemption -> HANDOFF redeem payload
        val note = carol.w.spendable().single()
        val red = carol.w.redeem(note.alias, Eth.checksum("03a62b04abe69f382bd7582f492be735b1ddb47b"), null)
        assertTrue(red is OfflineWallet.RedeemOutcome.Signed)
        val ho = (red as OfflineWallet.RedeemOutcome.Signed).handoff
        assertEquals(2, (ho["path"] as JsonArray).size)
        val link = Handoff.httpsLink("https://<site>", "redeem", Handoff.encode(ho))
        assertEquals(ho, Handoff.parseLink(link).payload)
        assertTrue("redeemed note is spent", carol.w.spendable().isEmpty())
        assertTrue(carol.w.redeem(note.alias, "0x03a62b04abe69f382bd7582f492be735b1ddb47b", null) is OfflineWallet.RedeemOutcome.Refused)
    }

    @Test fun payeeKeyIsCheckedBeforeSigning() {
        val alice = Phone("alice"); val mallory = Phone("mallory")
        val m = mint(alice, "k", "0.5"); alice.w.markDeposited(m.note.alias)
        val req = mallory.w.request("m1")
        alice.checker.bad.add(mallory.w.pendingKeyHash("m1")!!)
        val o = alice.w.pay(Eth.wei("0.1"), req, null)
        assertTrue(o is PayOutcome.Refused)
        assertTrue("note still unspent", alice.w.spendable().single().alias == m.note.alias)
        assertTrue("genesis key still usable", alice.keys.exists(m.note.alias))
    }

    @Test fun qrKeyHashMustMatchRequest() {
        val alice = Phone("alice"); val bob = Phone("bob"); val eve = Phone("eve")
        val m = mint(alice, "q", "0.5"); alice.w.markDeposited(m.note.alias)
        bob.w.request("b")
        val evil = eve.w.request("b")   // an attacker answering the BLE scan with its own request
        val o = alice.w.pay(Eth.wei("0.1"), evil, null, OfflineWallet.PayOptions(expectedKeyHash = bob.w.pendingKeyHash("b")))
        assertTrue(o is PayOutcome.Refused)
        assertEquals(1, alice.w.spendable().size)
    }

    @Test fun receiveKeyHoldsOnlyOneNote() {
        val alice = Phone("alice"); val dan = Phone("dan"); val bob = Phone("bob")
        val ma = mint(alice, "a", "0.5"); alice.w.markDeposited(ma.note.alias)
        val md = mint(dan, "d", "0.5"); dan.w.markDeposited(md.note.alias)
        val req = bob.w.request("one")
        assertTrue(bob.w.accept(paid(alice.w.pay(Eth.wei("0.2"), req, null)).bundle, "one").accepted)
        // a second payer reuses the same QR/key: rejected (a one-time key can only ever spend one note)
        val r = bob.w.accept(paid(dan.w.pay(Eth.wei("0.3"), req, null)).bundle, "one")
        assertFalse(r.accepted)
        assertTrue(r.fails.contains("receive key already used"))
    }

    @Test fun ownerApprovalPerSpend() {
        val alice = Phone("alice", ownerApproval = true); val bob = Phone("bob")
        val m = mint(alice, "u", "0.5"); alice.w.markDeposited(m.note.alias)
        assertTrue(alice.keys.requiresUserAuth(m.note.alias))
        // silent signing attempt (malware) is refused
        val silent = alice.w.pay(Eth.wei("0.1"), bob.w.request("x"), null)
        assertTrue(silent is PayOutcome.Refused)
        var asked = 0
        val approver = SpendApprover { s, _ -> asked++; s }
        val ok = alice.w.pay(Eth.wei("0.1"), bob.w.request("x"), approver)
        assertTrue(ok is PayOutcome.Paid)
        assertEquals(1, asked)
        // change key inherits the setting
        assertTrue(alice.keys.requiresUserAuth(alice.w.spendable().single().alias))
    }

    @Test fun payerPrechecksProtectTheKey() {
        val a = Phone("a"); val b = Phone("b"); val c = Phone("c"); val d = Phone("d"); val e = Phone("e")
        val m = mint(a, "h", "0.4"); a.w.markDeposited(m.note.alias)
        assertTrue(b.w.accept(paid(a.w.pay(Eth.wei("0.4"), b.w.request("1"), null)).bundle, "1").accepted)
        assertTrue(c.w.accept(paid(b.w.pay(Eth.wei("0.4"), c.w.request("2"), null)).bundle, "2").accepted)
        assertTrue(d.w.accept(paid(c.w.pay(Eth.wei("0.4"), d.w.request("3"), null)).bundle, "3").accepted)
        // 4th hop: the payer refuses before signing, so the note is not burnt
        val o = d.w.pay(Eth.wei("0.4"), e.w.request("4"), null)
        assertTrue(o is PayOutcome.Refused)
        assertEquals(1, d.w.spendable().size)
        // with prechecks off (harness), the payee's own hop limit rejects it
        val forced = paid(d.w.pay(Eth.wei("0.4"), e.w.request("4"), null, OfflineWallet.PayOptions(payerPrechecks = false)))
        val r = e.w.accept(forced.bundle, "4")
        assertTrue(r.fails.toString(), r.fails.any { it.startsWith("too many offline hops") })
    }

    @Test fun shortLivedCoinIsNotSpent() {
        val a = Phone("a"); val b = Phone("b")
        val m = mint(a, "x", "0.1", expiresIn = 1800); a.w.markDeposited(m.note.alias)
        assertTrue(a.w.pay(Eth.wei("0.1"), b.w.request("1"), null) is PayOutcome.Refused)
    }

    @Test fun wrongSessionSecretFailsAuthentication() {
        val bob = Phone("bob")
        val req = bob.w.request("z")
        val sid = Bytes.sha256(byteArrayOf(1)).copyOf(16)
        val (payee, payer) = pipePair(ByteArray(16) { 1 }, sid, ByteArray(16) { 2 })
        var st: PaymentSession.PayeeStatus? = null
        val t = thread { st = PaymentSession.payee(payee, req, true, { bob.w.accept(it, "z") }).status }
        assertThrows { PaymentSession.payer(payer, { error("must not get here") }) }
        payer.close(); t.join(5000)
        assertEquals(PaymentSession.PayeeStatus.LINK_LOST, st)
        assertNotNull("receive key kept for retry", bob.w.pendingKeyHash("z"))
    }

    /** The coin's light-client DepositProof travels in the bundle, prepared for the payee's advertised committees. */
    @Test fun depositProofIsForwardedWithThePayment() {
        val seen = ArrayList<kotlinx.serialization.json.JsonObject?>()
        val payer = OfflineWallet(FakeKeyVault(), MemoryNoteStore(), MemoryCertStore(), Vectors.anchors, FakeChecker(), { RecipientPolicy() },
            depositVerifier, nowMillis = { now }, depositProofFor = { id, lc -> seen.add(lc); buildJsonObject { put("version", "prawl-deposit-proof-v1"); put("coin", id) } })
        val payee = OfflineWallet(FakeKeyVault(), MemoryNoteStore(), MemoryCertStore(), Vectors.anchors, FakeChecker(), { RecipientPolicy() },
            depositVerifier, nowMillis = { now }, lcAdvertisement = { buildJsonObject { put("min", 1405); put("max", 1406) } })
        val m = payer.mint("p", Eth.wei("0.2"), 86400 * 3, "11155111", "70b3b7edcd18087c999ec80e3c3b0227c7e0d6e5", "03a62b04abe69f382bd7582f492be735b1ddb47b")
        deposits.add(buildJsonObject { put("coinId", m.note.header.coinId); put("value", m.note.header.value.toString()); put("expiry", m.note.header.expiry); put("k0", payer.certs.leafKeyHash(m.note.header.k0)) })
        val req = payee.request("w")
        assertNotNull(req.lc)
        val p = paid(payer.pay(Eth.wei("0.1"), req, null))
        assertEquals(m.note.header.coinId, ((p.bundle["depositProof"] as kotlinx.serialization.json.JsonObject)["coin"] as kotlinx.serialization.json.JsonPrimitive).content)
        assertEquals(req.lc, seen.single())
        assertTrue(payee.accept(p.bundle, "w").accepted)
        // redemption bundles do not carry it
        val r = payer.redeem(payer.spendable().single().alias, "03a62b04abe69f382bd7582f492be735b1ddb47b", null) as OfflineWallet.RedeemOutcome.Signed
        assertFalse(r.bundle.containsKey("depositProof"))
    }

    @Test fun labelReuseNeverDeletesValue() {
        val a = Phone("a")
        mint(a, "dup", "0.1")
        assertThrows { mint(a, "dup", "0.2") }
        assertEquals(1, a.w.notes.notes().size)
    }

    private fun pipePair(payeeSecret: ByteArray, sid: ByteArray, payerSecret: ByteArray): Pair<SecureLink, SecureLink> {
        val aIn = PipedInputStream(1 shl 20); val bOut = PipedOutputStream(aIn)
        val bIn = PipedInputStream(1 shl 20); val aOut = PipedOutputStream(bIn)
        val payee = SecureLink(FramedLink(aIn, aOut) { aOut.close(); aIn.close() }, payeeSecret, sid, SecureLink.Role.PAYEE)
        val payer = SecureLink(FramedLink(bIn, bOut) { bOut.close(); bIn.close() }, payerSecret, sid, SecureLink.Role.PAYER)
        return payee to payer
    }

}
