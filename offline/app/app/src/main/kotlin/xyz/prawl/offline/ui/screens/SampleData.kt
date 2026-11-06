package xyz.prawl.offline.ui.screens

import xyz.prawl.core.protocol.VerifyLine
import xyz.prawl.core.transport.PayQr
import xyz.prawl.offline.ui.NoteView
import java.math.BigInteger
import java.util.UUID

/** Representative data for @Preview and JVM screenshot tests (shapes taken from the real phone runs). */
object SampleData {
    const val NOW = 1793952000L
    val notes = listOf(
        NoteView("recv_r1a2b3c4", "c9f1e2", BigInteger("200000000000000000"), 1, NOW + 12 * 86400 + 5 * 3600, NoteView.State.SPENDABLE, true, refreshable = true),
        NoteView("n_c9f1e2_c1793942937257", "c9f1e2", BigInteger("700000000000000000"), 1, NOW + 12 * 86400, NoteView.State.SPENDABLE, true, refreshable = true),
        NoteView("recv_r9", "77aa01", BigInteger("1000000000000000"), 2, NOW + 30 * 3600, NoteView.State.SPENDABLE, false, refreshable = true),
        NoteView("recv_v3", "3c0de1", BigInteger("50000000000000000"), 1, NOW + 2 * 86400, NoteView.State.SPENDABLE, false),
        NoteView("n_5b11_g", "5b11", BigInteger("10000000000000000"), 0, NOW + 14 * 86400, NoteView.State.AWAITING_DEPOSIT, true),
        NoteView("n_c9f1e2_g", "c9f1e2", BigInteger("1000000000000000000"), 0, NOW + 12 * 86400, NoteView.State.SPENT, true),
    )
    val balance = BalanceState(notes, NOW, 6 * 3600, pendingRequests = 1, depositSources = 1,
        pendingRefreshes = listOf(xyz.prawl.offline.ui.RefreshView("52465348988d9cfd13fd12ff4f6ac905bb8032bf8aec0bb77c8b0cceeb0dece0", BigInteger("50000000000000000"), NOW + 14 * 86400)))

    /** The lines Dave's phone produced for the real 2-hop bundle pay3_s_dave1 (see core tests). */
    val lines = listOf(
        VerifyLine("0", "Coin format", true, "v=3"),
        VerifyLine("0", "Escrow", true, "chain 11155111, escrow 0x70b3b7edcd18087c999ec80e3c3b0227c7e0d6e5"),
        VerifyLine("0", "Offline hops", true, "2 of max 3"),
        VerifyLine("0", "Lifetime left", true, "13 d left (need 6 h)"),
        VerifyLine("1", "Backed by an on-chain deposit", true, "light-client deposit proof: finalized block (sample), 5xx/512 sync-committee signatures"),
        VerifyLine("1", "Header key = attested genesis key", true, "k0x/k0y match the certificate"),
        VerifyLine("2", "Genesis key is a hardware one-time key", true, "StrongBox, factory chain, patch 202610"),
        VerifyLine("3.0", "Spend 1: signature", true, "by the one-time key of the 1 ETH note"),
        VerifyLine("3.0", "Spend 1: value conserved", true, "[0.2] + 0.8 ETH"),
        VerifyLine("3.0", "Spend 1: output bound to next key", true, "output #0 pays the next key"),
        VerifyLine("3.0", "Spend 1: next key is a hardware one-time key", true, "TEE, RKP chain, patch 202605"),
        VerifyLine("3.1", "Spend 2: signature", true, "by the one-time key of the 0.2 ETH note"),
        VerifyLine("3.1", "Spend 2: value conserved", true, "[0.1] + 0.1 ETH"),
        VerifyLine("3.1", "Spend 2: output bound to next key", true, "output #0 pays the next key"),
        VerifyLine("3.1", "Spend 2: next key is a hardware one-time key", true, "StrongBox, factory chain, patch 202610"),
        VerifyLine("4", "Within offline cap", true, "0.1 ETH ≤ 1 ETH"),
        VerifyLine("4", "Pays my one-time receive key", true, "recv_r1a2b3c4"),
    )
    val receiveDone = ReceivePhase.Done(true, BigInteger("100000000000000000"), lines, emptyList(), "ACCEPTED", "r1a2b3c4", 43)
    val qr = PayQr("r1a2b3c4", "3f5b04552a479ae65e7624c0975ccc538e69af169a49a424e02d0e20d5b2edef", ByteArray(16) { it.toByte() },
        PayQr.L2CAP, UUID.fromString("0b7f3a52-5c1e-4c8e-9d1a-7a3c2f0e9b11"), psm = 133)
    val receiveWaiting = ReceivePhase.Waiting(qr.link(), PayQr.L2CAP, "r1a2b3c4", qr.keyHash)
    val payDone = PayPhase.Done(qr, BigInteger("100000000000000000"), BigInteger("100000000000000000"), false, true, "ACCEPTED", lines, emptyList())
    val device = DeviceCheckView("samsung SM-S938B", "Android 17 (SDK 37)", true, false, "StrongBox", true, false, 202610, true, true,
        true, emptyList(), true, true, "KeyRefusedException: coin key no longer exists (already used once)", 72, true, null, true)
}
