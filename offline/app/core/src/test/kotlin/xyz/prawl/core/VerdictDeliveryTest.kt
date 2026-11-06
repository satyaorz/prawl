package xyz.prawl.core

import kotlinx.serialization.json.JsonArray
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
import xyz.prawl.core.protocol.OfflineWallet
import xyz.prawl.core.protocol.RecipientPolicy
import xyz.prawl.core.store.MemoryNoteStore
import xyz.prawl.core.transport.Link
import xyz.prawl.core.transport.PaymentSession
import xyz.prawl.core.util.Eth
import java.io.EOFException
import java.io.IOException
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * In-memory transports that reproduce the BLE/L2CAP failure seen on the phones: Samsung payee -> OnePlus payer,
 * "payee accepts, payer gets EOF instead of the verdict".
 */
class VerdictDeliveryTest {

    private val EOF = "\u0000EOF"

    /**
     * One end of a link whose stack buffers writes for [flushDelayMs] before delivering them, and DROPS whatever is still
     * buffered when the writer closes (what the Samsung stack did with the verdict). After close, the peer reads EOF.
     * [dropFrom]: if set, every frame this end writes from the n-th (0-based) on is swallowed (connection dies
     * after the verdict is "written" but before it is read).
     */
    private class End(private val flushDelayMs: Long, private val dropFrom: Int = Int.MAX_VALUE) : Link {
        lateinit var peer: End
        val inbox = LinkedBlockingQueue<String>()
        private val unflushed = ArrayList<Pair<Long, String>>()
        @Volatile var closed = false
        private var written = 0

        @Synchronized override fun send(s: String) {
            if (closed) throw IOException("closed")
            val n = written++
            if (n >= dropFrom) return                      // connection is dead: write "succeeds", data never arrives
            unflushed.add(System.nanoTime() + flushDelayMs * 1_000_000 to s)
            thread(isDaemon = true) {
                Thread.sleep(flushDelayMs)
                synchronized(this) { if (unflushed.removeAll { it.second == s && it.first <= System.nanoTime() }) peer.inbox.add(s) }
            }
        }

        override fun recv(): String {
            while (true) {
                val m = inbox.poll(50, TimeUnit.MILLISECONDS)
                if (m != null) { if (m == "\u0000EOF") throw EOFException(); return m }
                if (closed) throw IOException("closed")
            }
        }

        @Synchronized override fun close() {
            if (closed) return
            closed = true
            unflushed.clear()                              // the stack drops unflushed data on close
            peer.inbox.add("\u0000EOF")
        }
    }

    private fun pair(flushDelayMs: Long, payeeDropFrom: Int = Int.MAX_VALUE): Pair<End, End> {
        val payee = End(flushDelayMs, payeeDropFrom); val payer = End(flushDelayMs)
        payee.peer = payer; payer.peer = payee
        return payee to payer
    }

    // ---- wallets
    private val deposits = ArrayList<kotlinx.serialization.json.JsonObject>()
    private val dv: () -> DepositVerifier = { SnapshotDepositVerifier(buildJsonObject { put("deposits", JsonArray(deposits.toList())) }, legacyUnbound = true) }
    private var now = Vectors.NOW_S * 1000
    private fun wallet() = OfflineWallet(FakeKeyVault(), MemoryNoteStore(), MemoryCertStore(), Vectors.anchors, FakeChecker(), { RecipientPolicy() }, dv, nowMillis = { now })

    private fun funded(eth: String = "0.5"): OfflineWallet {
        val w = wallet()
        val m = w.mint("c", Eth.wei(eth), 7 * 86400, "11155111", "70b3b7edcd18087c999ec80e3c3b0227c7e0d6e5", "03a62b04abe69f382bd7582f492be735b1ddb47b", pendingDeposit = true)
        deposits.add(buildJsonObject { put("coinId", m.note.header.coinId); put("value", m.note.header.value.toString()); put("expiry", m.note.header.expiry); put("k0", w.certs.leafKeyHash(m.note.header.k0)) })
        w.markDeposited(m.note.alias)
        return w
    }

    /** One BLE-style session. Returns (payee result, payer result). */
    private fun session(
        payer: OfflineWallet, payee: OfflineWallet, name: String, amount: String, flushMs: Long,
        payeeDropFrom: Int = Int.MAX_VALUE, ackTimeoutMs: Long = 3000, waitForAck: Boolean = true,
    ): Pair<PaymentSession.PayeeResult, PaymentSession.PayerResult> {
        val req = payee.request(name)
        val (e1, e2) = pair(flushMs, payeeDropFrom)
        var payeeRes: PaymentSession.PayeeResult? = null
        val t = thread {
            // like `sock.use { … }` in the app: the payee closes as soon as the session function returns
            payeeRes = try { PaymentSession.payee(e1, req, true, { payee.accept(it, name) }, ackTimeoutMs = if (waitForAck) ackTimeoutMs else 0) } finally { e1.close() }
        }
        val pr = try { PaymentSession.payer(e2, { r -> payer.pay(Eth.wei(amount), r, null) }) } finally { e2.close() }
        t.join(10_000)
        return payeeRes!! to pr
    }

