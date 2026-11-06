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
            if (intent.action == ACTION_OPEN) return screen(intent.getStringExtra("screen"))
            val uri: Uri = intent.data ?: return null
            if (uri.scheme != "prawl" || uri.host != "offline") return null
            return screen(uri.pathSegments.firstOrNull())
        }

        /** Screen by name, always with an empty form: no value from outside is ever carried into a route. */
        private fun screen(name: String?): Route = when (name) {
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
