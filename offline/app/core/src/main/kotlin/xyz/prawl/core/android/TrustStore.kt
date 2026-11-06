package xyz.prawl.core.android

import android.content.Context
import xyz.prawl.core.attest.TrustAnchors
import xyz.prawl.core.util.Js
import xyz.prawl.core.util.obj
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * Pinned roots (asset `roots.pem`, never updated at runtime) and the revocation list: the bundled `revoked.txt`
 * (fetched 2026-11-05 11:37 UTC) until a newer list is imported or fetched into `files/trust/`.
 */
class TrustStore(private val context: Context) {
    private val dir = File(context.filesDir, "trust").apply { mkdirs() }
    private val listFile = File(dir, "revoked.txt")
    private val atFile = File(dir, "revoked_fetched_at")

    private fun asset(n: String) = context.assets.open(n).use { it.readBytes().toString(Charsets.UTF_8) }

    @Volatile private var cached: TrustAnchors? = null

    fun anchors(): TrustAnchors = cached ?: synchronized(this) {
        cached ?: load().also { cached = it }
    }

    private fun load(): TrustAnchors {
        val roots = TrustAnchors.parsePem(asset("roots.pem"))
        val bundled = TrustAnchors.parseRevoked(asset("revoked.txt"))
        val at = atFile.takeIf { it.exists() }?.readText()?.trim()?.toLongOrNull()
        return if (at != null && listFile.exists() && at > TrustAnchors.BUNDLED_REVOCATION_FETCHED) {
            // a newer list never drops serials the bundled list revoked
            TrustAnchors(roots, TrustAnchors.parseRevoked(listFile.readText()) + bundled, at)
        } else TrustAnchors(roots, bundled, TrustAnchors.BUNDLED_REVOCATION_FETCHED)
    }

    /** Installs a revocation list: Google's status JSON (`{"entries":{serial:{...}}}`) or one hex serial per line. */
    fun install(text: String, fetchedAt: Long) {
        val now = System.currentTimeMillis() / 1000
        require(fetchedAt <= now + 600) { "fetch time is in the future" }
        val serials = if (text.trimStart().startsWith("{")) Js.parse(text).obj("entries").keys.map { it.lowercase() }.toSet()
        else TrustAnchors.parseRevoked(text)
        require(serials.isNotEmpty()) { "empty revocation list" }
        File(dir, "revoked.txt.tmp").apply { writeText(serials.sorted().joinToString("\n") + "\n"); renameTo(listFile) }
        File(dir, "revoked_fetched_at.tmp").apply { writeText(fetchedAt.toString()); renameTo(atFile) }
        cached = null
    }

    /**
     * Fetches Google's attestation status list (user-initiated, online). Privacy: this contacts
     * android.googleapis.com directly, revealing this phone's IP address to Google; the wallet can instead pass the
     * list in (see [install]) over its private network path.
     */
    fun fetchFromGoogle(): Int {
        val c = URL(STATUS_URL).openConnection() as HttpURLConnection
        c.connectTimeout = 15_000; c.readTimeout = 30_000
        c.setRequestProperty("Cache-Control", "no-cache")
        try {
            if (c.responseCode != 200) throw IOException("HTTP ${c.responseCode}")
            val body = c.inputStream.use { it.readBytes().toString(Charsets.UTF_8) }
            val date = c.getHeaderFieldDate("Date", 0L) / 1000
            val at = if (date > 0) date else System.currentTimeMillis() / 1000
            install(body, at)
            return anchors().revokedSerials.size
        } finally { c.disconnect() }
    }

    companion object { const val STATUS_URL = "https://android.googleapis.com/attestation/status" }
}
