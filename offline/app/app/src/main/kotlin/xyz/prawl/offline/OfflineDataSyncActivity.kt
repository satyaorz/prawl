package xyz.prawl.offline

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import xyz.prawl.core.deposit.DepositCommitment
import xyz.prawl.core.deposit.LightClientDepositVerifier
import xyz.prawl.core.model.Bundle as CoinBundle
import xyz.prawl.core.util.Bytes
import xyz.prawl.core.util.Js
import xyz.prawl.core.util.obj
import xyz.prawl.core.util.str
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Data hand-over from the wallet shell (the TWA in the same APK, or an app signed with the same key: the
 * activity requires the signature-level permission `<applicationId>.permission.SYNC_OFFLINE_DATA`, so a web page or
 * another developer's app cannot call it). Action `xyz.prawl.offline.action.SYNC`, extras (all optional):
 *  - `deposits`: escrow commitments snapshot JSON (trusted input, see DepositSources);
 *  - `revoked` + `revokedFetchedAt` (unix s): attestation revocation list (Google status JSON or serials);
 *  - `depositProof`: a light-client DepositProof JSON for one of this phone's coins (built by the website). It is
 *    VERIFIED here against the coin header and the phone's committee cache before it is kept; a pending coin it
 *    proves is marked deposited.
 * Returns RESULT_OK with extra `result` (text), or RESULT_CANCELED with `error`.
 */
class OfflineDataSyncActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val g = graph
        val out = ArrayList<String>()
        try {
            intent.getStringExtra("deposits")?.let { out.add("deposits: " + g.depositSources.install(Js.parse(it))) }
            intent.getStringExtra("revoked")?.let {
                g.trust.install(it, intent.getLongExtra("revokedFetchedAt", System.currentTimeMillis() / 1000))
                out.add("revocation list: ${g.trust.anchors().revokedSerials.size} entries")
            }
            intent.getStringExtra("depositProof")?.let { proofText ->
                val proof = Js.parse(proofText)
                val key = proof.obj("storage").str("key").lowercase().removePrefix("0x")
                val note = g.notes.notes().firstOrNull { Bytes.hex(DepositCommitment.storageKey(it.header.coinId)) == key }
                    ?: throw IllegalArgumentException("the proof is not about any coin on this phone")
                val h = note.header
                val k0 = g.wallet().certs.leafKey(h.k0)
                val bundle = CoinBundle(buildJsonObject { put("header", h.json); put("path", JsonArray(emptyList())); put("depositProof", proof) })
                val c = LightClientDepositVerifier(g.lightClient.backend) { id, p -> g.lightClient.store.saveProof(id, p) }
                    .check(h, k0, null, bundle, System.currentTimeMillis() / 1000)
                require(c.backed) { "deposit proof rejected: ${c.detail}" }
                if (note.pendingDeposit) g.wallet().markDeposited(note.alias, "light-client proof from wallet")
                out.add("deposit proof for ${h.coinId.take(16)}…: ${c.detail}")
            }
            g.changed()
            setResult(RESULT_OK, Intent().putExtra("result", out.joinToString("\n").ifEmpty { "nothing to do" }))
        } catch (e: Exception) {
            setResult(RESULT_CANCELED, Intent().putExtra("error", e.message ?: e.toString()))
        }
        finish()
    }
}
