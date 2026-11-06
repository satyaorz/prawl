package xyz.prawl.core.attest

import xyz.prawl.core.util.Bytes
import xyz.prawl.core.util.Der
import java.security.PublicKey
import java.security.cert.X509Certificate
import java.util.Date

/** An app allowed to create coin keys: package name + SHA-256 of its signing certificate (lowercase hex). */
data class AppIdentity(val packageName: String, val signingCertSha256: String)

/**
 * Attestation policy (hardening v2 of the harness). Nothing here may be relaxed below the harness values:
 * [minPatch] >= 202601 and a non-empty [allowedApps] list.
 */
data class AttestationPolicy(
    val allowedApps: List<AppIdentity>,
    /** Minimum osPatchLevel, YYYYMM. */
    val minPatch: Int = MIN_PATCH,
) {
    init {
        require(allowedApps.isNotEmpty()) { "at least one allowed app identity is required" }
        require(minPatch >= MIN_PATCH) { "minPatch may not be lowered below $MIN_PATCH" }
    }

    companion object {
        const val MIN_PATCH = 202601
        /** SHA-256 of the debug signing certificate shared by the harness and this app (`keystore/prawl-debug.keystore`). */
        const val DEBUG_CERT_SHA256 = "e6e0daae1031f70e5a267a383878ac564a935106f75600310feda6bf1ea92eaf"
        const val HARNESS_PACKAGE = "xyz.prawl.otktest"
        const val APP_PACKAGE = "xyz.prawl.offline"
    }
}

/** Verifies one attestation chain (leaf first). Implemented by [AttestationVerifier]; fakes in JVM tests. */
fun interface ChainChecker {
    fun verify(chainDer: List<ByteArray>): AttestationResult
}

/** One named check of the policy, kept for human-readable display. */
data class Check(val name: String, val ok: Boolean)

/**
 * Result of verifying one attestation chain. [fails] holds the names of failed checks
 * (identical wording to `OtkVerify` where the check is the same).
 */
class AttestationResult {
    val checks = ArrayList<Check>()
    val fails = ArrayList<String>()
    var ok = false
    var level = "?"
    var rkp = false
    var leafKey: PublicKey? = null
    var leafKeyHash: String? = null
    /** osPatchLevel YYYYMM from the hardware-enforced list (0 if absent). */
    var patch = 0
    val pkgs = ArrayList<String>()
    val appDigests = ArrayList<String>()
    /** userAuthType set with no timeout: every signature needs the owner (fingerprint/PIN). */
    var authPerUse = false
    /** usageCountLimit == 1 present in the hardware-enforced list. */
    var usageLimitInHardware = false
    var usageLimitInSoftware = false
    var bootloaderLocked = false
    var verifiedBoot = false
    var chainLength = 0

    fun summary(): String = (if (ok) "OK" else "FAIL") + " level=" + level + " rkp=" + rkp + " patch=" + patch +
        " app=" + pkgs + " authPerUse=" + authPerUse + (if (fails.isEmpty()) "" else " fails=$fails")
}

/**
 * Offline check that an Android Key Attestation chain proves a Prawl one-time coin key.
 * Kotlin port of the harness's `OtkVerify` (itself a port of otk_verifier.py), same checks, same order:
 *  - chain signatures verify up to a pinned Google attestation root
 *  - no certificate serial is on the cached revocation list; RKP certificates are inside their validity
 *  - leaf (and only the leaf) carries the KeyDescription extension (OID 1.3.6.1.4.1.11129.2.1.17)
 *  - attestation and KeyMint security level are TEE or StrongBox, and equal
 *  - usageCountLimit == 1 in the HARDWARE-enforced list and absent from the software list
 *  - origin GENERATED, purpose SIGN, EC P-256
 *  - rootOfTrust: bootloader locked, verified boot state Verified
 *  - RKP-provisioned chain, or a factory chain from StrongBox
 *  - osPatchLevel >= policy minimum; key created by an allowed app (package + signing cert digest)
 *
 * The only change from the harness: the clock used for the RKP validity check is injected ([nowMillis])
 * so the real phone chains can be verified on the JVM at the time they were made. On the phone it is the
 * system clock, as before.
 */
