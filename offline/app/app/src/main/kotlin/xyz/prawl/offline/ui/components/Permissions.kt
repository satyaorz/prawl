package xyz.prawl.offline.ui.components

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import xyz.prawl.offline.ui.theme.Status
import xyz.prawl.offline.ui.theme.Tw

/** Runtime permissions with the reason shown before the system dialog. */
object Perms {
    val BT_PAYEE_BLE = listOf(Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_ADVERTISE)
    val BT_PAYEE_CLASSIC = listOf(Manifest.permission.BLUETOOTH_CONNECT)
    val BT_PAYER = listOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
    val CAMERA = listOf(Manifest.permission.CAMERA)

    fun granted(ctx: Context, perms: List<String>) = perms.all { ContextCompat.checkSelfPermission(ctx, it) == PackageManager.PERMISSION_GRANTED }

    fun label(p: String) = when (p) {
        Manifest.permission.BLUETOOTH_CONNECT -> "Nearby devices: connect"
        Manifest.permission.BLUETOOTH_SCAN -> "Nearby devices: find"
        Manifest.permission.BLUETOOTH_ADVERTISE -> "Nearby devices: be found"
        Manifest.permission.CAMERA -> "Camera"
        else -> p.substringAfterLast('.')
    }
}

/**
 * Shows [content] when [perms] are granted; otherwise a rationale card explaining why, with a button that opens
 * the system dialog (or the app's settings page if the user chose "don't ask again").
 */
@Composable
fun PermissionGate(perms: List<String>, title: String, why: String, content: @Composable () -> Unit) {
    val ctx = LocalContext.current
    var tick by remember { mutableIntStateOf(0) }
    var asked by remember { mutableStateOf(false) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { tick++; asked = true }
    @Suppress("UNUSED_EXPRESSION") tick
    if (Perms.granted(ctx, perms)) { content(); return }
    val act = ctx as? Activity
    val permanentlyDenied = asked && act != null && perms.any { !Perms.granted(ctx, listOf(it)) && !act.shouldShowRequestPermissionRationale(it) }
    PCard(title = title) {
        Secondary(why)
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            perms.forEach { StatusLine(if (Perms.granted(ctx, listOf(it))) Status.OK else Status.PENDING, Perms.label(it)) }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (permanentlyDenied) {
                Secondary("Permission was denied. Allow it in the app's settings.", color = Tw.amber400)
                SecondaryButton("Open settings", {
                    ctx.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", ctx.packageName, null)))
                })
            } else PrimaryButton("Continue", { launcher.launch(perms.toTypedArray()) })
        }
    }
}
