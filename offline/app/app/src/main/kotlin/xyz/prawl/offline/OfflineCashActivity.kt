package xyz.prawl.offline

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.staticCompositionLocalOf
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
 *    balance | receive | pay | load | cashout | device | settings (optional extras `depositor`, `payout`);
 *  - a deep link `prawl://offline/<screen>`, `prawl://offline/pay?d=…` (a receive code),
 *    `prawl://offline/load?depositor=0x…`, `prawl://offline/deposited?coinId=0x…&tx=0x…` (asks the user to confirm),
 *    `prawl://offline/shield-target?d=…` (website's RAILGUN shield target: opens private cash-out, signs nothing by itself),
 *    `prawl://offline/refreshed?coinId=0x…` (opens the pending refresh to confirm).
 * Links only navigate and pre-fill; nothing is signed or marked without the user acting on the screen.
 */
class OfflineCashActivity : ComponentActivity() {
    private val stack = mutableStateListOf<Route>(Route.Balance)

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        routeFor(intent)?.let { if (it != Route.Balance) stack.add(it) }
        setContent {
            CompositionLocalProvider(LocalHostActivity provides this) {
                PrawlTheme { App(Nav(stack)) }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        routeFor(intent)?.let { r -> if (r == Route.Balance) Nav(stack).home() else stack.add(r) }
    }

    companion object {
        const val ACTION_OPEN = "xyz.prawl.offline.action.OPEN"

        fun routeFor(intent: Intent?): Route? {
            intent ?: return null
            if (intent.action == ACTION_OPEN) return screen(intent.getStringExtra("screen"), intent.getStringExtra("depositor"), intent.getStringExtra("payout"))
            val uri: Uri = intent.data ?: return null
            if (uri.scheme != "prawl" || uri.host != "offline") return null
            val kind = uri.pathSegments.firstOrNull() ?: return Route.Balance
            return when (kind) {
                "pay" -> Route.Pay(uri.toString())
                "deposited" -> Route.Load(coinId = uri.getQueryParameter("coinId"), tx = uri.getQueryParameter("tx"))
                "shield-target" -> Route.CashOut(shield = uri.toString())
                "refreshed" -> Route.Refresh(pendingCoinId = uri.getQueryParameter("coinId"))
                else -> screen(kind, uri.getQueryParameter("depositor"), uri.getQueryParameter("payout"))
            }
        }

        private fun screen(name: String?, depositor: String?, payout: String?): Route = when (name) {
            "receive" -> Route.Receive
            "pay" -> Route.Pay()
            "load" -> Route.Load(depositor = depositor)
            "cashout", "redeem" -> Route.CashOut(payout)
            "device" -> Route.Device
            "settings" -> Route.Settings
            else -> Route.Balance
        }
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