class AttestationVerifier(
    private val anchors: TrustAnchors,
    private val policy: AttestationPolicy,
    private val nowMillis: () -> Long = System::currentTimeMillis,
) : ChainChecker {
    override fun verify(chainDer: List<ByteArray>): AttestationResult {
        val r = AttestationResult()
        fun req(cond: Boolean, what: String) { r.checks.add(Check(what, cond)); if (!cond) r.fails.add(what) }
        try {
            val chain: List<X509Certificate> = chainDer.map { TrustAnchors.parseCert(it) }
            r.chainLength = chain.size
            if (chain.isEmpty()) { r.fails.add("empty chain"); return r }
            // 1. signatures up the chain
            for (i in 0 until chain.size - 1) {
                val ok = try { chain[i].verify(chain[i + 1].publicKey); true } catch (e: Exception) { false }
                req(ok, "cert $i signed by cert ${i + 1}")
            }
            val root = chain.last()
            req(anchors.rootSpkis.any { it.contentEquals(root.publicKey.encoded) }, "root is a pinned Google attestation root")
            // 2. revocation + RKP detection + validity (RKP certs must be in validity)
            for (c in chain) {
                val serial = c.serialNumber.toString(16)
                if (anchors.revokedSerials.contains(serial)) req(false, "serial $serial not revoked")
                if (c.getExtensionValue(OID_PROV_INFO) != null) r.rkp = true
            }
            if (r.rkp) for (i in 0 until chain.size - 1) {
                val ok = try { chain[i].checkValidity(Date(nowMillis())); true } catch (e: Exception) { false }
                req(ok, "RKP cert $i inside validity")
            }
            // 3. key description must be on the leaf
            val leaf = chain[0]
            for (i in 1 until chain.size) if (chain[i].getExtensionValue(OID_KEY_DESC) != null) req(false, "attestation extension only on leaf")
            val ext = leaf.getExtensionValue(OID_KEY_DESC)
            if (ext == null) { r.fails.add("no attestation extension"); return r }
            val outer = Der.parse(ext, 0)                        // OCTET STRING wrapper
            val kd = Der.parse(outer.value, 0).children()         // KeyDescription SEQUENCE
            val attLevel = kd[1].intVal().toInt()
            val kmLevel = kd[3].intVal().toInt()
            val sw = authList(kd[6])
            val hw = authList(kd[7])
            r.level = when (attLevel) { 2 -> "StrongBox"; 1 -> "TEE"; else -> "Software" }
            req(attLevel == 1 || attLevel == 2, "attestation from TEE/StrongBox")
            req(attLevel == kmLevel, "keymint level == attestation level")
            r.usageLimitInHardware = hw[405]?.inner()?.intVal()?.toInt() == 1
            r.usageLimitInSoftware = sw.containsKey(405)
            req(r.usageLimitInHardware, "usageCountLimit==1 hardware-enforced")
            req(!r.usageLimitInSoftware, "usageCountLimit not software-only")
            req(hw[702]?.inner()?.intVal()?.toInt() == 0, "origin GENERATED")
            val sign = hw[1]?.inner()?.children()?.any { it.intVal().toInt() == 2 } ?: false
            req(sign, "purpose SIGN")
            req(hw[2]?.inner()?.intVal()?.toInt() == 3 && hw[10]?.inner()?.intVal()?.toInt() == 1, "EC P-256")
            hw[704]?.let {
                val rot = it.inner().children()
                r.bootloaderLocked = rot[1].value.size == 1 && rot[1].value[0] != 0.toByte()
                r.verifiedBoot = rot[2].intVal().toInt() == 0
            }
            req(r.bootloaderLocked, "bootloader locked")
            req(r.verifiedBoot, "verified boot")
            req(r.rkp || attLevel == 2, "RKP chain, or factory StrongBox chain")
            // --- hardening v2 ---
            hw[706]?.let { r.patch = it.inner().intVal().toInt() }
            req(r.patch >= policy.minPatch, "security patch >= ${policy.minPatch}")
            sw[709]?.let { e ->
                val aid = Der.parse(e.inner().value, 0).children()   // AttestationApplicationId
                for (pi in aid[0].children()) r.pkgs.add(String(pi.children()[0].value, Charsets.UTF_8))
                for (d in aid[1].children()) r.appDigests.add(Bytes.hex(d.value))
            }
            req(policy.allowedApps.any { r.pkgs.contains(it.packageName) },
                "key created by app " + policy.allowedApps.joinToString("|") { it.packageName })
            req(policy.allowedApps.any { r.pkgs.contains(it.packageName) && r.appDigests.contains(it.signingCertSha256) },
                "app signing cert matches")
            r.authPerUse = hw.containsKey(504) && !hw.containsKey(505) && !hw.containsKey(503)
            r.leafKey = leaf.publicKey
            r.leafKeyHash = Bytes.sha256Hex(leaf.publicKey.encoded)
            r.ok = r.fails.isEmpty()
        } catch (e: Exception) {
            r.fails.add("parse error: $e")
            r.ok = false
        }
        return r
    }

    private fun authList(seq: Der): Map<Int, Der> = seq.children().associateBy { it.tag }

    companion object {
        const val OID_KEY_DESC = "1.3.6.1.4.1.11129.2.1.17"
        const val OID_PROV_INFO = "1.3.6.1.4.1.11129.2.1.30"
    }
}
