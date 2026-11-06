package xyz.prawl.offline.ui.screens

import android.app.Activity
import android.app.Application
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import xyz.prawl.core.android.BiometricApprover
import xyz.prawl.core.model.Note
import xyz.prawl.core.protocol.OfflineWallet
import xyz.prawl.core.protocol.VerifyLine
import xyz.prawl.core.transport.PayQr
import xyz.prawl.core.transport.PaymentSession
import xyz.prawl.core.transport.SecureLink
import xyz.prawl.core.util.Eth
import xyz.prawl.offline.LocalHostActivity
import xyz.prawl.offline.Nav
import xyz.prawl.offline.graph
import xyz.prawl.offline.ui.Fmt
import xyz.prawl.offline.ui.components.Amount
import xyz.prawl.offline.ui.components.CheckList
import xyz.prawl.offline.ui.components.Field
import xyz.prawl.offline.ui.components.KeyValue
import xyz.prawl.offline.ui.components.PCard
import xyz.prawl.offline.ui.components.Page
import xyz.prawl.offline.ui.components.PermissionGate
import xyz.prawl.offline.ui.components.Perms
import xyz.prawl.offline.ui.components.PrimaryButton
import xyz.prawl.offline.ui.components.QrScanner
import xyz.prawl.offline.ui.components.Secondary
import xyz.prawl.offline.ui.components.SecondaryButton
import xyz.prawl.offline.ui.components.StatusLine
import xyz.prawl.offline.ui.theme.PrawlTheme
import xyz.prawl.offline.ui.theme.Status
import xyz.prawl.offline.ui.theme.Tw
import java.math.BigInteger

sealed interface PayPhase {
    data object Scan : PayPhase
    data class Amount(val qr: PayQr) : PayPhase
    data class Working(val qr: PayQr, val step: String) : PayPhase
    data class Done(val qr: PayQr, val amountWei: BigInteger, val changeWei: BigInteger, val resent: Boolean,
                    val accepted: Boolean, val verdict: String, val lines: List<VerifyLine>, val fails: List<String>,
                    /** false: the signature exists only in memory (disk failure); the wallet cannot recover it after a restart (audit F-06). */
                    val persisted: Boolean = true) : PayPhase
    /** Signed and stored, but no verdict: retrying to the same code resends the same bytes. */
    data class VerdictLost(val qr: PayQr, val amountWei: BigInteger, val error: String) : PayPhase
    data class Failed(val qr: PayQr?, val message: String) : PayPhase
}

/**
 * Payer flow: scan the payee's code -> amount -> connect (BLE/L2CAP or classic) -> receive the request ->
 * check its key equals the code's key hash and is a hardware one-time key -> owner approval (BiometricPrompt +
 * CryptoObject, if the note's key requires it) -> sign -> send -> payee's verdict.
 */
class PayViewModel(app: Application) : AndroidViewModel(app) {
    private val g = app.graph
    val phase = MutableStateFlow<PayPhase>(PayPhase.Scan)

    fun scanned(text: String) {
        phase.value = try { PayPhase.Amount(PayQr.parse(text)) } catch (e: Exception) { PayPhase.Failed(null, "Not a Prawl receive code: ${e.message}") }
    }

    fun preview(amountWei: BigInteger?): Note? = amountWei?.let { runCatching { g.wallet().selectNote(it) }.getOrNull() }

    fun pay(qr: PayQr, amountWei: BigInteger, activity: Activity) {
        phase.value = PayPhase.Working(qr, "Finding the payee nearby…")
        viewModelScope.launch(Dispatchers.IO) {
            val w = g.wallet { line ->
                when {
                    line.contains("payee key check") -> step(qr, "Checking the payee's key attestation…")
                    line.startsWith("PAY ") -> step(qr, "Waiting for your approval (fingerprint / PIN)…")
                    line.startsWith("SIGNED") || line.startsWith("RESEND") -> step(qr, "Signed. Sending…")
                }
            }
            try {
                val sock = if (qr.transport == PayQr.RFCOMM) g.bluetooth.connectRfcommByDiscovery(qr.btName ?: error("code has no device name"), qr.serviceUuid)
                else g.bluetooth.connectL2cap(qr.serviceUuid, qr.psm!!)
                step(qr, "Connected. Receiving the payment request…")
                val res = sock.use { s ->
                    val link = SecureLink(g.bluetooth.link(s), qr.secret, qr.sessionId(), SecureLink.Role.PAYER)
                    PaymentSession.payer(link, { req ->
                        if (req.name != qr.id) OfflineWallet.PayOutcome.Refused("the request does not belong to the scanned code")
                        else w.pay(amountWei, req, BiometricApprover(activity), OfflineWallet.PayOptions(expectedKeyHash = qr.keyHash))
                    })
                }
                g.changed()
                phase.value = when (res) {
                    is PaymentSession.PayerResult.Refused -> PayPhase.Failed(qr, res.outcome.reason)
                    is PaymentSession.PayerResult.VerdictLost -> PayPhase.VerdictLost(qr, res.outcome.amount, res.error)
                    is PaymentSession.PayerResult.Answered -> PayPhase.Done(qr, res.outcome.amount, res.outcome.change, res.outcome.resent,
                        res.verdict.accepted, res.verdict.verdict, res.verdict.lines, res.verdict.fails, res.outcome.persisted)
                }
            } catch (e: Exception) {
                g.changed()
                phase.value = PayPhase.Failed(qr, e.message ?: e.toString())
            }
        }
    }

    private fun step(qr: PayQr, s: String) { phase.value = PayPhase.Working(qr, s) }
    fun reset() { phase.value = PayPhase.Scan }
    fun backToAmount(qr: PayQr) { phase.value = PayPhase.Amount(qr) }
}

