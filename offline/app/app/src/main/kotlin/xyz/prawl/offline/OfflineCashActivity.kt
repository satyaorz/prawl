package xyz.prawl.offline

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import android.app.Activity
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import xyz.prawl.core.android.BiometricApprover
import xyz.prawl.core.bridge.BridgeConfirm
import xyz.prawl.core.bridge.BridgeDispatcher
import xyz.prawl.core.bridge.BridgeHost
import xyz.prawl.core.bridge.SiteConfig
import xyz.prawl.core.keys.SpendApprover
import xyz.prawl.core.model.Note
import xyz.prawl.core.protocol.Escrows
import xyz.prawl.core.protocol.OfflineWallet
import xyz.prawl.offline.ui.WalletTab
import xyz.prawl.offline.ui.WalletWebView
import xyz.prawl.offline.ui.components.ConfirmDialog
import xyz.prawl.offline.ui.theme.Tw
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import xyz.prawl.offline.ui.screens.BalanceScreen
import xyz.prawl.offline.ui.screens.CashOutScreen
import xyz.prawl.offline.ui.screens.DeviceCheckScreen
import xyz.prawl.offline.ui.screens.LoadScreen
import xyz.prawl.offline.ui.screens.PayScreen
import xyz.prawl.offline.ui.screens.ReceiveScreen
import xyz.prawl.offline.ui.screens.RefreshScreen
import xyz.prawl.offline.ui.screens.SettingsScreen
import xyz.prawl.offline.ui.theme.PrawlTheme

/** Screens of the offline-cash part. */
sealed interface Route {
    data object Balance : Route
    data object Receive : Route
    /** [link]: a scanned/opened `prawl://offline/pay?d=…` receive code (pre-fills, never pays by itself). */
    data class Pay(val link: String? = null) : Route
    data class Load(val coinId: String? = null, val depositor: String? = null, val tx: String? = null) : Route
    /** [shield]: a `shield-target` link/JSON from the website (opens the private-balance cash-out with it pre-filled). */
    data class CashOut(val payout: String? = null, val shield: String? = null) : Route
    /** Refresh a v3.1 note ([alias]) or confirm a signed refresh ([pendingCoinId]). */
    data class Refresh(val alias: String? = null, val pendingCoinId: String? = null) : Route
    data object Device : Route
    data object Settings : Route
}

class Nav(private val stack: MutableList<Route>) {
    val current: Route get() = stack.last()
    val canGoBack: Boolean get() = stack.size > 1
    fun go(r: Route) { stack.add(r) }
    fun back() { if (stack.size > 1) stack.removeAt(stack.lastIndex) }
    fun home() { while (stack.size > 1) stack.removeAt(stack.lastIndex) }
    fun replaceTop(r: Route) { stack[stack.lastIndex] = r }
}

val LocalHostActivity = staticCompositionLocalOf<ComponentActivity?> { null }

/**
 * Entry point of the native offline-cash part. Works standalone (launcher) and as the native half next to a
 * Trusted Web Activity wallet shell, which can open it with:
 *  - an explicit intent, action `xyz.prawl.offline.action.OPEN`, extra `screen` =
 *    balance | receive | pay | load | cashout | device | settings | refresh;
 *  - a deep link `prawl://offline/<screen>` (the same names, plus `deposited`, `refreshed`, `redeem` and `shield-target`).
 *
 * **Links and intents ONLY navigate, and always to an EMPTY form** (audit F-03). The entry is exported and BROWSABLE, so any web page
 * or app can fire it; a payout address, shield target, depositor or receive code arriving that way would be the destination of the
 * user's money, chosen by someone else. Every parameter (`payout`, `depositor`, `d`, `coinId`, `tx`) is ignored. The user types, pastes
 * or scans the destination inside the app, and a shield target must answer the nonce of the `shield-ask` this phone showed.
 */
class OfflineCashActivity : ComponentActivity() {
    private val stack = mutableStateListOf<Route>(Route.Balance)
    /** 0 = Wallet (the website), 1 = Offline cash (native screens). */
    private var tab by mutableIntStateOf(1)
    private var pending by mutableStateOf<PendingConfirm?>(null)
    private var web: WalletWebView? = null
    private var siteProblem: String? = null

