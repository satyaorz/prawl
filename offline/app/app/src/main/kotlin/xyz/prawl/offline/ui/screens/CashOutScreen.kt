package xyz.prawl.offline.ui.screens

import androidx.compose.foundation.clickable
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
import xyz.prawl.core.model.Note
import xyz.prawl.core.protocol.OfflineWallet
import xyz.prawl.core.util.Eth
import xyz.prawl.core.util.Js
import xyz.prawl.offline.BuildConfig
import xyz.prawl.offline.LocalHostActivity
import xyz.prawl.offline.Nav
import xyz.prawl.offline.graph
import xyz.prawl.offline.ui.Fmt
import xyz.prawl.offline.ui.components.Field
import xyz.prawl.offline.ui.components.HandoffActions
import xyz.prawl.offline.ui.components.Mono
import xyz.prawl.offline.ui.components.PCard
import xyz.prawl.offline.ui.components.Page
import xyz.prawl.offline.ui.components.PermissionGate
import xyz.prawl.offline.ui.components.Perms
import xyz.prawl.offline.ui.components.PrimaryButton
import xyz.prawl.offline.ui.components.QrScanner
import xyz.prawl.offline.ui.components.Secondary
import xyz.prawl.offline.ui.components.SecondaryButton
import xyz.prawl.offline.ui.components.StatusLine
import xyz.prawl.offline.ui.theme.Status
import xyz.prawl.offline.ui.theme.Tw

/** A signed redemption ready for the website: HANDOFF.md `redeem` payload + the full phone file. */
private data class Signed(val alias: String, val valueWei: java.math.BigInteger, val payout: String, val https: String, val prawl: String, val fileName: String, val fileJson: String)

private fun signedOf(n: Note): Signed? {
    val bundle = n.json["redeemBundle"]?.let { (it as? kotlinx.serialization.json.JsonPrimitive)?.content } ?: return null
    val p = runCatching { Handoff.redeem(Js.parse(bundle), null) }.getOrNull() ?: return null
    val d = Handoff.encode(p)
    return Signed(n.alias, n.value, n.redeemedTo ?: "", Handoff.httpsLink(BuildConfig.HANDOFF_SITE, "redeem", d), Handoff.prawlLink("redeem", d),
        "redeem3_${n.label}_${n.alias}.json", bundle)
}

/**
 * Cash out: pick a note, give the payout address (or, later, a RAILGUN shield target), approve, and the phone signs a
 * redemption (the note's one-time key spends it to a PRAWL-REDEEM output for that address). The website submits the
 * exact redeem(Header, Spend[], Redemption) arguments from the link; anyone may send it, the payout is fixed by the
 * signature.
 */
@Composable
fun CashOutScreen(nav: Nav, payoutIn: String?) {
    val ctx = LocalContext.current
    val g = ctx.graph
    val activity = LocalHostActivity.current
    val scope = rememberCoroutineScope()
    val version by g.version.collectAsState()
    val now = System.currentTimeMillis() / 1000
    val notes = remember(version) { g.notes.notes().filter { !it.spent && !it.pendingDeposit && it.header.expiry > now }.sortedBy { it.header.expiry } }
    val signed = remember(version) { g.notes.notes().filter { it.redeemedTo != null }.mapNotNull { signedOf(it) }.reversed() }
    var pick by remember { mutableStateOf(notes.firstOrNull()?.alias) }
    var payout by remember { mutableStateOf(payoutIn ?: g.settings.lastDepositor?.let { Eth.checksum(it) } ?: "") }
    var scanning by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var showing by remember { mutableStateOf<String?>(null) }
    val addr = Eth.validateAddress(payout)

    Page("Cash out", nav::back) {
        val current = signed.firstOrNull { it.alias == showing }
        if (current != null) PCard(title = "Redemption signed · ${Fmt.eth(current.valueWei)} ETH", subtitle = "Pays ${current.payout}. Open in the wallet to submit it on-chain.") {
            HandoffActions(current.https, current.prawl, BuildConfig.HANDOFF_SITE, current.fileName, current.fileJson)
            Secondary("Keep this until the payout arrives: the note's key is used up, this signed redemption is the money.", color = Tw.amber400)
        }
        error?.let { PCard(border = Tw.red400.copy(alpha = 0.5f)) { StatusLine(Status.ERROR, it) } }

        PCard(title = "Note to cash out") {
            if (notes.isEmpty()) Secondary("No spendable notes.")
            notes.forEach { n ->
                Row(Modifier.fillMaxWidth().clickable { pick = n.alias }.padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                    RadioButton(pick == n.alias, { pick = n.alias }, colors = RadioButtonDefaults.colors(selectedColor = Tw.emerald400, unselectedColor = Tw.zinc500))
                    Mono(Fmt.eth(n.value) + " ETH", Modifier.weight(1f))
                    Secondary("expires in ${Fmt.left(n.header.expiry - now)} · hop ${n.depth}")
                }
            }
        }
        PCard(title = "Pay out to") {
            Field(payout, { payout = it }, "Payout address (0x…)", mono = true, error = if (payout.isNotBlank() && !addr.ok) addr.note else null)
            if (scanning) PermissionGate(Perms.CAMERA, "Camera needed to scan", "Scan the address code shown by the Prawl website.") {
                QrScanner(onResult = { t -> scanning = false; Eth.parseEip681(t)?.let { payout = Eth.checksum(it.addr40) } ?: run { error = "Not an Ethereum address code" } })
            } else SecondaryButton("Scan wallet address", { scanning = true })
            Secondary("Private payout into RAILGUN (shield target) arrives with escrow v3.1.")
        }
        PrimaryButton(if (busy) "Signing…" else "Approve & sign redemption", {
            val alias = pick ?: return@PrimaryButton
            val act = activity ?: return@PrimaryButton
            busy = true; error = null
            scope.launch {
                val r = withContext(Dispatchers.IO) { runCatching { g.wallet().redeem(alias, addr.addr40!!, BiometricApprover(act)) } }
                busy = false
                r.onSuccess { o ->
                    when (o) {
                        is OfflineWallet.RedeemOutcome.Signed -> { g.changed(); showing = alias }
                        is OfflineWallet.RedeemOutcome.Refused -> error = o.reason
                    }
                }.onFailure { error = it.message ?: it.toString() }
            }
        }, enabled = pick != null && addr.ok && !busy)

        if (signed.isNotEmpty()) PCard(title = "Signed redemptions") {
            signed.forEach { s ->
                Row(Modifier.fillMaxWidth().clickable { showing = s.alias }.padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Mono(Fmt.eth(s.valueWei) + " ETH", Modifier.weight(1f))
                    Secondary("→ " + Fmt.addr(s.payout.removePrefix("0x")))
                }
            }
        }
    }
}