@Composable
fun PayScreen(nav: Nav, link: String?) {
    val vm: PayViewModel = viewModel()
    val phase by vm.phase.collectAsState()
    val activity = LocalHostActivity.current
    LaunchedEffect(link) { if (link != null) vm.scanned(link) }
    Page("Pay", nav::back) {
        when (val p = phase) {
            PayPhase.Scan -> PermissionGate(Perms.CAMERA, "Camera needed to scan",
                "Scan the payee's receive code. Images are decoded on this phone and never stored or sent.") {
                PCard(title = "Scan the payee's code") {
                    QrScanner(onResult = vm::scanned)
                    Secondary("Or open a prawl://offline/pay link they sent you.")
                }
            }
            is PayPhase.Amount -> PermissionGate(Perms.BT_PAYER, "Bluetooth needed to pay",
                "Your phone finds the payee by the random code in their QR and sends the payment directly, offline. " +
                    "Scan results are never used for location.") {
                AmountStep(p.qr, vm, onPay = { amt -> activity?.let { vm.pay(p.qr, amt, it) } }, onRescan = vm::reset)
            }
            is PayPhase.Working -> PCard {
                StatusLine(Status.PENDING, p.step, busy = true)
                Secondary("Keep both phones close together.")
            }
            is PayPhase.Done -> PayDoneContent(p, onDone = { nav.back() })
            is PayPhase.VerdictLost -> {
                PCard(border = Tw.amber400.copy(alpha = 0.5f)) {
                    StatusLine(Status.PENDING, "Sent, but the payee's answer did not arrive")
                    Secondary("Your signed payment of ${Fmt.eth(p.amountWei)} ETH is stored. Ask the payee to tap Try again; " +
                        "then pay to their new code: your phone resends exactly the same payment (it cannot pay anyone else with that note).")
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { PrimaryButton("Scan again", vm::reset); SecondaryButton("Close", { nav.back() }) }
            }
            is PayPhase.Failed -> {
                PCard(border = Tw.red400.copy(alpha = 0.5f)) { StatusLine(Status.ERROR, p.message) }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (p.qr != null) PrimaryButton("Try again", { vm.backToAmount(p.qr) })
                    SecondaryButton("Scan another code", vm::reset)
                }
            }
        }
    }
}

@Composable
private fun AmountStep(qr: PayQr, vm: PayViewModel, onPay: (BigInteger) -> Unit, onRescan: () -> Unit) {
    val g = LocalContext.current.graph
    var amount by remember(qr) { mutableStateOf(qr.amountWei?.let { Eth.eth(it) } ?: "") }
    val wei = runCatching { Eth.wei(amount) }.getOrNull()?.takeIf { it.signum() > 0 }
    val note = remember(wei) { vm.preview(wei) }
    PCard(title = "Pay request ${qr.id}") {
        KeyValue("Payee one-time key", Fmt.hex(qr.keyHash, 16), mono = true)
        KeyValue("Connection", if (qr.transport == PayQr.RFCOMM) "Classic · ${qr.btName}" else "Nearby (BLE)")
        qr.amountWei?.let { KeyValue("Requested", Fmt.eth(it) + " ETH", mono = true) }
        Field(amount, { amount = it }, "Amount (ETH)", mono = true, number = true,
            error = if (amount.isNotBlank() && wei == null) "Enter an amount in ETH (up to 18 decimals)" else null)
        when {
            wei == null -> {}
            note == null -> StatusLine(Status.ERROR, "No single note covers ${Fmt.eth(wei)} ETH (or it is too close to expiry / past the hop limit).")
            else -> {
                val change = note.value - wei
                Secondary("Spends a ${Fmt.eth(note.value)} ETH note (hop ${note.depth + 1}/3)" +
                    if (change.signum() > 0) "; ${Fmt.eth(change)} ETH comes back to you as change on a fresh one-time key." else ".")
                Secondary(if (g.keys.requiresUserAuth(note.alias)) "You will approve with fingerprint or PIN; the secure hardware will not sign without it."
                    else "This note's key was made without owner approval: paying needs no fingerprint.")
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PrimaryButton("Pay", { wei?.let(onPay) }, enabled = wei != null && note != null)
            SecondaryButton("Rescan", onRescan)
        }
    }
}

@Composable
fun PayDoneContent(p: PayPhase.Done, onDone: () -> Unit) {
    PCard(border = (if (p.accepted) Tw.emerald400 else Tw.red400).copy(alpha = 0.5f)) {
        StatusLine(if (p.accepted) Status.OK else Status.ERROR, if (p.accepted) "Payee accepted the payment" else "Payee rejected the payment (${p.verdict})")
        Amount(Fmt.eth(p.amountWei))
        if (p.resent) Secondary("Resent the payment already signed to this payee's key (safe retry).")
        if (!p.persisted) StatusLine(Status.PENDING, "Signed, but this phone could not save it. Do not rely on a retry: if the payee did not get it, the note is lost.")
        if (p.changeWei.signum() > 0) Secondary("Change: ${Fmt.eth(p.changeWei)} ETH, on a fresh one-time key.")
        if (!p.accepted) Secondary("The note is signed to this payee's key and cannot go elsewhere. If they fix the problem (e.g. sync deposits), pay their code again to resend.")
    }
    if (p.lines.isNotEmpty()) PCard(title = "Payee's checks") { CheckList(p.lines) }
    PrimaryButton("Done", onDone)
}

@Preview(widthDp = 400, heightDp = 1100, backgroundColor = 0xFF09090B, showBackground = true)
@Composable
fun PayDonePreview() = PrawlTheme { Page("Pay", {}) { PayDoneContent(SampleData.payDone, {}) } }
