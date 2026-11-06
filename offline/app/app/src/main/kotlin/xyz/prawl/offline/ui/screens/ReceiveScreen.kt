package xyz.prawl.offline.ui.screens

import android.app.Application
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import xyz.prawl.core.android.BluetoothTransport
import xyz.prawl.core.protocol.VerifyLine
import xyz.prawl.core.transport.PayQr
import xyz.prawl.core.transport.PaymentSession
import xyz.prawl.core.transport.SecureLink
import xyz.prawl.core.util.Bytes
import xyz.prawl.core.util.Eth
import xyz.prawl.offline.Nav
import xyz.prawl.offline.graph
import xyz.prawl.offline.ui.Fmt
import xyz.prawl.offline.ui.components.Amount
import xyz.prawl.offline.ui.components.CheckList
import xyz.prawl.offline.ui.components.Field
import xyz.prawl.offline.ui.components.PCard
import xyz.prawl.offline.ui.components.Page
import xyz.prawl.offline.ui.components.PermissionGate
import xyz.prawl.offline.ui.components.Perms
import xyz.prawl.offline.ui.components.PrimaryButton
import xyz.prawl.offline.ui.components.QrImage
import xyz.prawl.offline.ui.components.Secondary
import xyz.prawl.offline.ui.components.SecondaryButton
import xyz.prawl.offline.ui.components.Segmented
import xyz.prawl.offline.ui.components.StatusLine
import xyz.prawl.offline.ui.theme.PrawlTheme
import xyz.prawl.offline.ui.theme.Status
import xyz.prawl.offline.ui.theme.Tw
import java.io.Closeable
import java.math.BigInteger
import java.security.SecureRandom
import java.util.UUID

sealed interface ReceivePhase {
    data object Idle : ReceivePhase
    data class Preparing(val what: String) : ReceivePhase
    data class Waiting(val link: String, val transport: String, val requestId: String, val keyHash: String) : ReceivePhase
    data class Verifying(val requestId: String) : ReceivePhase
    data class Done(
        val accepted: Boolean, val valueWei: BigInteger?, val lines: List<VerifyLine>, val fails: List<String>,
        val status: String, val requestId: String, val ms: Long,
    ) : ReceivePhase
    data class Failed(val message: String, val requestId: String?) : ReceivePhase
}

/**
 * Payee flow: fresh one-time receive key -> QR (request id, session UUID/PSM, key hash, session secret) ->
 * listen on Bluetooth -> verify the bundle -> verdict. The receive key stays pending until a payment to it is
 * accepted, so "Try again" reuses it (the payer's wallet then resends the same signed bytes).
 */
class ReceiveViewModel(app: Application) : AndroidViewModel(app) {
    private val g = app.graph
    val phase = MutableStateFlow<ReceivePhase>(ReceivePhase.Idle)
    private var listener: Closeable? = null
    private var job: Job? = null
    var requestId: String? = null; private set

