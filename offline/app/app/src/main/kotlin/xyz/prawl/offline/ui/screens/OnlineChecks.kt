package xyz.prawl.offline.ui.screens

import xyz.prawl.core.deposit.DepositCommitment
import xyz.prawl.core.model.CoinHeader
import xyz.prawl.offline.AppGraph
import xyz.prawl.offline.ui.theme.Status
import xyz.prawl.otktest.DepositProof

/**
 * Online: proves with a light-client DepositProof that `deposits[coinId]` of the coin's OWN escrow equals the commitment
 * computed from [h] (value, expiry, k0, depositor), syncing committees first if needed. The proof is stored with the coin
 * (it travels in bundles). Returns the verifier's result; the caller decides what a success means (deposit confirmed /
 * refresh confirmed).
 */
fun proveCoinOnChain(g: AppGraph, h: CoinHeader): DepositProof.Result {
    val lc = g.lightClient
    if (lc.cache() == null || lc.currentPeriod() > (lc.status().maxPeriod ?: 0)) lc.syncCommittees()
    return lc.buildProof(h.escrow, h.coinId, DepositCommitment.commitment(h))
}

/** User-facing outcome of a failed or pending [proveCoinOnChain]. */
fun explainProof(r: DepositProof.Result, what: String): Pair<Status, String> {
    val zero = r.value != null && r.value.all { it == 0.toByte() }
    return if (zero) Status.PENDING to "$what is not in the escrow at the last finalized block. It becomes provable about 15 minutes after the transaction; try again later."
    else Status.ERROR to "Check failed: ${r.error}"
}
