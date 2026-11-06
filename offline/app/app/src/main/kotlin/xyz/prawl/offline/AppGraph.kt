package xyz.prawl.offline

import android.app.Application
import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import xyz.prawl.core.android.AndroidKeyVault
import xyz.prawl.core.android.BluetoothTransport
import xyz.prawl.core.android.TrustStore
import xyz.prawl.core.attest.AppIdentity
import xyz.prawl.core.attest.AttestationPolicy
import xyz.prawl.core.attest.AttestationVerifier
import xyz.prawl.core.certs.FileCertStore
import xyz.prawl.core.deposit.DepositSources
import xyz.prawl.core.deposit.DepositVerifier
import xyz.prawl.core.protocol.Escrows
import xyz.prawl.core.protocol.OfflineWallet
import xyz.prawl.core.protocol.RecipientPolicy
import xyz.prawl.core.store.FileNoteStore
import xyz.prawl.core.util.Eth
import xyz.prawl.core.deposit.CompositeDepositVerifier
import xyz.prawl.core.deposit.LightClient
import xyz.prawl.core.deposit.LightClientDepositVerifier
import xyz.prawl.core.deposit.LightClientEndpoints
import xyz.prawl.core.deposit.LightClientStore
import xyz.prawl.core.deposit.UrlHttp
import xyz.prawl.otktest.DepositProof
import java.io.File
import java.math.BigInteger

class PrawlApp : Application() {
    val graph by lazy { AppGraph(this) }

    override fun onCreate() {
        super.onCreate()
        // blst BLS (libprawlbls.so, arm64-v8a / x86_64) for light-client deposit proofs
        nativeBls = try { DepositProof.loadNative(null); true } catch (t: Throwable) { false }
    }

    companion object { @Volatile var nativeBls = false }
}

val Context.graph: AppGraph get() = (applicationContext as PrawlApp).graph

/** User settings. Each can only tighten the protocol's limits (enforced again by [RecipientPolicy]). */
class Settings(context: Context) {
    private val p = context.getSharedPreferences("prawl_settings", Context.MODE_PRIVATE)

    var capWei: BigInteger
        get() = p.getString("capWei", null)?.toBigIntegerOrNull()?.takeIf { it.signum() > 0 && it <= RecipientPolicy.CAP_WEI } ?: RecipientPolicy.CAP_WEI
        set(v) { p.edit().putString("capWei", v.min(RecipientPolicy.CAP_WEI).toString()).apply() }

    var minRemainingS: Long
        get() = p.getLong("minRemainingS", 6 * 3600L).coerceAtLeast(RecipientPolicy.MIN_REMAINING_S)
        set(v) { p.edit().putLong("minRemainingS", v.coerceAtLeast(RecipientPolicy.MIN_REMAINING_S)).apply() }

    /** New one-time keys require fingerprint/PIN for every signature (hardware-bound). Default on. */
    var ownerApproval: Boolean
        get() = p.getBoolean("ownerApproval", true)
        set(v) { p.edit().putBoolean("ownerApproval", v).apply() }

    /** "l2cap" (nearby, BLE) or "rfcomm" (classic, discoverable fallback). */
    var transport: String
        get() = p.getString("transport", "l2cap") ?: "l2cap"
        set(v) { p.edit().putString("transport", v).apply() }

    /**
     * Refresh Google's attestation revocation list in the background when it is over 12 h old and the phone is online. Default on: a list
     * older than 48 h silently drops the receiving limit to 0.05 ETH. Privacy cost: Google sees this phone's IP address.
     */
    var autoRevocation: Boolean
        get() = p.getBoolean("autoRevocation", true)
        set(v) { p.edit().putBoolean("autoRevocation", v).apply() }

    /** Last depositor address used for loading (convenience). */
    var lastDepositor: String?
        get() = p.getString("lastDepositor", null)
        set(v) { p.edit().putString("lastDepositor", v).apply() }
}

/**
 * Wiring for the screens and the debug harness. Both use the same files as the Java harness
 * (`files/wallet`, `files/certs`), so the compat flavor installed over the harness keeps its notes.
 */
