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
    fun eth(w: BigInteger): String = Eth.ethShort(w, 6)

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
    enum class State { SPENDABLE, AWAITING_DEPOSIT, SPENT, REDEEMED, REFRESHED }

    companion object {
        fun of(n: Note, ownerApproval: Boolean) = NoteView(
            n.alias, n.label, n.value, n.depth, n.header.expiry,
            when {
                n.refreshedTo != null -> State.REFRESHED
                n.redeemedTo != null -> State.REDEEMED
                n.spent -> State.SPENT
                n.pendingDeposit -> State.AWAITING_DEPOSIT
                else -> State.SPENDABLE
            },
            ownerApproval, n.redeemedTo, Escrows.isV31(n.header.chainId, n.header.escrow),
        )
    }
}

/** A refresh signed and handed to the website, waiting for the user to confirm it landed. */
data class RefreshView(val coinId: String, val valueWei: BigInteger, val newExpiry: Long)
