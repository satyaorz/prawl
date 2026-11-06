package xyz.prawl.core.deposit

import xyz.prawl.core.model.Note
import xyz.prawl.core.protocol.OfflineWallet
import xyz.prawl.core.util.optStr

/** What an online deposit check found for one coin. */
sealed interface ProofOutcome {
    /** A light-client proof now shows the deposit; it is stored with the coin. */
    data object Proven : ProofOutcome
    /** The escrow's finalized state has nothing for this coin (not funded, or not yet provable: that takes about 15 minutes). */
    data object Empty : ProofOutcome
    /** The check could not run (offline, sync failed) or the proof did not match: no conclusion is drawn. */
    data class Unavailable(val why: String) : ProofOutcome
}

/**
 * Keeps the phone's picture of its own coins honest, in the background, whenever it is online:
 *
 *  - a coin the phone deposited counts as spendable only once a proof of the deposit is stored. Until then it is "confirming", and the
 *    watcher retries the proof (a real deposit is provable ~15 min after its transaction);
 *  - if the escrow still shows NOTHING for a coin that was marked deposited, [graceS] after the mark, the mark was wrong: the coin goes back
 *    to "awaiting deposit";
 *  - a coin never funded for [unfundedMaxAgeS] is discarded (its key deleted);
 *  - a pending refresh is dropped only when its old coin is proven empty on-chain after the grace: a signed refresh of a real coin is the
 *    money and is kept however long it waits.
 *
 * [prove] runs the online check (and stores the proof on success); [hasProof] says whether one is stored.
 */
class DepositWatcher(
    private val wallet: OfflineWallet,
    private val notes: () -> List<Note>,
    private val hasProof: (coinIdHex: String) -> Boolean,
    private val prove: (Note) -> ProofOutcome,
    private val nowS: () -> Long,
    private val graceS: Long = 2 * 3600,
    private val unfundedMaxAgeS: Long = 24 * 3600,
) {
    data class Report(val proven: Int = 0, val reverted: Int = 0, val discarded: Int = 0, val refreshesAbandoned: Int = 0) {
        val changed get() = proven + reverted + discarded + refreshesAbandoned > 0
    }

    private fun pastGrace(n: Note): Boolean = n.depositedAt?.let { nowS() - it > graceS } ?: true

    fun run(): Report {
        val now = nowS()
        val discarded = wallet.discardStaleUndeposited(now, unfundedMaxAgeS)
        var proven = 0
        var reverted = 0

        // Coins this phone deposited, still without a stored proof (one check per coin id).
        val unproven = notes().filter { it.awaitsOwnProof && !hasProof(it.header.coinId) }.distinctBy { it.header.coinId }
        for (n in unproven) {
            when (val o = runCatching { prove(n) }.getOrElse { ProofOutcome.Unavailable(it.message ?: "check failed") }) {
                ProofOutcome.Proven -> proven++
                ProofOutcome.Empty -> if (pastGrace(n)) { wallet.markUndeposited(n.alias); reverted++ }
                is ProofOutcome.Unavailable -> Unit
            }
        }

        // Pending refreshes whose old coin never had a deposit can never land.
        var abandoned = 0
        for (r in wallet.pendingRefreshes()) {
            val old = notes().firstOrNull { it.alias == r.json.optStr("oldAlias") || it.header.coinId == r.oldCoinId } ?: continue
            if (hasProof(old.header.coinId)) continue
            if (!pastGrace(old)) continue
            val o = runCatching { prove(old) }.getOrElse { ProofOutcome.Unavailable(it.message ?: "check failed") }
            if (o == ProofOutcome.Empty) { wallet.abandonRefresh(r.coinId); abandoned++ }
        }
        return Report(proven, reverted, discarded, abandoned)
    }
}