    fun start(amountWei: BigInteger?, transport: String, reuse: Boolean) {
        job?.cancel(); closeListener()
        job = viewModelScope.launch(Dispatchers.IO) {
            try {
                val name = if (reuse && requestId != null) requestId!! else "r" + Bytes.hex(ByteArray(4).also { SecureRandom().nextBytes(it) })
                requestId = name
                phase.value = ReceivePhase.Preparing("Creating a one-time receive key in secure hardware…")
                val w = g.wallet()
                val req = w.request(name)
                val kh = w.pendingKeyHash(name) ?: error("receive key missing")
                val secret = ByteArray(16).also { SecureRandom().nextBytes(it) }
                val uuid = UUID.randomUUID()
                phase.value = ReceivePhase.Preparing("Opening Bluetooth…")
                val qr: PayQr
                val l: BluetoothTransport.Listener
                if (transport == PayQr.RFCOMM) {
                    l = g.bluetooth.RfcommListener(uuid, "Prawl")
                    qr = PayQr(name, kh, secret, PayQr.RFCOMM, uuid, btName = g.bluetooth.localName(), amountWei = amountWei)
                } else {
                    val ll = g.bluetooth.L2capListener(uuid)
                    l = ll
                    qr = PayQr(name, kh, secret, PayQr.L2CAP, uuid, psm = ll.psm, amountWei = amountWei)
                }
                listener = l
                phase.value = ReceivePhase.Waiting(qr.link(), transport, name, kh)
                val sock = try { l.accept(180_000) } finally { closeListener() }
                phase.value = ReceivePhase.Verifying(name)
                val res = sock.use { s ->
                    val link = SecureLink(g.bluetooth.link(s), secret, qr.sessionId(), SecureLink.Role.PAYEE)
                    PaymentSession.payee(link, req, rich = true, accept = { w.accept(it, name) })
                }
                g.changed()
                val rep = res.report
                phase.value = when (res.status) {
                    PaymentSession.PayeeStatus.LINK_LOST -> ReceivePhase.Failed(
                        "Connection lost before the payment arrived. Your receive key is kept: tap Try again and let the payer scan the new code.", name)
                    PaymentSession.PayeeStatus.NO_PAYMENT -> ReceivePhase.Failed("The payer's phone refused to sign (its secure hardware said no). Nothing was received.", name)
                    else -> ReceivePhase.Done(res.status == PaymentSession.PayeeStatus.ACCEPTED, rep?.receivedValue, rep?.lines.orEmpty(),
                        rep?.fails.orEmpty(), res.status.name, name, rep?.ms ?: 0)
                }
            } catch (e: Exception) {
                closeListener()
                if (phase.value !is ReceivePhase.Idle) phase.value = ReceivePhase.Failed(
                    when {
                        e.message?.contains("timeout", true) == true || e.message?.contains("Try again", true) == true ->
                            "No payer connected within 3 minutes. Your receive key is kept: tap Try again."
                        else -> e.message ?: e.toString()
                    }, requestId)
            }
        }
    }

    fun cancel(discard: Boolean) {
        job?.cancel(); closeListener()
        if (discard) requestId?.let { id -> viewModelScope.launch(Dispatchers.IO) { runCatching { g.wallet().cancelRequest(id) }; g.changed() } }
        if (discard) requestId = null
        phase.value = ReceivePhase.Idle
    }

    private fun closeListener() { runCatching { listener?.close() }; listener = null }
    override fun onCleared() { closeListener() }
}

@Composable
fun ReceiveScreen(nav: Nav) {
    val vm: ReceiveViewModel = viewModel()
    val g = androidx.compose.ui.platform.LocalContext.current.graph
    val phase by vm.phase.collectAsState()
    var transport by remember { mutableStateOf(g.settings.transport) }
    var amount by remember { mutableStateOf("") }
    val discoverable = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        // resultCode = discoverable seconds, or RESULT_CANCELED
        if (r.resultCode > 0) vm.start(amount.toWeiOrNull(), PayQr.RFCOMM, vm.requestId != null)
    }
    DisposableEffect(Unit) { onDispose { if (vm.phase.value is ReceivePhase.Waiting) vm.cancel(false) } }
    val perms = if (transport == PayQr.RFCOMM) Perms.BT_PAYEE_CLASSIC else Perms.BT_PAYEE_BLE
    Page("Receive", nav::back) {
        PermissionGate(perms, "Bluetooth needed to receive",
            "The payer's phone connects to yours over Bluetooth, nearby and offline. Prawl uses it only while this screen " +
                "is open, never for location, and shows your phone only under a random one-time code.") {
            if (!g.bluetooth.enabled) PCard { StatusLine(Status.ERROR, "Bluetooth is off. Turn it on to receive.") }
            ReceiveContent(phase, transport, amount, { transport = it; g.settings.transport = it }, { amount = it },
                onStart = { reuse ->
                    if (transport == PayQr.RFCOMM) discoverable.launch(g.bluetooth.discoverableIntent(180))
                    else vm.start(amount.toWeiOrNull(), transport, reuse)
                },
                onCancel = { vm.cancel(it) }, onDone = { nav.back() })
        }
    }
}

