package xyz.prawl.offline.ui.screens

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
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
import kotlinx.serialization.json.JsonObject
import xyz.prawl.core.android.BiometricApprover
import xyz.prawl.core.deposit.DepositCommitment
import xyz.prawl.core.protocol.RecipientPolicy
import xyz.prawl.core.transport.PayQr
import xyz.prawl.core.util.Eth
import xyz.prawl.core.util.Js
import xyz.prawl.offline.BuildConfig
import xyz.prawl.offline.Nav
import xyz.prawl.offline.PrawlApp
import xyz.prawl.offline.graph
import xyz.prawl.offline.ui.Fmt
import xyz.prawl.offline.ui.components.ConfirmDialog
import xyz.prawl.offline.ui.components.Field
import xyz.prawl.offline.ui.components.KeyValue
import xyz.prawl.offline.ui.components.PCard
import xyz.prawl.offline.ui.components.Page
import xyz.prawl.offline.ui.components.PrimaryButton
import xyz.prawl.offline.ui.components.Secondary
import xyz.prawl.offline.ui.components.SecondaryButton
import xyz.prawl.offline.ui.components.Segmented
import xyz.prawl.offline.ui.components.StatusLine
import xyz.prawl.offline.ui.theme.Status
import xyz.prawl.offline.ui.theme.Tw