class AppGraph(val app: Application) {
    val settings = Settings(app)
    val trust = TrustStore(app)
    val keys = AndroidKeyVault(app)
    val bluetooth = BluetoothTransport(app)
    val notes = FileNoteStore(File(app.filesDir, "wallet"))
    val certStore = FileCertStore(File(app.filesDir, "certs"))
    val lightClient = LightClient(
        LightClientStore(File(app.filesDir, "lightclient")), UrlHttp(),
        LightClientEndpoints(BuildConfig.BEACON, BuildConfig.BEACON_CHECKERS.split(',').map { it.trim() }.filter { it.isNotEmpty() },
            BuildConfig.EL_RPC, BuildConfig.EL_RPC2.ifEmpty { null }),
        nativeReady = { PrawlApp.nativeBls },
    )
    /** Light-client proof (carried in the bundle) first, then synced snapshots. Verified proofs are kept to forward. */
    val depositSources = DepositSources(File(app.filesDir, "deposits"), lightClient.backend, allowLegacySnapshots = BuildConfig.DEBUG,
        onProofVerified = { coinId, proof -> lightClient.store.saveProof(coinId, proof) })
    /** One lock for every wallet instance: two spends can never interleave. */
    val walletLock = Any()

    /** Escrow new coins are minted for (v3.1 by default); the product accepts and spends coins of [Escrows.PRODUCT]. */
    val escrow40: String = Eth.normalize40(BuildConfig.ESCROW)!!.also { require((BuildConfig.CHAIN_ID to it) in Escrows.PRODUCT) { "default escrow is not a known escrow" } }
    val chainId: String = BuildConfig.CHAIN_ID

    val attestationPolicy = run {
        // audit F-11: the public debug signing certificate (password "android") must never be trusted by a release build
        check(BuildConfig.DEBUG || !BuildConfig.ALLOWED_APPS.contains(AttestationPolicy.DEBUG_CERT_SHA256, ignoreCase = true)) {
            "release build trusts the public debug signing certificate"
        }
        AttestationPolicy(BuildConfig.ALLOWED_APPS.split(',').map {
            val (pkg, dig) = it.split(':'); AppIdentity(pkg.trim(), dig.trim().lowercase())
        })
    }

    fun checker() = AttestationVerifier(trust.anchors(), attestationPolicy)

    /** Product policy: settings + only the configured escrow. */
    fun recipientPolicy() = RecipientPolicy(
        capWei = settings.capWei, minRemainingS = settings.minRemainingS,
        acceptedEscrows = Escrows.PRODUCT,
    )

    @Volatile private var reconciled = false

    /** Once per process, before anything else touches the wallet: finish or clean up signatures a crash interrupted (audit F-06). */
    private fun reconcileOnce(w: OfflineWallet): OfflineWallet {
        if (!reconciled) synchronized(walletLock) { if (!reconciled) { reconciled = true; runCatching { w.reconcile() } } }
        return w
    }

    /** The wallet as the screens use it. */
    fun wallet(log: (String) -> Unit = {}): OfflineWallet = reconcileOnce(OfflineWallet(
        keys, notes, certStore, trust.anchors(), checker(), ::recipientPolicy, { depositSources.verifier() },
        ownerApprovalForNewKeys = { settings.ownerApproval }, log = log, lock = walletLock,
        depositProofFor = lightClient::proofFor, lcAdvertisement = lightClient::advertisement,
    ))

    /**
     * The wallet as the harness uses it: harness policy (any escrow), owner approval off, and deposits backed by a
     * carried light-client proof or else the given snapshot file (the harness's `snapshot` extra).
     */
    fun harnessWallet(snapshot: DepositVerifier?, log: (String) -> Unit, extraV31: Set<Pair<String, String>> = emptySet()): OfflineWallet = reconcileOnce(OfflineWallet(
        keys, notes, certStore, trust.anchors(), checker(), { RecipientPolicy() },
        { CompositeDepositVerifier(listOfNotNull(
            LightClientDepositVerifier(lightClient.backend) { id, p -> lightClient.store.saveProof(id, p) }, snapshot)) },
        ownerApprovalForNewKeys = { false }, log = log, lock = walletLock,
        depositProofFor = lightClient::proofFor, lcAdvertisement = lightClient::advertisement,
        v31Escrows = Escrows.V31 + extraV31,
    ))

    private val _version = MutableStateFlow(0)
    /** Bumped after anything changes the wallet; screens re-read on change. */
    val version: StateFlow<Int> = _version
    fun changed() { _version.value = _version.value + 1 }

    /**
     * The Wallet tab's public address (40 lowercase hex), told to us by the page after unlock. Memory only, never saved: a convenience
     * default for the Load form, not an authority. Cleared when the process ends.
     */
    @Volatile var walletHint40: String? = null
        private set
    fun setWalletHint(addr40: String) { if (walletHint40 != addr40) { walletHint40 = addr40; changed() } }
}
