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

    /**
     * Most outputs one spend may have (audit F2). Any redemption below a spend must carry ALL of its outputs, so an unbounded
     * fan-out would make a note unredeemable (calldata and gas). Recipients refuse more; the payer never builds more.
     */
    const val MAX_OUTPUTS = 32

    /** @throws NonCanonicalException unless there are 1..[MAX_OUTPUTS] outputs with positive uint256 values and canonical keys. */
    fun outputsHash(outs: List<Output>): String {
        Canonical.requireOutputs(outs)
        return Bytes.sha256Hex(outs.joinToString(";") { it.value.toString() + ":" + it.key })
    }

    /**
     * The exact bytes a note's key signs. Refuses to build the text from anything but the canonical spelling the escrow can rebuild
     * (audit F1): [h]'s chainId / escrow / coinId / expiry, [parentNoteId], and every output. Byte for byte
     * `PrawlV3Codec.message` / `prawl_v3.spend_message` (see ConformanceTest).
     * @throws NonCanonicalException
     */
    fun spendMessage(h: CoinHeader, depth: Int, parentNoteId: String, outs: List<Output>): ByteArray {
        Canonical.requireHeader(h)
        if (depth < 0) throw NonCanonicalException("negative depth")
        if (!Canonical.isHex64(parentNoteId)) throw NonCanonicalException("parentNoteId is not 64 lowercase hex digits")
        return ("$MESSAGE_PREFIX|${h.chainId}|${h.escrow}|${h.coinId}|${h.expiry}|$depth|$parentNoteId|${outputsHash(outs)}")
            .toByteArray(StandardCharsets.UTF_8)
    }

    fun genesisNoteId(coinId: String): String = Bytes.sha256Hex("genesis|$coinId")

    fun childNoteId(sigB64: String, index: Int): String = Bytes.sha256Hex(Bytes.hex(Bytes.unb64(sigB64)) + "|" + index)

    fun redeemKey(chainId: String, escrow40: String, payout: String): String =
        Bytes.sha256Hex("PRAWL-REDEEM|$chainId|$escrow40|" + payout.lowercase().replace("0x", ""))
}
