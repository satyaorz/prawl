package xyz.prawl.offline.ui

import xyz.prawl.core.model.Note
import xyz.prawl.core.protocol.Escrows
import xyz.prawl.core.util.Eth
import java.math.BigInteger
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

object Fmt {
    /** Amounts below 0.000001 ETH show as "<0.000001", never as "0" (audit F-10: 1 wei is not zero). */
    fun eth(w: BigInteger): String = if (w.signum() > 0 && w < MICRO_ETH) "<0.000001" else Eth.ethShort(w, 6)
    private val MICRO_ETH: BigInteger = BigInteger.TEN.pow(12)

    fun left(s: Long): String = when {
        s <= 0 -> "expired"
        s < 3600 -> "${s / 60} min"
        s < 86400 -> "${s / 3600} h ${(s % 3600) / 60} min"
        else -> "${s / 86400} d ${(s % 86400) / 3600} h"
    }

    fun addr(a40: String): String = "0x" + a40.take(6) + "…" + a40.takeLast(4)
    fun hex(h: String, n: Int = 8): String = h.removePrefix("0x").take(n) + "…"

    fun date(unixS: Long): String = SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.US).apply { timeZone = TimeZone.getDefault() }.format(Date(unixS * 1000))
}

/** Display model of one note (pure data, so screens can be previewed and screenshot-tested on the JVM). */
data class NoteView(
    val alias: String,
    val label: String,
    val valueWei: BigInteger,
    val depth: Int,
    val expiry: Long,
    val state: State,
    val ownerApproval: Boolean,
    val redeemedTo: String? = null,
    /** On escrow v3.1: can be refreshed (new expiry) or cashed out into a private balance. */
    val refreshable: Boolean = false,
) {
    /** CONFIRMING: this phone's own coin, marked deposited, whose deposit it has not yet proven on-chain (not spendable yet). */
    enum class State { SPENDABLE, CONFIRMING, AWAITING_DEPOSIT, SPENT, REDEEMED, REFRESHED }

    companion object {
        /** [proven]: this phone holds a deposit proof for the note's coin (only matters for its own, genesis coins). */
        fun of(n: Note, ownerApproval: Boolean, proven: Boolean = true) = NoteView(
            n.alias, n.label, n.value, n.depth, n.header.expiry,
            when {
                n.refreshedTo != null -> State.REFRESHED
                n.redeemedTo != null -> State.REDEEMED
                n.spent -> State.SPENT
                n.pendingDeposit -> State.AWAITING_DEPOSIT
                n.awaitsOwnProof && !proven -> State.CONFIRMING
                else -> State.SPENDABLE
            },
            ownerApproval, n.redeemedTo, Escrows.isV31(n.header.chainId, n.header.escrow),
        )
    }
}

/** A refresh signed and handed to the website, waiting for the user to confirm it landed. */
data class RefreshView(val coinId: String, val valueWei: BigInteger, val newExpiry: Long)
