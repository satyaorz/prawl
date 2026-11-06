package xyz.prawl.core.protocol

import java.math.BigInteger

/**
 * What a recipient requires of an incoming note (v2/v3 hardening). The constructor refuses any value
 * weaker than the harness (Wallet2Activity / Wallet3Activity); user settings may only tighten it.
 *
 * Harness values: hop limit 3, cap 1.0 ETH, 0.05 ETH when the revocation list is more than 48 h old,
 * at least 1 h of lifetime left.
 */
data class RecipientPolicy(
    val maxHops: Int = MAX_HOPS,
    val capWei: BigInteger = CAP_WEI,
    val staleCapWei: BigInteger = STALE_CAP_WEI,
    val minRemainingS: Long = MIN_REMAINING_S,
    val revocationMaxAgeS: Long = REVOCATION_MAX_AGE_S,
    /**
     * If non-null, only coins of these (chainId, escrow40) pairs are accepted. Null = any escrow (the
     * harness's behaviour; the deposit check is then the only binding to an escrow).
     */
    val acceptedEscrows: Set<Pair<String, String>>? = null,
) {
    init {
        require(maxHops in 1..MAX_HOPS) { "hop limit may not exceed $MAX_HOPS" }
        require(capWei.signum() > 0 && capWei <= CAP_WEI) { "cap may not exceed the 1.0 ETH offline cap" }
        require(staleCapWei.signum() > 0 && staleCapWei <= STALE_CAP_WEI) { "stale cap may not exceed 0.05 ETH" }
        require(minRemainingS >= MIN_REMAINING_S) { "minimum remaining lifetime may not be below 1 h" }
        require(revocationMaxAgeS in 1..REVOCATION_MAX_AGE_S) { "revocation list max age may not exceed 48 h" }
    }

    /** Cap in force: the stale cap if the revocation list is too old (and never above the user cap). */
    fun effectiveCap(nowS: Long, revocationFetchedAt: Long): BigInteger =
        if (isStale(nowS, revocationFetchedAt)) staleCapWei.min(capWei) else capWei

    fun isStale(nowS: Long, revocationFetchedAt: Long) = nowS - revocationFetchedAt > revocationMaxAgeS

    companion object {
        const val MAX_HOPS = 3
        val CAP_WEI: BigInteger = BigInteger("1000000000000000000")
        val STALE_CAP_WEI: BigInteger = BigInteger("50000000000000000")
        const val MIN_REMAINING_S = 3600L
        const val REVOCATION_MAX_AGE_S = 48 * 3600L
    }
}
