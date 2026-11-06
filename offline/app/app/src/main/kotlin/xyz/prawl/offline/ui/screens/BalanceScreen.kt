package xyz.prawl.offline.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import xyz.prawl.core.protocol.RecipientPolicy
import xyz.prawl.offline.Nav
import xyz.prawl.offline.Route
import xyz.prawl.offline.graph
import xyz.prawl.offline.ui.Fmt
import xyz.prawl.offline.ui.NoteView
import xyz.prawl.offline.ui.RefreshView
import xyz.prawl.offline.ui.components.Amount
import xyz.prawl.offline.ui.components.Chip
import xyz.prawl.offline.ui.components.Mono
import xyz.prawl.offline.ui.components.PCard
import xyz.prawl.offline.ui.components.Page
import xyz.prawl.offline.ui.components.PrimaryButton
import xyz.prawl.offline.ui.components.Secondary
import xyz.prawl.offline.ui.components.SecondaryButton
import xyz.prawl.offline.ui.components.StatusLine
import xyz.prawl.offline.ui.theme.PrawlTheme
import xyz.prawl.offline.ui.theme.Status
import xyz.prawl.offline.ui.theme.Tw
import java.math.BigInteger

/** A note with less than this left gets the "refresh" warning. */
const val WARN_S = 3 * 86400L

data class BalanceState(
    val notes: List<NoteView>,
    val nowS: Long,
    val minRemainingS: Long,
    val maxHops: Int = RecipientPolicy.MAX_HOPS,
    val pendingRequests: Int = 0,
    val revocationStale: Boolean = false,
    val depositSources: Int = 0,
    val pendingRefreshes: List<RefreshView> = emptyList(),
) {
    val spendable get() = notes.filter { it.state == NoteView.State.SPENDABLE }
    val total: BigInteger get() = spendable.fold(BigInteger.ZERO) { a, n -> a + n.valueWei }
    /** Spendable notes with less than 3 days left: time to refresh (v3.1) or cash out (v3). */
    val expiringSoon get() = spendable.filter { it.expiry - nowS < WARN_S }
    val awaiting get() = notes.filter { it.state == NoteView.State.AWAITING_DEPOSIT }
    val confirming get() = notes.filter { it.state == NoteView.State.CONFIRMING }
}

@Composable
fun BalanceScreen(nav: Nav) {
    val ctx = LocalContext.current
    val g = ctx.graph
    val version by g.version.collectAsState()
    var now by remember { mutableLongStateOf(System.currentTimeMillis() / 1000) }
    LaunchedEffect(Unit) { while (true) { delay(30_000); now = System.currentTimeMillis() / 1000 } }
    val state = remember(version, now) {
        val anchors = g.trust.anchors()
        BalanceState(
            notes = g.notes.notes().map { NoteView.of(it, g.keys.requiresUserAuth(it.alias), g.depositProven(it.header.coinId)) },
            nowS = now, minRemainingS = g.settings.minRemainingS,
            pendingRequests = g.notes.pendingNames().size,
            revocationStale = g.recipientPolicy().isStale(now, anchors.revocationFetchedAt),
            depositSources = g.depositSources.files().size,
            pendingRefreshes = g.wallet().pendingRefreshes().map { RefreshView(it.coinId, it.value, it.header.expiry) },
        )
    }
    BalanceContent(state,
        onReceive = { nav.go(Route.Receive) }, onPay = { nav.go(Route.Pay()) }, onLoad = { nav.go(Route.Load()) },
        onCashOut = { nav.go(Route.CashOut()) }, onDevice = { nav.go(Route.Device) }, onSettings = { nav.go(Route.Settings) },
        onAwaiting = { nav.go(Route.Load(coinId = it)) },
        onRefresh = { nav.go(Route.Refresh(alias = it)) }, onPendingRefresh = { nav.go(Route.Refresh(pendingCoinId = it)) })
}

