package xyz.prawl.offline.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import xyz.prawl.core.handoff.Handoff
import xyz.prawl.core.protocol.Escrows
import xyz.prawl.core.util.str
import xyz.prawl.core.model.Note
import xyz.prawl.core.util.Bytes
import xyz.prawl.core.util.Eth
import xyz.prawl.offline.BuildConfig
import xyz.prawl.offline.Nav
import xyz.prawl.offline.Route
import xyz.prawl.offline.graph
import xyz.prawl.offline.ui.Fmt
import xyz.prawl.offline.ui.components.ConfirmDialog
import xyz.prawl.offline.ui.components.Field
import xyz.prawl.offline.ui.components.HandoffActions
import xyz.prawl.offline.ui.components.KeyValue
import xyz.prawl.offline.ui.components.PCard
import xyz.prawl.offline.ui.components.Page
import xyz.prawl.offline.ui.components.PermissionGate
import xyz.prawl.offline.ui.components.Perms
import xyz.prawl.offline.ui.components.PrimaryButton
import xyz.prawl.offline.ui.components.Segmented
import xyz.prawl.offline.ui.components.QrScanner
import xyz.prawl.offline.ui.components.Secondary
import xyz.prawl.offline.ui.components.SecondaryButton
import xyz.prawl.offline.ui.components.StatusLine
import xyz.prawl.offline.ui.theme.Status
import xyz.prawl.offline.ui.theme.Tw
import java.security.SecureRandom

/**
 * Load (online, handed to the wallet): the user gives the wallet's address (scan its EIP-681 QR
 * `ethereum:0x…@11155111` or paste), the phone mints a coin (fresh genesis one-time key + random coinId) and shows
 * the HANDOFF.md `load` link for the website to send `deposit(...)`. Then "mark as deposited": verified with a
 * light-client deposit proof when online, or confirmed manually by the user.
 */
