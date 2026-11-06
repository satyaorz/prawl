package xyz.prawl.offline

import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.RoborazziOptions
import com.github.takahirom.roborazzi.RoborazziTaskType
import com.github.takahirom.roborazzi.captureRoboImage
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import xyz.prawl.core.util.Js
import xyz.prawl.core.util.str
import xyz.prawl.offline.ui.components.HandoffActions
import xyz.prawl.offline.ui.components.PCard
import xyz.prawl.offline.ui.components.Page
import xyz.prawl.offline.ui.components.Secondary
import xyz.prawl.offline.ui.screens.BalanceContent
import xyz.prawl.offline.ui.screens.DeviceCheckContent
import xyz.prawl.offline.ui.screens.PayDoneContent
import xyz.prawl.offline.ui.screens.ReceiveContent
import xyz.prawl.offline.ui.screens.SampleData
import xyz.prawl.offline.ui.theme.PrawlTheme
import java.io.File

/**
 * Renders the screens on the JVM (Robolectric native graphics) and writes PNGs to docs/screenshots/.
 * Stateless screen contents use SampleData; the handoff QR codes use the REAL raw/v3/handoff_vectors links.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w400dp-h1500dp-xhdpi")
class ScreenshotTest {
    @get:Rule val rule = createComposeRule()

    private val out = File(System.getProperty("prawl.screenshots") ?: "build/screenshots").apply { mkdirs() }
    private val raw = File(System.getProperty("prawl.raw") ?: "../../..")

    private fun shot(name: String, content: @Composable () -> Unit) {
        rule.setContent { PrawlTheme { content() } }
        rule.onRoot().captureRoboImage(File(out, "$name.png").path, roborazziOptions = RoborazziOptions(taskType = RoborazziTaskType.Record))
    }

    @Test fun balance() = shot("1_balance") { BalanceContent(SampleData.balance) }

    @Test fun receiveWaiting() = shot("2_receive_code") {
        Page("Receive", {}) { ReceiveContent(SampleData.receiveWaiting, "l2cap", "", {}, {}, {}, {}, {}) }
    }

    @Test fun receiveAccepted() = shot("3_receive_accepted") {
        Page("Receive", {}) { ReceiveContent(SampleData.receiveDone, "l2cap", "", {}, {}, {}, {}, {}) }
    }

    @Test fun receiveIdle() = shot("2a_receive_new") {
        Page("Receive", {}) { ReceiveContent(xyz.prawl.offline.ui.screens.ReceivePhase.Idle, "l2cap", "0.1", {}, {}, {}, {}, {}) }
    }

    @Test fun payDone() = shot("4_pay_verdict") { Page("Pay", {}) { PayDoneContent(SampleData.payDone, {}) } }

    @Test fun load() {
        val v = Js.parse(File(raw, "v3/handoff_vectors/load_ho_deposited.json").readText())
        shot("5_load_code") {
            Page("Load", {}) {
                PCard(title = "Coin 0.005 ETH · awaiting deposit", subtitle = "coinId 597233fd156d3580… (real handoff vector)") {
                    HandoffActions(v.str("https"), v.str("prawl"), "https://<site>")
                }
            }
        }
    }

    @Test fun cashOut() {
        val v = Js.parse(File(raw, "v3/handoff_vectors/redeem_ho_0.003_unsubmitted.json").readText())
        shot("6_cashout_signed") {
            Page("Cash out", {}) {
                PCard(title = "Redemption signed · 0.003 ETH", subtitle = "Real phone redemption (redeem_ho_0.003_unsubmitted)") {
                    HandoffActions(v.str("https"), v.str("prawl"), "https://<site>", "redeem3_ho.json", "{}")
                    Secondary("Keep this until the payout arrives.")
                }
            }
        }
    }

    @Test fun deviceCheck() = shot("7_device_check") { Page("Device check", {}) { DeviceCheckContent(SampleData.device) } }

    /** Settings is stateful (reads the app's stores); rendered against an empty wallet. */
    @Test fun settings() = shot("8_settings") { App(Nav(mutableStateListOf(Route.Settings))) }

    @Test fun balanceLive() = shot("0_balance_empty_wallet") { App(Nav(mutableStateListOf(Route.Balance))) }
}
