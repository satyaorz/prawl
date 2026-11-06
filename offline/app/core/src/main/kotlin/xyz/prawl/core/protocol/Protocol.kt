package xyz.prawl.core.protocol

import xyz.prawl.core.model.CoinHeader
import xyz.prawl.core.model.Output
import xyz.prawl.core.util.Bytes
import java.nio.charset.StandardCharsets

/**
 * The v3 signed-message formats (raw/v3/SPEC.md §3), identical to Wallet3Activity:
 *
 *   PRAWL-OTK-v3|<chainId>|<escrow40>|<coinIdHex64>|<expiry>|<depth>|<parentNoteId>|<outputsHash>
 *   outputsHash   = sha256hex(join(";", value_i + ":" + keyHash_i))
 *   genesis note  = sha256hex("genesis|" + coinId)
 *   child note    = sha256hex(hex(sigDER of the parent spend) + "|" + outputIndex)
 *   redeem key    = sha256hex("PRAWL-REDEEM|" + chainId + "|" + escrow40 + "|" + payout40)
 */
object Protocol {
    const val MESSAGE_PREFIX = "PRAWL-OTK-v3"

    fun outputsHash(outs: List<Output>): String =
        Bytes.sha256Hex(outs.joinToString(";") { it.value.toString() + ":" + it.key })

    fun spendMessage(h: CoinHeader, depth: Int, parentNoteId: String, outs: List<Output>): ByteArray =
        ("$MESSAGE_PREFIX|${h.chainId}|${h.escrow}|${h.coinId}|${h.expiry}|$depth|$parentNoteId|${outputsHash(outs)}")
            .toByteArray(StandardCharsets.UTF_8)

    fun genesisNoteId(coinId: String): String = Bytes.sha256Hex("genesis|$coinId")

    fun childNoteId(sigB64: String, index: Int): String = Bytes.sha256Hex(Bytes.hex(Bytes.unb64(sigB64)) + "|" + index)

    fun redeemKey(chainId: String, escrow40: String, payout: String): String =
        Bytes.sha256Hex("PRAWL-REDEEM|$chainId|$escrow40|" + payout.lowercase().replace("0x", ""))
}
