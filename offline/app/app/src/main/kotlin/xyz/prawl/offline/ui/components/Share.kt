package xyz.prawl.offline.ui.components

import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PersistableBundle
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import xyz.prawl.offline.ui.theme.Tw

object Share {
    fun copy(ctx: Context, label: String, text: String, sensitive: Boolean = false) {
        val cm = ctx.getSystemService(ClipboardManager::class.java)
        val clip = ClipData.newPlainText(label, text)
        if (sensitive) clip.description.extras = PersistableBundle().apply { putBoolean("android.content.extra.IS_SENSITIVE", true) }
        cm.setPrimaryClip(clip)
        Toast.makeText(ctx, "$label copied", Toast.LENGTH_SHORT).show()
    }

    fun open(ctx: Context, link: String) {
        try { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(link)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        catch (e: ActivityNotFoundException) { Toast.makeText(ctx, "No app can open this link", Toast.LENGTH_SHORT).show() }
    }

    fun siteConfigured(site: String) = !site.contains("<site>")
}

/**
 * A handoff payload for the website (HANDOFF.md): QR of the https link, plus copy/open, and optionally
 * "save file" for the full phone file (mint3 / redeem3 JSON).
 */
@Composable
fun HandoffActions(httpsLink: String, prawlLink: String, site: String, fileName: String? = null, fileJson: String? = null) {
    val ctx = LocalContext.current
    val save = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri ->
        if (uri != null && fileJson != null) runCatching {
            ctx.contentResolver.openOutputStream(uri)?.use { it.write(fileJson.toByteArray()) }
            Toast.makeText(ctx, "Saved", Toast.LENGTH_SHORT).show()
        }.onFailure { Toast.makeText(ctx, "Could not save: ${it.message}", Toast.LENGTH_LONG).show() }
    }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        QrImage(httpsLink)
        Mono(httpsLink, style = Tw.mono.copy(fontSize = 11.sp, color = Tw.zinc400), maxLines = 2)
        if (!Share.siteConfigured(site)) Secondary("The website address is not configured in this build (https://<site>); use Copy / the prawl:// link.", color = Tw.amber400)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            SecondaryButton("Copy link", { Share.copy(ctx, "Link", httpsLink) })
            if (Share.siteConfigured(site)) SecondaryButton("Open wallet", { Share.open(ctx, httpsLink) })
            SecondaryButton("Copy prawl:// link", { Share.copy(ctx, "Link", prawlLink) })
            if (fileName != null && fileJson != null) {
                SecondaryButton("Save file", { save.launch(fileName) })
                SecondaryButton("Copy file", { Share.copy(ctx, "File", fileJson) })
            }
        }
    }
}
