package xyz.prawl.offline.ui.screens

import android.content.pm.PackageManager
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.tooling.preview.Preview
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import xyz.prawl.core.android.DeviceSelfTest
import xyz.prawl.core.protocol.VerifyLine
import xyz.prawl.offline.Nav
import xyz.prawl.offline.PrawlApp
import xyz.prawl.offline.graph
import xyz.prawl.offline.ui.components.CheckList
import xyz.prawl.offline.ui.components.KeyValue
import xyz.prawl.offline.ui.components.PCard
import xyz.prawl.offline.ui.components.Page
import xyz.prawl.offline.ui.components.PrimaryButton
import xyz.prawl.offline.ui.components.Secondary
import xyz.prawl.offline.ui.components.StatusLine
import xyz.prawl.offline.ui.theme.PrawlTheme
import xyz.prawl.offline.ui.theme.Status
import xyz.prawl.offline.ui.theme.Tw

/** Display model of the self-test (pure data for previews). */
data class DeviceCheckView(
    val device: String, val android: String, val strongBox: Boolean, val singleUseFeature: Boolean,
    val level: String, val hardwareLimit: Boolean, val rkp: Boolean, val patch: Int, val bootLocked: Boolean, val verifiedBoot: Boolean,
    val policyOk: Boolean, val policyFails: List<String>, val firstSign: Boolean, val secondRefused: Boolean, val secondMsg: String,
    val keygenMs: Long, val pass: Boolean, val error: String?, val bls: Boolean,
) {
    val lines: List<VerifyLine> get() = listOf(
        VerifyLine("", "Key created in secure hardware", error == null, "$level, $keygenMs ms"),
        VerifyLine("", "Single use enforced in hardware", hardwareLimit, if (hardwareLimit) "usageCountLimit=1 in the hardware-enforced list" else "the attestation shows the limit only in software"),
        VerifyLine("", "Passes the recipients' attestation policy", policyOk, if (policyOk) (if (rkp) "RKP chain" else "factory StrongBox chain") + ", Google root" else policyFails.joinToString("; ")),
        VerifyLine("", "Bootloader locked, verified boot", bootLocked && verifiedBoot, "rootOfTrust from the attestation"),
        VerifyLine("", "Security patch ≥ 2026-01", patch >= 202601, "osPatchLevel $patch"),
        VerifyLine("", "First signature", firstSign, "signed and verified"),
        VerifyLine("", "Second signature refused", secondRefused, secondMsg.take(120)),
    )

    companion object {
        fun of(r: DeviceSelfTest.Report) = DeviceCheckView(
            r.device, "Android ${r.androidRelease} (SDK ${r.sdk})", r.strongBoxFeature, r.singleUseFeature,
            r.attestation.level, r.attestation.usageLimitInHardware, r.attestation.rkp, r.attestation.patch,
            r.attestation.bootloaderLocked, r.attestation.verifiedBoot, r.attestation.ok, r.attestation.fails,
            r.firstSignOk && r.firstSignVerified, r.secondSignRefused, r.secondSignMessage, r.keygenMs, r.pass, r.error, PrawlApp.nativeBls,
        )
    }
}

/** Runs the one-time-key self-test and reads the phone's OWN attestation through the same recipient policy. */
@Composable
fun DeviceCheckScreen(nav: Nav) {
    val ctx = LocalContext.current
    val g = ctx.graph
    val scope = rememberCoroutineScope()
    var view by remember { mutableStateOf<DeviceCheckView?>(null) }
    var running by remember { mutableStateOf(false) }
    Page("Device check", nav::back) {
        PCard(title = "This phone") {
            KeyValue("StrongBox", if (g.keys.strongBoxAvailable) "available (used for coin keys)" else "not available (TEE keys)")
            KeyValue("single_use_key feature", if (ctx.packageManager.hasSystemFeature(PackageManager.FEATURE_KEYSTORE_SINGLE_USE_KEY)) "yes" else "no")
            KeyValue("Light-client BLS library", if (PrawlApp.nativeBls) "loaded" else "unavailable", valueColor = if (PrawlApp.nativeBls) Tw.zinc100 else Tw.amber400)
            Secondary("The self-test creates a single-use key, checks its attestation exactly as a recipient would, signs once, and confirms a second signature is refused. The test key is then deleted.")
            PrimaryButton(if (running) "Running…" else "Run self-test", {
                running = true
                scope.launch {
                    val r = withContext(Dispatchers.IO) { DeviceSelfTest(ctx.applicationContext, g.keys, g.checker()).run() }
                    view = DeviceCheckView.of(r); running = false
                }
            }, enabled = !running)
        }
        view?.let { DeviceCheckContent(it) }
    }
}

@Composable
fun DeviceCheckContent(v: DeviceCheckView) {
    PCard(border = (if (v.pass) Tw.emerald400 else Tw.red400).copy(alpha = 0.5f)) {
        StatusLine(if (v.pass) Status.OK else Status.ERROR, if (v.pass) "This phone can hold offline cash" else "This phone cannot hold offline cash safely")
        Secondary("${v.device} · ${v.android}")
        v.error?.let { Secondary(it, color = Tw.red400) }
    }
    PCard(title = "Results") {
        KeyValue("Security level", v.level)
        KeyValue("Limit enforced by", if (v.hardwareLimit) "hardware" else "software only", valueColor = if (v.hardwareLimit) Tw.emerald400 else Tw.red400)
        KeyValue("Patch level", v.patch.toString().let { if (it.length == 6) it.substring(0, 4) + "-" + it.substring(4) else it }, mono = true)
        KeyValue("StrongBox", if (v.strongBox) "yes" else "no")
        CheckList(v.lines)
    }
}

@Preview(widthDp = 400, heightDp = 1000, backgroundColor = 0xFF09090B, showBackground = true)
@Composable
fun DeviceCheckPreview() = PrawlTheme { Page("Device check", {}) { DeviceCheckContent(SampleData.device) } }