/** Settings: each limit can only be tightened below the protocol's (RecipientPolicy refuses weaker values). */
@Composable
fun SettingsScreen(nav: Nav) {
    val ctx = LocalContext.current
    val g = ctx.graph
    val s = g.settings
    val scope = rememberCoroutineScope()
    val version by g.version.collectAsState()
    var cap by remember { mutableStateOf(Eth.eth(s.capWei)) }
    var hours by remember { mutableStateOf((s.minRemainingS / 3600).toString()) }
    var owner by remember { mutableStateOf(s.ownerApproval) }
    var transport by remember { mutableStateOf(s.transport) }
    var msg by remember { mutableStateOf<Pair<Status, String>?>(null) }
    var busy by remember { mutableStateOf(false) }
    var confirmRevocation by remember { mutableStateOf(false) }
    var pendingImport by remember { mutableStateOf<JsonObject?>(null) }
    val capWei = runCatching { Eth.wei(cap) }.getOrNull()?.takeIf { it.signum() > 0 && it <= RecipientPolicy.CAP_WEI }
    val h = hours.toLongOrNull()?.takeIf { it >= 1 }
    val canAuth = remember { BiometricApprover.available(ctx) }

    fun online(what: String, block: () -> String) {
        busy = true; msg = Status.PENDING to what
        scope.launch {
            val r = withContext(Dispatchers.IO) { runCatching(block) }
            busy = false
            msg = r.fold({ Status.OK to it }, { Status.ERROR to (it.message ?: it.toString()) })
            g.changed()
        }
    }

    val importer = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) runCatching { Js.parse(ctx.contentResolver.openInputStream(uri)!!.use { it.readBytes().toString(Charsets.UTF_8) }) }
            .onSuccess { pendingImport = it }.onFailure { msg = Status.ERROR to "Not a JSON file: ${it.message}" }
    }

    Page("Settings", nav::back) {
        msg?.let { (st, m) -> PCard { StatusLine(st, m, busy = busy) } }

        PCard(title = "Receiving limits", subtitle = "Can only be stricter than the protocol: at most 1 ETH per payment, at least 1 h of coin life left.") {
            Field(cap, { cap = it }, "Largest payment I accept (ETH, ≤ 1)", mono = true, number = true,
                error = if (capWei == null) "Between 0 and 1 ETH" else null)
            Field(hours, { hours = it }, "Minimum remaining coin lifetime (hours, ≥ 1)", mono = true, number = true,
                error = if (h == null) "At least 1 hour" else null)
            PrimaryButton("Save limits", {
                s.capWei = capWei!!; s.minRemainingS = h!! * 3600; g.changed(); msg = Status.OK to "Limits saved"
            }, enabled = capWei != null && h != null)
            Secondary("If the revocation list is older than 48 h, the limit drops to 0.05 ETH automatically.")
        }

        PCard(title = "Owner approval per spend") {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Require fingerprint / PIN for every payment", style = Tw.body, modifier = Modifier.weight(1f))
                Switch(owner && canAuth, { owner = it; s.ownerApproval = it }, enabled = canAuth,
                    colors = SwitchDefaults.colors(checkedTrackColor = Tw.emerald400, checkedThumbColor = Tw.zinc950))
            }
            Secondary(if (canAuth) "Applies to keys made from now on (new coins, receive keys, change). The secure hardware itself refuses to sign without you; recipients can see this in the attestation."
                else "Set up a screen lock or fingerprint to enable this.", color = if (canAuth) Tw.zinc500 else Tw.amber400)
        }

        PCard(title = "Bluetooth") {
            Segmented(listOf(PayQr.L2CAP to "Nearby (BLE)", PayQr.RFCOMM to "Classic"), transport) { transport = it; s.transport = it }
            Secondary("Nearby: the phone advertises only a random one-time id and accepts a BLE L2CAP connection; no name, no address, no pairing. " +
                "Classic: for phones where BLE fails; makes your phone discoverable for 3 minutes and puts its Bluetooth name in the code.")
        }

        val lcs = remember(version) { g.lightClient.status() }
        PCard(title = "Deposit proofs (light client)", subtitle = "Lets this phone check, offline, that a coin is backed by a finalized Sepolia deposit, trusting only Ethereum's sync committee.") {
            KeyValue("Committees", if (lcs.maxPeriod == null) "none (sync while online)" else "periods ${lcs.minPeriod}–${lcs.maxPeriod}", mono = true)
            lcs.validUntil?.let { KeyValue("Verifies proofs until", Fmt.date(it)) }
            KeyValue("Last sync", if (lcs.lastSync == 0L) "never" else Fmt.date(lcs.lastSync))
            KeyValue("BLS library", if (PrawlApp.nativeBls) "loaded" else "unavailable")
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                PrimaryButton("Sync committees", { online("Syncing the light client…") { g.lightClient.syncCommittees() } }, enabled = !busy)
                SecondaryButton("Refresh proofs of my coins", {
                    online("Building deposit proofs…") {
                        val coins = g.notes.notes().filter { !it.spent && !it.pendingDeposit }.map { it.header }.distinctBy { it.coinId }
                            .filter { (it.chainId to it.escrow) in xyz.prawl.core.protocol.Escrows.PRODUCT }
                        if (g.lightClient.cache() == null) g.lightClient.syncCommittees()
                        val ok = coins.count { hdr -> runCatching { g.lightClient.buildProof(hdr.escrow, hdr.coinId, DepositCommitment.commitment(hdr)).ok }.getOrDefault(false) }
                        "$ok of ${coins.size} coin(s) have a fresh deposit proof"
                    }
                }, enabled = !busy)
            }
            Secondary("Online only. Beacon data comes from ${BuildConfig.BEACON.substringAfter("//")} and is verified on the phone; " +
                "a first checkpoint must be confirmed by an independent node. Refreshing proofs asks ${BuildConfig.EL_RPC.substringAfter("//")} " +
                "for your coins' escrow slots, which reveals those coin ids and your IP to that provider; the wallet can do this over its private RPC instead.")
        }

        val anchors = remember(version) { g.trust.anchors() }
        val stale = g.recipientPolicy().isStale(System.currentTimeMillis() / 1000, anchors.revocationFetchedAt)
        PCard(title = "Attestation revocation list") {
            KeyValue("Fetched", Fmt.date(anchors.revocationFetchedAt))
            KeyValue("Entries", anchors.revokedSerials.size.toString(), mono = true)
            StatusLine(if (stale) Status.PENDING else Status.OK, if (stale) "Older than 48 h: receiving limited to 0.05 ETH" else "Fresh")
            SecondaryButton("Update now (online)", { confirmRevocation = true }, enabled = !busy)
        }

        PCard(title = "Synced deposit snapshots", subtitle = "Fallback for coins without a light-client proof. Trusted input: import only what your own wallet produced.") {
            val list = remember(version) { g.depositSources.summary() }
            if (list.isEmpty()) Secondary("None")
            list.forEach { Secondary(it) }
            SecondaryButton("Import snapshot file", { importer.launch(arrayOf("application/json", "text/plain", "*/*")) })
        }

        PCard(title = "About") {
            KeyValue("App", "${BuildConfig.APPLICATION_ID} ${BuildConfig.VERSION_NAME}", mono = true)
            KeyValue("Network", "Sepolia (${g.chainId})")
            KeyValue("Escrow v3.1 (new coins)", Fmt.addr(g.escrow40), mono = true)
            KeyValue("Escrow v3 (still accepted)", Fmt.addr(xyz.prawl.core.protocol.Escrows.SEPOLIA_V3), mono = true)
            KeyValue("Website", BuildConfig.HANDOFF_SITE, mono = true)
            if (BuildConfig.DEBUG) KeyValue("Harness", "${BuildConfig.APPLICATION_ID}/xyz.prawl.offline.harness.HarnessActivity", mono = true)
        }
    }

    if (confirmRevocation) ConfirmDialog("Update revocation list?",
        "Downloads Google's attestation status list from android.googleapis.com. This reveals your IP address to Google.",
        "Update", { online("Fetching the revocation list…") { "Revocation list updated: ${g.trust.fetchFromGoogle()} entries" } }, { confirmRevocation = false })
    pendingImport?.let { j ->
        ConfirmDialog("Import deposit snapshot?",
            "Recipients will accept coins this file lists as deposited. Import it only if it came from your own Prawl wallet.",
            "Import", { runCatching { g.depositSources.install(j) }.fold({ msg = Status.OK to "Imported $it" }, { msg = Status.ERROR to (it.message ?: "invalid snapshot") }); g.changed() },
            { pendingImport = null })
    }
}