    /** A native confirmation the bridge is waiting on (the page asked to spend; only the user can approve). */
    class PendingConfirm(val c: BridgeConfirm, val result: CompletableFuture<Boolean>)

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val prefs = getSharedPreferences("prawl_settings", MODE_PRIVATE)
        // DEBUG builds only: `-e site http://localhost:4173` (through adb reverse) is remembered; an empty value clears it.
        if (BuildConfig.DEBUG) intent.getStringExtra("site")?.let { prefs.edit().putString("debugSite", it.ifBlank { null }).apply() }
        val g = graph
        val host = object : BridgeHost {
            override fun wallet(): OfflineWallet = g.wallet()
            override fun notes(): List<Note> = g.notes.notes()
            override val chainId = g.chainId
            override val publicEscrow40 = g.escrow40
            override val privateEscrow40 = Escrows.SEPOLIA_V31
            override fun approver(): SpendApprover? = BiometricApprover(this@OfflineCashActivity)
            override fun confirm(c: BridgeConfirm): Boolean {
                val f = CompletableFuture<Boolean>()
                runOnUiThread { pending = PendingConfirm(c, f) }
                return try { f.get(120, TimeUnit.SECONDS) } catch (e: Exception) { runOnUiThread { pending = null }; false }
            }
            override fun changed() = g.changed()
            override fun nowS() = System.currentTimeMillis() / 1000
        }
        val r = SiteConfig.resolve(BuildConfig.HANDOFF_SITE, BuildConfig.DEBUG, prefs.getString("debugSite", null))
        siteProblem = r.problem
        web = r.resolved?.let { WalletWebView(this, BridgeDispatcher(host), it, BuildConfig.DEBUG) { screen -> runOnUiThread { openNative(screen) } } }
        tab = if (web != null) 0 else 1
        routeFor(intent)?.let { if (it != Route.Balance) stack.add(it); tab = 1 }
        setContent {
            CompositionLocalProvider(LocalHostActivity provides this) {
                PrawlTheme {
                    Shell(tab, { tab = it }, web, siteProblem, Nav(stack), pending, this)
                    pending?.let { pc ->
                        ConfirmDialog(
                            title = pc.c.title, text = pc.c.text, confirm = "Approve with fingerprint / PIN",
                            mono = pc.c.mono, warning = pc.c.warning,
                            onConfirm = { pending = null; pc.result.complete(true) },
                            onDismiss = { pending = null; pc.result.complete(false) },
                        )
                    }
                }
            }
        }
    }

    /** A `prawl://offline/<screen>` link inside the wallet page: show that native screen, always an empty form. */
    private fun openNative(screen: String?) {
        val r = screen(screen)
        if (r == Route.Balance) Nav(stack).home() else stack.add(r)
        tab = 1
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        routeFor(intent)?.let { r -> if (r == Route.Balance) Nav(stack).home() else stack.add(r); tab = 1 }
    }

    override fun onDestroy() { web?.destroy(); super.onDestroy() }

    companion object {
        const val ACTION_OPEN = "xyz.prawl.offline.action.OPEN"

        fun routeFor(intent: Intent?): Route? {
            intent ?: return null
            if (intent.action == ACTION_OPEN) return screen(intent.getStringExtra("screen"))
            val uri: Uri = intent.data ?: return null
            if (uri.scheme != "prawl" || uri.host != "offline") return null
            return screen(uri.pathSegments.firstOrNull())
        }

        /** Screen by name, always with an empty form: no value from outside is ever carried into a route. */
        internal fun screen(name: String?): Route = when (name) {
            "receive" -> Route.Receive
            "pay" -> Route.Pay()
            "load", "deposited" -> Route.Load()
            "cashout", "redeem", "shield-target" -> Route.CashOut()
            "refresh", "refreshed" -> Route.Refresh()
            "device" -> Route.Device
            "settings" -> Route.Settings
            else -> Route.Balance
        }
    }
}

/** Bottom tabs: Wallet (the website) and Offline cash (native). */
@Composable
private fun Shell(tab: Int, onTab: (Int) -> Unit, web: WalletWebView?, problem: String?, nav: Nav, pending: OfflineCashActivity.PendingConfirm?, activity: Activity) {
    Column(Modifier.fillMaxSize().background(Tw.zinc900)) {
        Box(Modifier.weight(1f).then(if (tab == 0) Modifier.statusBarsPadding() else Modifier)) {
            if (tab == 0 || web != null) WalletTab(web, problem, visible = tab == 0, onOpenOffline = { onTab(1) }, activity = activity)
            if (tab == 1) App(nav)
        }
        Row(Modifier.fillMaxWidth().background(Tw.zinc900).navigationBarsPadding().height(56.dp), verticalAlignment = Alignment.CenterVertically) {
            TabItem("Wallet", tab == 0, Modifier.weight(1f)) { onTab(0) }
            TabItem("Offline cash", tab == 1, Modifier.weight(1f)) { onTab(1) }
        }
    }
}

@Composable
private fun TabItem(label: String, selected: Boolean, modifier: Modifier, onClick: () -> Unit) {
    Box(modifier.height(56.dp).clickable(onClick = onClick), contentAlignment = Alignment.Center) {
        Text(label, color = if (selected) Tw.emerald400 else Tw.zinc500, fontSize = 14.sp)
    }
}

@Composable
fun App(nav: Nav) {
    BackHandler(enabled = nav.canGoBack) { nav.back() }
    when (val r = nav.current) {
        Route.Balance -> BalanceScreen(nav)
        Route.Receive -> ReceiveScreen(nav)
        is Route.Pay -> PayScreen(nav, r.link)
        is Route.Load -> LoadScreen(nav, r)
        is Route.CashOut -> CashOutScreen(nav, r.payout, r.shield)
        is Route.Refresh -> RefreshScreen(nav, r)
        Route.Device -> DeviceCheckScreen(nav)
        Route.Settings -> SettingsScreen(nav)
    }
}
