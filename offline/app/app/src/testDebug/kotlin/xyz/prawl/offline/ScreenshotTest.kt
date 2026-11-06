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
import xyz.prawl.core.handoff.Handoff
import xyz.prawl.core.protocol.Escrows
import xyz.prawl.core.util.Js
import xyz.prawl.core.util.obj
import xyz.prawl.core.util.with
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
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

    // ------------------------------------------------------------------ v3.1 screens (seeded wallet, real header/bundle data)

    private val ho = File(raw, "seam_a_uncopyable/android_test/relay3ho")
    private val kohaku = Js.parse(File(raw, "v3/escrow_v31/fixtures/railgun_shield_1e15.json").readText())

    /** Writes a genesis note (real k0/coin header from relay3ho/mint3_web1.json, re-pointed at v3.1) into the app's wallet dir. */
    private fun seed(alias: String, valueWei: String, daysLeft: Long, escrow: String = Escrows.SEPOLIA_V31, pending: Boolean = false, privateLoad: Boolean = false, tip: String? = null) {
        val ctx = androidx.test.core.app.ApplicationProvider.getApplicationContext<android.content.Context>()
        val dir = File(ctx.filesDir, "wallet").apply { mkdirs() }
        val m = Js.parse(File(ho, "mint3_web1.json").readText())
        val keep = listOf("v", "label", "coinId", "chainId", "k0", "k0x", "k0y")
        val h = JsonObject(LinkedHashMap<String, kotlinx.serialization.json.JsonElement>().also { o ->
            keep.forEach { k -> o[k] = m[k]!! }
            o["escrow"] = JsonPrimitive(escrow); o["expiry"] = JsonPrimitive(System.currentTimeMillis() / 1000 + daysLeft * 86400)
            o["value"] = JsonPrimitive(valueWei); o["depositor"] = JsonPrimitive("5aaeb6053f3e94c9b9a09f33669435e7ef1beaed")
        })
        val note = buildJsonObject {
            put("header", h); put("path", JsonArray(emptyList())); put("alias", alias); put("value", valueWei)
            put("noteId", "00".repeat(32))
            if (pending) put("pendingDeposit", true)
            if (privateLoad) { put("privateLoad", true); put("tipWei", tip ?: "0") }
        }
        File(dir, "note_$alias.json").writeText(note.toString())
    }

    private fun clearWallet() {
        val ctx = androidx.test.core.app.ApplicationProvider.getApplicationContext<android.content.Context>()
        File(ctx.filesDir, "wallet").deleteRecursively()
    }

    @Test fun cashOutPrivate() {
        clearWallet(); seed("n_k_g", "1000000000000000", 9)
        val target = buildJsonObject { put("v", 1); put("t", "shield-target"); put("chainId", 11155111); put("escrow", "0x" + Escrows.SEPOLIA_V31); put("request", kohaku["request"]!!) }
        val link = Handoff.prawlLink("shield-target", Handoff.encode(target))
        shot("9_cashout_private") { App(Nav(mutableStateListOf(Route.CashOut(shield = link)))) }
    }

    @Test fun cashOutPrivateValueMismatch() {
        clearWallet(); seed("n_k_g", "2000000000000000", 9)
        val target = buildJsonObject { put("v", 1); put("t", "shield-target"); put("chainId", 11155111); put("escrow", "0x" + Escrows.SEPOLIA_V31); put("request", kohaku["request"]!!) }
        shot("9a_cashout_private_mismatch") { App(Nav(mutableStateListOf(Route.CashOut(shield = Handoff.prawlLink("shield-target", Handoff.encode(target)))))) }
    }

    @Test fun refreshForm() {
        clearWallet(); seed("n_k_g", "50000000000000000", 2); seed("n_j_g", "200000000000000000", 12)
        shot("10_refresh_form") { App(Nav(mutableStateListOf(Route.Refresh(alias = "n_k_g")))) }
    }

    @Test fun refreshPending() {
        val m = Js.parse(File(ho, "mint3_web1.json").readText())
        val bundle = Js.parse(File(ho, "redeem3_ho_n_ho_c1793948361543.json").readText())
        val rd = bundle.obj("redeem")
        val exp = System.currentTimeMillis() / 1000 + 14 * 86400
        val newCoin = "52465348988d9cfd13fd12ff4f6ac905bb8032bf8aec0bb77c8b0cceeb0dece0"
        val refreshRd = rd.with("kind", "refresh").with("payout", "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed").with("refresh", buildJsonObject {
            put("expiry", exp); put("k0", m["k0"]!!); put("k0x", m.str("k0x")); put("k0y", m.str("k0y")); put("depositor", "5aaeb6053f3e94c9b9a09f33669435e7ef1beaed"); put("coinId", newCoin)
        })
        val nb = bundle.with("redeem", refreshRd)
        val hdr = buildJsonObject {
            put("v", 3); put("label", "kr"); put("coinId", newCoin); put("chainId", "11155111"); put("escrow", Escrows.SEPOLIA_V31); put("expiry", exp)
            put("value", "5000000000000000"); put("k0", m["k0"]!!); put("k0x", m.str("k0x")); put("k0y", m.str("k0y")); put("depositor", "5aaeb6053f3e94c9b9a09f33669435e7ef1beaed")
        }
        val p = xyz.prawl.core.protocol.PendingRefresh(buildJsonObject {
            put("coinId", newCoin); put("alias", "n_kr_g"); put("label", "kr"); put("value", "5000000000000000"); put("oldAlias", "n_k_g"); put("oldCoinId", "00".repeat(32))
            put("header", hdr); put("bundle", nb.toString()); put("at", "1793952000")
        })
        shot("11_refresh_pending") { Page("Refresh", {}) { xyz.prawl.offline.ui.screens.PendingCard(p, true, {}, {}) } }
    }

    @Test fun loadPrivate() {
        clearWallet(); seed("n_p_g", "5000000000000000", 14, pending = true, privateLoad = true, tip = "0")
        shot("12_load_private") { App(Nav(mutableStateListOf(Route.Load(coinId = "n_p_g")))) }
    }

    @Test fun balanceV31() {
        clearWallet(); seed("n_a_g", "700000000000000000", 12); seed("n_b_g", "50000000000000000", 2); seed("n_c_g", "10000000000000000", 20, escrow = Escrows.SEPOLIA_V3)
        shot("1a_balance_seeded") { App(Nav(mutableStateListOf(Route.Balance))) }
    }
}