@Composable
fun BalanceContent(
    s: BalanceState,
    onReceive: () -> Unit = {}, onPay: () -> Unit = {}, onLoad: () -> Unit = {}, onCashOut: () -> Unit = {},
    onDevice: () -> Unit = {}, onSettings: () -> Unit = {}, onAwaiting: (String) -> Unit = {},
    onRefresh: (String) -> Unit = {}, onPendingRefresh: (String) -> Unit = {},
) {
    var showSpent by remember { mutableStateOf(false) }
    Page("Offline cash", null, actions = {
        Text("Device", style = Tw.secondary.copy(color = Tw.zinc400), modifier = Modifier.clickable(onClick = onDevice).padding(8.dp))
        Text("Settings", style = Tw.secondary.copy(color = Tw.zinc400), modifier = Modifier.clickable(onClick = onSettings).padding(8.dp))
    }) {
        PCard {
            Secondary("Spendable offline")
            Amount(Fmt.eth(s.total))
            Secondary("${s.spendable.size} note(s) · Sepolia · held by this phone's secure hardware")
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 4.dp)) {
                PrimaryButton("Pay", onPay, Modifier.weight(1f))
                SecondaryButton("Receive", onReceive, Modifier.weight(1f))
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                SecondaryButton("Load", onLoad, Modifier.weight(1f))
                SecondaryButton("Cash out", onCashOut, Modifier.weight(1f))
            }
        }

        if (s.expiringSoon.isNotEmpty()) PCard(border = Tw.amber400.copy(alpha = 0.5f)) {
            StatusLine(Status.PENDING, "Refresh before expiry")
            val below = s.expiringSoon.filter { it.expiry - s.nowS < s.minRemainingS }
            Secondary("${s.expiringSoon.size} note(s) have less than 3 days left. Recipients refuse notes with less than " +
                "${Fmt.left(s.minRemainingS)} left, and the escrow pays only before expiry." +
                if (below.isNotEmpty()) " ${below.size} can no longer be spent offline." else "")
            Secondary("Refresh moves a v3.1 note into a new coin with a fresh expiry (online, through the wallet). " +
                "Older v3 coins can only be cashed out and loaded again.")
            if (s.expiringSoon.any { !it.refreshable }) SecondaryButton("Cash out", onCashOut)
        }
        if (s.pendingRefreshes.isNotEmpty()) PCard(title = "Refreshing", subtitle = "Signed and handed to the wallet; confirm once it landed on-chain.") {
            s.pendingRefreshes.forEach { r ->
                Row(Modifier.fillMaxWidth().clickable { onPendingRefresh(r.coinId) }.padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Mono(Fmt.eth(r.valueWei) + " ETH", Modifier.weight(1f))
                    Secondary("new expiry " + Fmt.date(r.newExpiry))
                    Chip("pending", Status.PENDING)
                }
            }
        }
        if (s.revocationStale) PCard(border = Tw.amber400.copy(alpha = 0.5f)) {
            StatusLine(Status.PENDING, "Revocation list is older than 48 h")
            Secondary("You can only receive up to 0.05 ETH per payment until it is updated (Settings, online).")
        }
        if (s.depositSources == 0) PCard(border = Tw.amber400.copy(alpha = 0.5f)) {
            StatusLine(Status.PENDING, "No deposit data synced")
            Secondary("To receive, this phone must know the escrow's deposits. Sync from the wallet while online (Settings).")
        }
        if (s.awaiting.isNotEmpty()) PCard(title = "Awaiting deposit", subtitle = "Loaded here, not yet confirmed on-chain. Not spendable.") {
            s.awaiting.forEach { n ->
                Row(Modifier.fillMaxWidth().clickable { onAwaiting(n.alias) }.padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Mono(Fmt.eth(n.valueWei) + " ETH", Modifier.weight(1f))
                    Chip("pending", Status.PENDING)
                }
            }
        }

        if (s.confirming.isNotEmpty()) PCard(title = "Confirming deposit",
            subtitle = "Marked deposited; this phone is checking the chain (about 15 minutes after the transaction). Not spendable until proven.") {
            s.confirming.forEach { n ->
                Row(Modifier.fillMaxWidth().clickable { onAwaiting(n.alias) }.padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Mono(Fmt.eth(n.valueWei) + " ETH", Modifier.weight(1f))
                    Chip("checking", Status.PENDING)
                }
            }
        }

        PCard(title = "Notes") {
            if (s.spendable.isEmpty()) Secondary("No spendable notes. Load cash while online, or receive a payment.")
            s.spendable.sortedBy { it.expiry }.forEachIndexed { i, n ->
                if (i > 0) HorizontalDivider(color = Tw.zinc800)
                NoteRow(n, s, onRefresh)
            }
            val spent = s.notes.filter { it.state == NoteView.State.SPENT || it.state == NoteView.State.REDEEMED || it.state == NoteView.State.REFRESHED }
            if (spent.isNotEmpty()) {
                Text(if (showSpent) "Hide spent (${spent.size})" else "Show spent (${spent.size})",
                    style = Tw.secondary.copy(color = Tw.zinc400), modifier = Modifier.clickable { showSpent = !showSpent }.padding(vertical = 4.dp))
                if (showSpent) spent.forEach { n ->
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Mono(Fmt.eth(n.valueWei) + " ETH", Modifier.weight(1f), style = Tw.mono.copy(color = Tw.zinc500))
                        Chip(when (n.state) { NoteView.State.REDEEMED -> "cashed out"; NoteView.State.REFRESHED -> "refreshed"; else -> "spent" }, Status.NEUTRAL)
                    }
                }
            }
        }
        if (s.pendingRequests > 0) Secondary("${s.pendingRequests} receive request(s) waiting for a payer (kept for retry).")
    }
}

@Composable
private fun NoteRow(n: NoteView, s: BalanceState, onRefresh: (String) -> Unit) {
    val left = n.expiry - s.nowS
    Column(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Mono(Fmt.eth(n.valueWei) + " ETH", Modifier.weight(1f))
            when {
                left < s.minRemainingS -> Chip("cash out", Status.ERROR)
                left < WARN_S -> Chip("refresh", Status.PENDING)
                else -> Chip("ok", Status.OK)
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Secondary("expires in ${Fmt.left(left)}", color = if (left < WARN_S) Tw.amber400 else Tw.zinc500)
            Secondary("hop ${n.depth}/${s.maxHops}" + if (n.depth >= s.maxHops) " (cash out only)" else "")
            if (n.ownerApproval) Secondary("fingerprint")
            if (!n.refreshable) Secondary("v3")
        }
        if (n.refreshable && left > 0) SecondaryButton("Refresh", { onRefresh(n.alias) }, Modifier.padding(top = 4.dp))
    }
}

@Preview(widthDp = 400, heightDp = 1000, backgroundColor = 0xFF09090B, showBackground = true)
@Composable
fun BalancePreview() = PrawlTheme { BalanceContent(SampleData.balance) }
