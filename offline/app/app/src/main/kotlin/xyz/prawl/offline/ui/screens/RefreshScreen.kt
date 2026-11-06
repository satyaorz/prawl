package xyz.prawl.offline.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.RadioButton
import androidx.compose.material3.RadioButtonDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import xyz.prawl.core.android.BiometricApprover
import xyz.prawl.core.handoff.Handoff
import xyz.prawl.core.protocol.Escrows
import xyz.prawl.core.protocol.OfflineWallet
import xyz.prawl.core.protocol.PendingRefresh
import xyz.prawl.core.util.Eth
import xyz.prawl.offline.BuildConfig
import xyz.prawl.offline.LocalHostActivity
import xyz.prawl.offline.Nav
import xyz.prawl.offline.Route
import xyz.prawl.offline.graph
import xyz.prawl.offline.ui.Fmt
import xyz.prawl.offline.ui.components.ConfirmDialog
import xyz.prawl.offline.ui.components.Field
import xyz.prawl.offline.ui.components.HandoffActions
import xyz.prawl.offline.ui.components.KeyValue
import xyz.prawl.offline.ui.components.Mono
import xyz.prawl.offline.ui.components.PCard
import xyz.prawl.offline.ui.components.Page
import xyz.prawl.offline.ui.components.PrimaryButton
import xyz.prawl.offline.ui.components.Secondary
import xyz.prawl.offline.ui.components.SecondaryButton
import xyz.prawl.offline.ui.components.StatusLine
import xyz.prawl.offline.ui.theme.Status
import xyz.prawl.offline.ui.theme.Tw

/**
 * Refresh (escrow v3.1): signs a whole note into a PRAWL-REFRESH output; the website submits `refresh(...)` and the escrow
 * creates a NEW coin (new expiry, new genesis key made here, new reclaim address) without moving any ETH. The new coin
 * becomes spendable on this phone only after the user confirms the refresh landed, either by a light-client check or by hand.
 */