private fun String.toWeiOrNull(): BigInteger? = runCatching { Eth.wei(this) }.getOrNull()?.takeIf { it.signum() > 0 }

@Composable
fun ReceiveContent(
    phase: ReceivePhase, transport: String, amount: String,
    onTransport: (String) -> Unit, onAmount: (String) -> Unit,
    onStart: (reuse: Boolean) -> Unit, onCancel: (discard: Boolean) -> Unit, onDone: () -> Unit,
) {
    when (phase) {
        ReceivePhase.Idle -> PCard(title = "New receive code", subtitle = "A fresh one-time key is made in this phone's secure hardware for this payment only.") {
            Field(amount, onAmount, "Amount to request (optional, ETH)", mono = true, number = true)
            Secondary("Connection")
            Segmented(listOf(PayQr.L2CAP to "Nearby (BLE)", PayQr.RFCOMM to "Classic (fallback)"), transport, onTransport)
            Secondary(if (transport == PayQr.RFCOMM) "Classic Bluetooth: your phone becomes discoverable for 3 minutes and its Bluetooth name is put in the code."
                else "Your phone advertises only a random one-time code; no name, no address, no pairing.")
            PrimaryButton("Create receive code", { onStart(false) })
        }
        is ReceivePhase.Preparing -> PCard { StatusLine(Status.PENDING, phase.what, busy = true) }
        is ReceivePhase.Waiting -> PCard(title = "Show this to the payer") {
            QrImage(phase.link)
            StatusLine(Status.PENDING, "Waiting for the payer's phone…", busy = true)
            Secondary("Request ${phase.requestId} · one-time key ${Fmt.hex(phase.keyHash, 16)}")
            Secondary(if (phase.transport == PayQr.RFCOMM) "Classic Bluetooth, discoverable" else "Nearby: Bluetooth LE, random session id")
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                SecondaryButton("Stop", { onCancel(false) })
                SecondaryButton("Discard request", { onCancel(true) }, color = Tw.red400)
            }
        }
        is ReceivePhase.Verifying -> PCard { StatusLine(Status.PENDING, "Payer connected. Checking the payment…", busy = true) }
        is ReceivePhase.Done -> {
            PCard(border = (if (phase.accepted) Tw.emerald400 else Tw.red400).copy(alpha = 0.5f)) {
                StatusLine(if (phase.accepted) Status.OK else Status.ERROR, if (phase.accepted) "Payment accepted" else "Payment rejected")
                if (phase.valueWei != null) Amount(Fmt.eth(phase.valueWei))
                Secondary(if (phase.accepted) "Verified offline in ${phase.ms} ms. The note is now yours, spendable once with your new one-time key."
                    else "Nothing was added. Reasons: " + phase.fails.joinToString("; "))
            }
            PCard(title = "What was checked") { CheckList(phase.lines) }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                PrimaryButton("Done", onDone)
                if (!phase.accepted) SecondaryButton("Try again", { onStart(true) })
                else SecondaryButton("Payer didn't see it?", { onStart(true) })
            }
        }
        is ReceivePhase.Failed -> {
            PCard(border = Tw.red400.copy(alpha = 0.5f)) { StatusLine(Status.ERROR, phase.message) }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (phase.requestId != null) PrimaryButton("Try again", { onStart(true) })
                SecondaryButton("New code", { onCancel(true); onStart(false) })
            }
        }
    }
}

@Preview(widthDp = 400, heightDp = 1100, backgroundColor = 0xFF09090B, showBackground = true)
@Composable
fun ReceiveAcceptedPreview() = PrawlTheme {
    Page("Receive", {}) {
        ReceiveContent(SampleData.receiveDone, PayQr.L2CAP, "", {}, {}, {}, {}, {})
    }
}

@Preview(widthDp = 400, heightDp = 900, backgroundColor = 0xFF09090B, showBackground = true)
@Composable
fun ReceiveWaitingPreview() = PrawlTheme {
    Page("Receive", {}) { ReceiveContent(SampleData.receiveWaiting, PayQr.L2CAP, "", {}, {}, {}, {}, {}) }
}

