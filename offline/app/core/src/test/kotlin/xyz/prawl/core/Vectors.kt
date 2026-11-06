package xyz.prawl.core

import kotlinx.serialization.json.JsonObject
import xyz.prawl.core.attest.AppIdentity
import xyz.prawl.core.attest.AttestationPolicy
import xyz.prawl.core.attest.AttestationVerifier
import xyz.prawl.core.attest.TrustAnchors
import xyz.prawl.core.certs.MemoryCertStore
import xyz.prawl.core.util.Bytes
import xyz.prawl.core.util.Js
import xyz.prawl.core.util.optObj
import org.junit.AssumptionViolatedException
import java.io.File

/**
 * Read-only access to the REAL phone vectors (attestation chains and runs from our own phones) and to the public fixtures.
 *
 * The phone vectors identify devices, so they are NOT in the repo: point `prawl.raw` at a directory that has them (Gradle property
 * `-Pprawl.raw=...`, `PRAWL_RAW`, or `prawl.raw=` in local.properties). Without them every test that needs them is SKIPPED with a message,
 * never failed; the tests that need only public data (this repo's `assets/` and `src/test/resources`) always run.
 */
object Vectors {
    private val rawOrNull: File? = System.getProperty("prawl.raw")?.takeIf { it.isNotBlank() }?.let(::File)?.takeIf { it.isDirectory }

    /** The research tree's `raw/` (phone vectors), or the test is skipped. */
    val raw: File get() = rawOrNull ?: throw AssumptionViolatedException("phone vectors not available: set prawl.raw (see offline/app/README.md)")
    val assets = File(System.getProperty("prawl.assets") ?: error("prawl.assets not set"))

    /** A REAL RAILGUN ShieldRequest (throwaway keys), shipped in the repo. */
    val kohaku: JsonObject by lazy {
        val s = Vectors::class.java.getResourceAsStream("/railgun/shield_request_1e15.json") ?: error("missing test resource railgun_shield_1e15.json")
        Js.parse(s.readBytes().toString(Charsets.UTF_8))
    }

    /** raw/v3/phone_vectors: the v3 split run (Samsung StrongBox <-> OnePlus TEE), 2026-11-06 10:58. */
    val split: File get() = File(raw, "v3/phone_vectors")
    /** The real Sepolia end-to-end run, 11:57. */
    val e2e: File get() = File(raw, "seam_a_uncopyable/android_test/relay3e2e")
    /** The handoff run (coin 0x597233fd…), 12:29. */
    val ho: File get() = File(raw, "seam_a_uncopyable/android_test/relay3ho")
    val handoff: File get() = File(raw, "v3/handoff_vectors")

    /** A time after every vector was made and inside the OnePlus RKP certificates' validity (to 2026-11-17). */
    const val NOW_S = 1793952000L   // 2026-11-06T13:20:00Z

    fun json(f: File): JsonObject = Js.parse(f.readText())
    fun json(dir: File, name: String): JsonObject = json(File(dir, name))

    val anchors: TrustAnchors by lazy {
        TrustAnchors.fromText(File(assets, "roots.pem").readText(), File(assets, "revoked.txt").readText())
    }

    /** The harness's exact attestation policy: package xyz.prawl.otktest + the debug signing cert. */
    val harnessPolicy = AttestationPolicy(listOf(AppIdentity(AttestationPolicy.HARNESS_PACKAGE, AttestationPolicy.DEBUG_CERT_SHA256)))

    fun verifier(policy: AttestationPolicy = harnessPolicy, nowS: Long = NOW_S) = AttestationVerifier(anchors, policy) { nowS * 1000 }

    /**
     * A recipient phone's certificate cache: every certificate that appears in any vector file of [dirs]
     * (mint records, requests, bundles). The real phones held these after the runs.
     */
    fun certStore(vararg dirs: File): MemoryCertStore {
        val s = MemoryCertStore()
        for (d in dirs) for (f in d.listFiles()!!.filter { it.name.endsWith(".json") }) {
            val j = runCatching { json(f) }.getOrNull() ?: continue
            j.optObj("certs")?.forEach { (_, v) -> s.put(Bytes.unb64((v as kotlinx.serialization.json.JsonPrimitive).content)) }
        }
        return s
    }
}
