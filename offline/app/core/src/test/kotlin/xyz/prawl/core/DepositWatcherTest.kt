package xyz.prawl.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import xyz.prawl.core.certs.MemoryCertStore
import xyz.prawl.core.deposit.DepositCheck
import xyz.prawl.core.deposit.DepositVerifier
import xyz.prawl.core.deposit.DepositWatcher
import xyz.prawl.core.deposit.ProofOutcome
import xyz.prawl.core.model.Bundle
import xyz.prawl.core.model.CoinHeader
import xyz.prawl.core.model.Note
import xyz.prawl.core.protocol.Escrows
import xyz.prawl.core.protocol.OfflineWallet
import xyz.prawl.core.protocol.RecipientPolicy
import xyz.prawl.core.store.MemoryNoteStore
import xyz.prawl.core.util.with
import java.math.BigInteger

/** The background deposit watcher: honest "spendable", self-healing wrong marks, clean-up of unfunded coins and dead refreshes. */
class DepositWatcherTest {
    private val permissive = object : DepositVerifier {
        override val name = "test: every coin is backed"
        override fun check(header: CoinHeader, genesisKey: java.security.PublicKey?, k0Hash: String?, bundle: Bundle, nowS: Long) = DepositCheck(true, name, "backed")
    }
    private var now = Vectors.NOW_S
    private val store = MemoryNoteStore()
    private val w = OfflineWallet(FakeKeyVault(), store, MemoryCertStore(), Vectors.anchors, FakeChecker(), { RecipientPolicy() }, { permissive }, nowMillis = { now * 1000 })
    private val dep = "03a62b04abe69f382bd7582f492be735b1ddb47b"
    private val proofs = mutableSetOf<String>()
    private var answer: ProofOutcome = ProofOutcome.Empty
    private val asked = ArrayList<String>()

    private fun watcher() = DepositWatcher(w, { store.notes() }, { proofs.contains(it) }, { n -> asked.add(n.alias); answer.also { if (it == ProofOutcome.Proven) proofs.add(n.header.coinId) } }, { now })

    private fun mint(label: String, escrow: String = Escrows.SEPOLIA_V3, value: String = "5000000000000000"): Note =
        w.mint(label, BigInteger(value), 14 * 86400L, Escrows.SEPOLIA, escrow, dep, pendingDeposit = true).note
    private fun note(alias: String) = store.note(alias)!!

    @Test fun anUnfundedCoinIsDiscardedAfterADayButNotBefore() {
        val young = mint("young")
        now += 23 * 3600
        assertEquals(0, watcher().run().discarded)
        assertFalse(note(young.alias).spent)
        now += 2 * 3600
        assertEquals(1, watcher().run().discarded)
        assertTrue("the key and note are gone", note(young.alias).spent)
    }

    @Test fun aCoinWithADepositTransactionIsNeverAutoDiscarded() {
        val n = mint("funded-late")
        store.put(Note(n.json.with("depositTx", "0x" + "ab".repeat(32))))
        now += 5 * 86400
        assertEquals(0, watcher().run().discarded)
        assertFalse(note(n.alias).spent)
    }

    @Test fun aMarkedCoinStaysConfirmingUntilProvenAndIsNeverCountedAsProvenBeforeThat() {
        val n = mint("marked"); w.markDeposited(n.alias, "0x" + "cd".repeat(32))
        assertTrue(note(n.alias).awaitsOwnProof)
        answer = ProofOutcome.Empty
        val r = watcher().run()                                    // inside the grace period: no conclusion yet
        assertEquals(0, r.reverted); assertFalse(note(n.alias).pendingDeposit)
        answer = ProofOutcome.Unavailable("offline")
        assertFalse("an offline check changes nothing", watcher().run().changed)
        answer = ProofOutcome.Proven
        assertEquals(1, watcher().run().proven)
        assertEquals("once proven it is not asked again", 0, run { asked.clear(); watcher().run(); asked.size })
    }

    @Test fun aWrongDepositMarkRevertsAfterTheGracePeriodWithAFreshClock() {
        val n = mint("phantom"); w.markDeposited(n.alias)          // marked deposited, never funded (the case that showed a fake balance)
        answer = ProofOutcome.Empty
        now += 3 * 3600
        val r = watcher().run()
        assertEquals(1, r.reverted)
        val back = note(n.alias)
        assertTrue("it is awaiting deposit again", back.pendingDeposit)
        assertEquals("fresh clock for the unfunded clean-up", now, back.createdAt)
        now += 25 * 3600
        assertEquals("and a day later it is cleaned up", 1, watcher().run().discarded)
    }

    @Test fun aSignedRefreshOfARealCoinIsKeptHoweverLongItWaits() {
        val n = mint("real", Escrows.SEPOLIA_V31); w.markDeposited(n.alias)
        val out = w.refresh(n.alias, 14 * 86400L, dep, null)
        assertTrue(out is OfflineWallet.RefreshOutcome.Signed)
        assertEquals(1, w.pendingRefreshes().size)
        proofs.add(n.header.coinId)                                // the old coin's deposit is proven: this refresh is real money
        now += 30 * 86400
        answer = ProofOutcome.Empty
        assertEquals(0, watcher().run().refreshesAbandoned)
        assertEquals(1, w.pendingRefreshes().size)
    }

    @Test fun aRefreshOfACoinThatWasNeverDepositedIsDroppedOnlyOnceProvenEmptyAfterTheGrace() {
        val n = mint("ghost", Escrows.SEPOLIA_V31); w.markDeposited(n.alias)   // marked, never funded
        assertTrue(w.refresh(n.alias, 14 * 86400L, dep, null) is OfflineWallet.RefreshOutcome.Signed)
        answer = ProofOutcome.Empty
        assertEquals("inside the grace period: kept", 0, watcher().run().refreshesAbandoned)
        answer = ProofOutcome.Unavailable("offline")
        now += 3 * 3600
        assertEquals("offline: no conclusion, kept", 0, watcher().run().refreshesAbandoned)
        answer = ProofOutcome.Empty
        assertEquals(1, watcher().run().refreshesAbandoned)
        assertEquals(0, w.pendingRefreshes().size)
    }
}
