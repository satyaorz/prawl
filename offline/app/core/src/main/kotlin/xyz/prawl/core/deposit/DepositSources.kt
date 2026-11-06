package xyz.prawl.core.deposit

import kotlinx.serialization.json.JsonObject
import xyz.prawl.core.store.FileNoteStore
import xyz.prawl.core.util.Js
import xyz.prawl.core.util.arr
import xyz.prawl.core.util.objects
import xyz.prawl.core.util.optStr
import java.io.File

/**
 * Deposit data synced while online, kept in `files/deposits/`:
 *  - `commitments.json`: [CommitmentSnapshotDepositVerifier] format (escrow commitments; what the wallet syncs);
 *  - `snapshot_*.json`: the harness snapshot format.
 * Plus the light-client deposit proof carried in the bundle (checked first; see [LightClient]). The composite vouches for a coin if any source does.
 *
 * These files are TRUSTED inputs (like the harness's laptop snapshot): only the user's own wallet may write them.
 * The app accepts them through a signature-protected intent or an explicit user import, never from a web link.
 */
class DepositSources(
    private val dir: File,
    private val lightClient: DepositProofBackend? = null,
    private val onProofVerified: ((String, String) -> Unit)? = null,
    private val trustedEscrows: Set<Pair<String, String>> = xyz.prawl.core.protocol.Escrows.PRODUCT,
    /** Accept harness-format snapshots that bind neither escrow nor depositor (audit F-08). Debug builds only. */
    private val allowLegacySnapshots: Boolean = false,
) {
    init { dir.mkdirs() }

    fun verifier(): DepositVerifier {
        val list = ArrayList<DepositVerifier>()
        list.add(LightClientDepositVerifier(lightClient, trustedEscrows, onProofVerified))
        for (f in files()) {
            val j = runCatching { Js.parse(f.readText()) }.getOrNull() ?: continue
            runCatching { list.add(of(j, f.name, allowLegacySnapshots)) }
        }
        return CompositeDepositVerifier(list)
    }

    fun files(): List<File> = (dir.listFiles() ?: emptyArray()).filter { it.name.endsWith(".json") }.sortedBy { it.name }

    /** Validates and stores a snapshot. Commitment snapshots replace the previous one for the same escrow. */
    fun install(json: JsonObject): String {
        val v = of(json, "import", allowLegacySnapshots)
        if (v is SnapshotDepositVerifier && !allowLegacySnapshots) {
            val bad = json.arr("deposits").objects().count { it.optStr("chainId") == null || it.optStr("escrow") == null || it.optStr("depositor") == null }
            require(bad == 0) { "$bad snapshot entries lack chainId, escrow or depositor; such a snapshot cannot be trusted" }
        }
        val name = if (v is CommitmentSnapshotDepositVerifier) "commitments_${v.chainId}_${v.escrow40}.json"
        else "snapshot_${System.currentTimeMillis()}.json"
        FileNoteStore.atomicWrite(File(dir, name), json.toString())
        return name
    }

    fun summary(): List<String> = files().map { f ->
        val j = runCatching { Js.parse(f.readText()) }.getOrNull()
        when {
            j == null -> "${f.name}: unreadable"
            j.containsKey("commitments") -> "${f.name}: ${(j["commitments"] as? JsonObject)?.size ?: 0} deposits, synced " + (j.optStr("syncedAt") ?: "?")
            else -> "${f.name}: harness snapshot"
        }
    }

    companion object {
        fun of(j: JsonObject, name: String, allowLegacy: Boolean = false): DepositVerifier = when {
            j.containsKey("commitments") -> CommitmentSnapshotDepositVerifier(j, "escrow commitments ($name)")
            j.containsKey("deposits") -> SnapshotDepositVerifier(j, "synced snapshot", legacyUnbound = allowLegacy)
            else -> throw IllegalArgumentException("not a deposit snapshot")
        }
    }
}