    /** The bug, reproduced: closing right after the write drops the verdict (the old behaviour, ack wait disabled). */
    @Test fun withoutTheAckWaitTheVerdictIsDropped() {
        val payer = funded(); val payee = wallet()
        val (pe, pr) = session(payer, payee, "a", "0.1", flushMs = 150, waitForAck = false)
        assertEquals(PaymentSession.PayeeStatus.ACCEPTED, pe.status)                  // payee accepted ...
        assertTrue("payer must lose the verdict: $pr", pr is PaymentSession.PayerResult.VerdictLost)   // ... payer sees EOF
        assertEquals(Eth.wei("0.1"), payee.spendableTotal())
    }

    /** The fix: the payee waits for the payer's close-ack, so a slow stack still delivers the verdict. */
    @Test fun payeeWaitsForTheAckSoTheVerdictArrives() {
        val payer = funded(); val payee = wallet()
        val (pe, pr) = session(payer, payee, "b", "0.1", flushMs = 150)
        assertEquals(PaymentSession.PayeeStatus.ACCEPTED, pe.status)
        assertTrue("payer must get the verdict: $pr", pr is PaymentSession.PayerResult.Answered)
        assertTrue((pr as PaymentSession.PayerResult.Answered).verdict.accepted)
    }

    /** A payer that never acks (the old Java harness: it just disconnects) must not hang the payee. */
    @Test fun silentPayerDoesNotHangThePayee() {
        val payee = wallet()
        val req = payee.request("s")
        val (e1, e2) = pair(0)
        var res: PaymentSession.PayeeResult? = null
        val t0 = System.nanoTime()
        val t = thread { res = PaymentSession.payee(e1, req, true, { payee.accept(it, "s") }, ackTimeoutMs = 400) }
        e2.recv(); e2.send("{}")                 // payer sends "no payment"; then says nothing and keeps the socket open
        t.join(5_000)
        assertFalse("payee returned", t.isAlive)
        assertTrue((System.nanoTime() - t0) / 1_000_000 < 3000)
        assertEquals(PaymentSession.PayeeStatus.NO_PAYMENT, res!!.status)
    }

    /**
     * The connection dies after the verdict is written but before the payer reads it. The payer ends VerdictLost; the
     * payee holds the note. The payer reconnects to the same code: the payee answers ACCEPTED idempotently, credits nothing twice.
     */
    @Test fun lostVerdictIsRecoverableByResend() {
        val payer = funded(); val payee = wallet()
        // payee's 2nd frame (request = #0, verdict = #1) is swallowed
        val (pe1, pr1) = session(payer, payee, "r", "0.1", flushMs = 10, payeeDropFrom = 1, ackTimeoutMs = 300)
        assertEquals(PaymentSession.PayeeStatus.ACCEPTED, pe1.status)
        assertTrue(pr1 is PaymentSession.PayerResult.VerdictLost)
        assertEquals(Eth.wei("0.1"), payee.spendableTotal())
        val payerBefore = payer.spendableTotal()
        // the payer's wallet kept the signed payment; the payee re-presents the same key for the same request name
        val (pe2, pr2) = session(payer, payee, "r", "0.1", flushMs = 10)
        assertTrue("resend answered: $pr2", pr2 is PaymentSession.PayerResult.Answered)
        val a = pr2 as PaymentSession.PayerResult.Answered
        assertTrue(a.outcome.resent)
        assertTrue(a.verdict.accepted)
        assertEquals(PaymentSession.PayeeStatus.ACCEPTED, pe2.status)
        // nothing credited twice, nothing spent twice
        assertEquals(Eth.wei("0.1"), payee.spendableTotal())
        assertEquals(1, payee.notes.notes().size)
        assertEquals(payerBefore, payer.spendableTotal())
    }

    /** Idempotent accept also holds if the payee already spent the note (its receive key is gone), and expires. */
    @Test fun idempotentAcceptSurvivesSpendingAndExpires() {
        val payer = funded(); val payee = wallet(); val carol = wallet()
        val req = payee.request("i")
        val bundle = (payer.pay(Eth.wei("0.2"), req, null) as OfflineWallet.PayOutcome.Paid).bundle
        assertTrue(payee.accept(bundle, "i").accepted)
        // payee spends the note on to Carol: its one-time key is used up
        assertTrue(payee.pay(Eth.wei("0.2"), carol.request("c1"), null) is OfflineWallet.PayOutcome.Paid)
        assertEquals(0, payee.spendable().size)
        // the payer's resend of the identical payment: still ACCEPTED, no new note
        val again = payee.accept(bundle, "i")
        assertTrue(again.fails.toString(), again.accepted)
        assertEquals(Eth.wei("0.2"), again.receivedValue)
        assertTrue(again.lines.single().title == "Already accepted")
        // the receive key is still presentable to that payer
        assertNotNull(payee.request("i"))
        // a DIFFERENT payment to the same key is not covered by the record
        val other = funded("0.3")
        val b2 = (other.pay(Eth.wei("0.1"), payee.request("i"), null) as OfflineWallet.PayOutcome.Paid).bundle
        assertFalse(payee.accept(b2, "i").accepted)
        // the record expires
        now += 8 * 86400_000L
        assertFalse(payee.accept(bundle, "i").accepted)
        payee.request("zz")                       // pruning runs on request
        assertTrue(payee.notes.acceptedNames().isEmpty())
    }
}