@Composable
fun RefreshScreen(nav: Nav, route: Route.Refresh) {
    val ctx = LocalContext.current
    val g = ctx.graph
    val activity = LocalHostActivity.current
    val scope = rememberCoroutineScope()
    val version by g.version.collectAsState()
    val now = System.currentTimeMillis() / 1000
    val notes = remember(version) {
        g.wallet().spendable().filter { Escrows.isV31(it.header.chainId, it.header.escrow) && it.header.expiry > now }.sortedBy { it.header.expiry }
    }
    val pendings = remember(version) { g.wallet().pendingRefreshes() }
    var pick by remember { mutableStateOf(route.alias ?: notes.firstOrNull()?.alias) }
    var days by remember { mutableStateOf("14") }
    var reclaim by remember { mutableStateOf(g.settings.lastDepositor?.let { Eth.checksum(it) } ?: "") }
    var shown by remember { mutableStateOf(route.pendingCoinId) }
    var busy by remember { mutableStateOf<String?>(null) }
    var msg by remember { mutableStateOf<Pair<Status, String>?>(null) }
    var confirmManual by remember { mutableStateOf<PendingRefresh?>(null) }
    var confirmSign by remember { mutableStateOf(false) }
    val addr = Eth.validateAddress(reclaim)
    val d = days.toIntOrNull()?.takeIf { it in 1..(OfflineWallet.REFRESH_MAX_S / 86400).toInt() }
    val current = pendings.firstOrNull { it.coinId == shown }

    Page("Refresh", nav::back) {
        msg?.let { (st, m) -> PCard { StatusLine(st, m, busy = false) } }
        busy?.let { PCard { StatusLine(Status.PENDING, it, busy = true) } }

        if (current != null) PendingCard(current, busy == null,
            onCheck = {
                busy = "Checking the new coin with a light-client proof…"; msg = null
                scope.launch {
                    val r = withContext(Dispatchers.IO) { runCatching { proveCoinOnChain(g, current.header) } }
                    busy = null
                    msg = r.fold({ res ->
                        if (res.ok) { runCatching { g.wallet().markRefreshed(current.coinId) }; shown = null; g.changed()
                            Status.OK to "Refresh confirmed at finalized block ${res.blockNumber}. The new coin is live and spendable." }
                        else explainProof(res, "The new coin")
                    }, { Status.ERROR to (it.message ?: it.toString()) })
                }
            },
            onManual = { confirmManual = current })

        if (current == null) {
            PCard(title = "Refresh a note", subtitle = "Moves the note's whole value into a new coin with a fresh expiry. No money moves; the wallet submits it online.") {
                if (notes.isEmpty()) Secondary("No refreshable notes. Only notes on escrow v3.1 can be refreshed; older v3 coins must be cashed out and loaded again.")
                notes.forEach { n ->
                    Row(Modifier.fillMaxWidth().clickable { pick = n.alias }.padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                        RadioButton(pick == n.alias, { pick = n.alias }, colors = RadioButtonDefaults.colors(selectedColor = Tw.emerald400, unselectedColor = Tw.zinc500))
                        Mono(Fmt.eth(n.value) + " ETH", Modifier.weight(1f))
                        Secondary("expires in ${Fmt.left(n.header.expiry - now)}", color = if (n.header.expiry - now < WARN_S) Tw.amber400 else Tw.zinc500)
                    }
                }
                Field(days, { days = it }, "New lifetime (days, 1–${OfflineWallet.REFRESH_MAX_S / 86400})", mono = true, number = true,
                    error = if (days.isNotBlank() && d == null) "1 to ${OfflineWallet.REFRESH_MAX_S / 86400} days (the escrow allows at most 30 from submission)" else null)
                Field(reclaim, { reclaim = it }, "Reclaim address for the new coin (0x…)", mono = true, error = if (reclaim.isNotBlank() && !addr.ok) addr.note else null)
                Secondary("The reclaim address gets back whatever is unspent after the new expiry. The wallet submitting the refresh cannot change it: it is part of what you sign. " +
                    "Submit within a day or so, while the new expiry is still inside the escrow's 30-day window.")
            }
            PrimaryButton("Review & sign refresh", { confirmSign = true }, enabled = pick != null && addr.ok && d != null && busy == null)
            if (confirmSign) ConfirmDialog("Refresh into a coin with this reclaim address?",
                "The note's whole value moves into a new coin that expires in ${d ?: 0} days. After that, whatever is unspent can only be reclaimed to this address. Compare every character.",
                "Approve with fingerprint / PIN", mono = addr.addr40?.let { Eth.checksum(it) }, onDismiss = { confirmSign = false }, onConfirm = {
                val alias = pick ?: return@ConfirmDialog
                val act = activity ?: return@ConfirmDialog
                busy = "Waiting for your approval…"; msg = null
                scope.launch {
                    val r = withContext(Dispatchers.IO) { runCatching { g.wallet().refresh(alias, d!! * 86400L, addr.addr40!!, BiometricApprover(act)) } }
                    busy = null
                    r.onSuccess { o ->
                        when (o) {
                            is OfflineWallet.RefreshOutcome.Signed -> { g.settings.lastDepositor = addr.addr40; shown = o.newCoinId; g.changed() }
                            is OfflineWallet.RefreshOutcome.Refused -> msg = Status.ERROR to o.reason
                        }
                    }.onFailure { msg = Status.ERROR to (it.message ?: it.toString()) }
                }
            })
        }

        val others = pendings.filter { it.coinId != shown }
        if (others.isNotEmpty()) PCard(title = "Other pending refreshes") {
            others.forEach { p ->
                Row(Modifier.fillMaxWidth().clickable { shown = p.coinId }.padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Mono(Fmt.eth(p.value) + " ETH", Modifier.weight(1f)); Secondary("new coin ${Fmt.hex(p.coinId, 10)}")
                }
            }
        }
    }

    confirmManual?.let { p ->
        ConfirmDialog("Mark as refreshed?", "Only after the wallet shows the refresh confirmed on-chain for ${Fmt.eth(p.value)} ETH. " +
            "Recipients check the new coin's deposit themselves; an unconfirmed coin is simply refused.",
            "Mark refreshed", { runCatching { g.wallet().markRefreshed(p.coinId) }; shown = null; g.changed(); msg = Status.OK to "New coin marked as live" },
            { confirmManual = null })
    }
}

/** The signed refresh: link/QR for the wallet, and how to confirm it. Stateless (previewable). */
@Composable
fun PendingCard(p: PendingRefresh, enabled: Boolean, onCheck: () -> Unit, onManual: () -> Unit) {
    val payload = Handoff.redeem(p.bundle, null)
    val d = Handoff.encode(payload)
    PCard(title = "Refresh signed · ${Fmt.eth(p.value)} ETH", subtitle = "New coin ${Fmt.hex(p.coinId, 16)} · expires ${Fmt.date(p.header.expiry)}") {
        HandoffActions(Handoff.httpsLink(BuildConfig.HANDOFF_SITE, "refresh", d), Handoff.prawlLink("refresh", d), BuildConfig.HANDOFF_SITE,
            "refresh3_${p.label}.json", p.bundle.toString())
        KeyValue("Reclaim address", Fmt.addr(p.header.depositor), mono = true)
        Secondary("Keep this until the refresh is confirmed: the old note's key is used up, this signed refresh is the money.", color = Tw.amber400)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            PrimaryButton("Check on-chain (online)", onCheck, enabled = enabled)
            SecondaryButton("Mark as refreshed", onManual, enabled = enabled)
        }
        Secondary("The new coin becomes spendable here only after it is confirmed. Deposits are provable about 15 minutes after the transaction.")
    }
}