@Composable
fun LoadScreen(nav: Nav, route: Route.Load) {
    val ctx = LocalContext.current
    val g = ctx.graph
    val scope = rememberCoroutineScope()
    val version by g.version.collectAsState()
    var depositor by remember { mutableStateOf(route.depositor ?: g.settings.lastDepositor?.let { Eth.checksum(it) } ?: "") }
    var amount by remember { mutableStateOf("") }
    var days by remember { mutableStateOf("14") }
    var scanning by remember { mutableStateOf(false) }
    var kind by remember { mutableStateOf("public") }          // public | private (RAILGUN, escrow v3.1 commit-then-fund)
    var escrowPick by remember { mutableStateOf("v31") }       // escrow for new public coins
    var busy by remember { mutableStateOf<String?>(null) }
    var message by remember { mutableStateOf<Pair<Status, String>?>(null) }
    var shown by remember { mutableStateOf(route.coinId) }
    var confirmManual by remember { mutableStateOf<Note?>(null) }
    var confirmDiscard by remember { mutableStateOf<Note?>(null) }

    val awaiting = remember(version) { g.notes.notes().filter { it.pendingDeposit && !it.spent } }
    fun matches(n: Note, key: String?) = key != null &&
        (n.alias == key || n.header.coinId.equals(key.removePrefix("0x"), ignoreCase = true))

    val addr = Eth.validateAddress(depositor)
    val priv = kind == "private"
    val newEscrow40 = if (priv || escrowPick == "v31") Escrows.SEPOLIA_V31 else Escrows.SEPOLIA_V3
    val wei = runCatching { Eth.wei(amount) }.getOrNull()?.takeIf { it.signum() > 0 }
    val d = days.toIntOrNull()?.takeIf { it in 1..29 }

    Page("Load", nav::back) {
        message?.let { (st, m) -> PCard { StatusLine(st, m) } }
        if (route.tx != null && awaiting.any { matches(it, route.coinId) })
            PCard(border = Tw.amber400.copy(alpha = 0.5f)) {
                StatusLine(Status.PENDING, "The wallet reports deposit tx ${Fmt.hex(route.tx, 12)}")
                Secondary("Check it on-chain below (online), or mark it as deposited yourself.")
            }

        awaiting.forEach { n ->
            val h = n.header
            PCard(title = "Coin ${Fmt.eth(n.value)} ETH · awaiting deposit", subtitle = "coinId ${Fmt.hex(h.coinId, 16)} · expires ${Fmt.date(h.expiry)}") {
                KeyValue("Depositor", Fmt.addr(h.depositor), mono = true)
                if (shown != null && matches(n, shown)) {
                    val payload = if (n.privateLoad) Handoff.loadPrivate(h, n.tipWei) else Handoff.load(h.json)
                    val k = if (n.privateLoad) "load-private" else "load"
                    val dd = Handoff.encode(payload)
                    HandoffActions(Handoff.httpsLink(BuildConfig.HANDOFF_SITE, k, dd), Handoff.prawlLink(k, dd), BuildConfig.HANDOFF_SITE)
                    if (n.privateLoad) {
                        KeyValue("Deposit address", payload.str("depositAddress"), mono = true)
                        Secondary("Open this in the Prawl wallet: it commits the coin, unshields exactly ${Fmt.eth(n.value + n.tipWei)} ETH from your private balance " +
                            "to the deposit address, then activates it. The reclaim address ${Fmt.addr(h.depositor)} can refund an unactivated deposit and reclaims unspent value after expiry. " +
                            "The unshield amount and time are public.")
                    } else Secondary("Open this in the Prawl wallet signed in as ${Fmt.addr(h.depositor)}; it sends deposit(...) with ${Fmt.eth(n.value)} ETH.")
                } else SecondaryButton("Show wallet code", { shown = n.alias })
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    PrimaryButton("Check deposit (online)", {
                        busy = "Checking the deposit with a light-client proof…"; message = null
                        scope.launch {
                            val r = withContext(Dispatchers.IO) { runCatching { checkDeposit(g, n) } }
                            busy = null
                            message = r.fold({ it }, { Status.ERROR to (it.message ?: it.toString()) })
                            g.changed()
                        }
                    }, enabled = busy == null)
                    SecondaryButton("Mark as deposited", { confirmManual = n }, enabled = busy == null)
                    SecondaryButton("Discard", { confirmDiscard = n }, color = Tw.red400, enabled = busy == null)
                }
            }
        }
        busy?.let { PCard { StatusLine(Status.PENDING, it, busy = true) } }

        PCard(title = "Load a new coin", subtitle = "Money moves on-chain from your wallet into the escrow; this phone holds the coin's one-time key.") {
            Segmented(listOf("public" to "Public deposit", "private" to "Private (RAILGUN)"), kind) { kind = it }
            Secondary(if (priv) "Funds come from your RAILGUN balance (an unshield to a one-time deposit address), so the deposit is not linked to a public wallet. Needs escrow v3.1."
                else "Your wallet sends a normal deposit transaction.")
            if (!priv) Segmented(listOf("v31" to "Escrow v3.1", "v3" to "Escrow v3"), escrowPick) { escrowPick = it }
            if (!priv && escrowPick == "v3") Secondary("v3 coins cannot be refreshed or cashed out into RAILGUN.", color = Tw.amber400)
            Field(depositor, { depositor = it }, if (priv) "Reclaim address (a fresh public address, 0x…)" else "Wallet address that will deposit (0x…)", mono = true,
                error = if (depositor.isNotBlank() && !addr.ok) addr.note else null)
            if (priv) Secondary("The reclaim address is only used to refund or reclaim; it does not fund the coin. A fresh address keeps the private link.")
            if (scanning) PermissionGate(Perms.CAMERA, "Camera needed to scan", "Scan the address code shown by the Prawl website (ethereum:0x…@11155111).") {
                QrScanner(onResult = { text ->
                    scanning = false
                    val e = Eth.parseEip681(text)
                    when {
                        e == null -> message = Status.ERROR to "Not an Ethereum address code"
                        e.chainId != null && e.chainId.toString() != g.chainId -> message = Status.ERROR to "That address code is for chain ${e.chainId}, not Sepolia"
                        else -> { depositor = Eth.checksum(e.addr40); message = null }
                    }
                })
            } else SecondaryButton("Scan wallet address", { scanning = true })
            Secondary(if (priv) "The reclaim address is part of the on-chain commitment." else "The depositor is part of the on-chain commitment: the deposit must come from exactly this account.")
            Field(amount, { amount = it }, "Amount (ETH)", mono = true, number = true,
                error = if (amount.isNotBlank() && wei == null) "Enter an amount in ETH" else null)
            if (wei != null && wei > xyz.prawl.core.protocol.RecipientPolicy.CAP_WEI)
                Secondary("Recipients accept at most 1 ETH per payment; a bigger coin can still be paid out in parts.", color = Tw.amber400)
            Field(days, { days = it }, "Lifetime (days, 1–29)", mono = true, number = true,
                error = if (days.isNotBlank() && d == null) "1 to 29 days (the escrow allows at most 30)" else null)
            Secondary("Unspent value must be cashed out before expiry; after expiry + 1 day the depositor can reclaim it." +
                if (g.settings.ownerApproval) " Spending will need your fingerprint or PIN." else "")
            PrimaryButton("Create coin", {
                val a40 = addr.addr40 ?: return@PrimaryButton
                busy = "Creating the coin's one-time key in secure hardware…"; message = null
                scope.launch {
                    val r = withContext(Dispatchers.IO) {
                        runCatching {
                            val label = Bytes.hex(ByteArray(3).also { SecureRandom().nextBytes(it) })
                            g.wallet().mint(label, wei!!, d!! * 86400L, g.chainId, newEscrow40, a40, pendingDeposit = true, privateLoad = priv)
                        }
                    }
                    busy = null
                    r.onSuccess { g.settings.lastDepositor = a40; shown = it.note.alias; amount = ""; g.changed() }
                        .onFailure { message = Status.ERROR to (it.message ?: it.toString()) }
                }
            }, enabled = addr.ok && wei != null && d != null && busy == null)
        }
    }

    confirmManual?.let { n ->
        ConfirmDialog("Mark as deposited?", "Only do this after the wallet shows the deposit transaction confirmed for ${Fmt.eth(n.value)} ETH " +
            "from ${Fmt.addr(n.header.depositor)}. Recipients check the deposit themselves; an unbacked coin is simply refused.",
            "Mark deposited", { runCatching { g.wallet().markDeposited(n.alias, route.tx) }; g.changed(); message = Status.OK to "Coin marked as deposited" },
            { confirmManual = null })
    }
    confirmDiscard?.let { n ->
        ConfirmDialog("Discard this coin?", "Only if the deposit was never sent. The one-time key is deleted; a deposit made later could then only be reclaimed by the depositor after expiry.",
            "Discard", { runCatching { g.wallet().discardUndeposited(n.alias) }; g.changed() }, { confirmDiscard = null })
    }
}

/** Online: light-client proof that deposits[coinId] equals this coin's commitment; marks the coin deposited if so. */
private fun checkDeposit(g: xyz.prawl.offline.AppGraph, n: Note): Pair<Status, String> {
    val r = proveCoinOnChain(g, n.header)
    if (r.ok) {
        g.wallet().markDeposited(n.alias, "light-client: block ${r.blockNumber}")
        return Status.OK to "Deposit proven at finalized block ${r.blockNumber}. The coin is live, and its proof travels with it."
    }
    return explainProof(r, "The deposit")
}
