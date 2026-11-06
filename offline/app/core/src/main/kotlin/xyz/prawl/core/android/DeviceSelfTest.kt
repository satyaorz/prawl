package xyz.prawl.core.android

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import xyz.prawl.core.attest.AttestationResult
import xyz.prawl.core.attest.ChainChecker
import xyz.prawl.core.keys.ApprovalPrompt
import xyz.prawl.core.keys.KeySpec
import xyz.prawl.core.util.Bytes
import java.security.Signature

/**
 * The one-time-key self-test (the harness's MainActivity T1/T3, shortened): create a single-use key, read its
 * attestation through the SAME recipient policy, sign once, and confirm a second signature is refused.
 */
class DeviceSelfTest(private val context: Context, private val vault: AndroidKeyVault, private val checker: ChainChecker) {

    class Report(
        val device: String,
        val androidRelease: String,
        val sdk: Int,
        val strongBoxFeature: Boolean,
        val singleUseFeature: Boolean,
        val keygenMs: Long,
        val attestation: AttestationResult,
        val firstSignOk: Boolean,
        val firstSignVerified: Boolean,
        val secondSignRefused: Boolean,
        val secondSignMessage: String,
        val error: String?,
    ) {
        /** The phone can hold offline cash: its own key passes the policy and the second signature was refused. */
        val pass: Boolean get() = error == null && attestation.ok && firstSignOk && firstSignVerified && secondSignRefused
    }

    fun run(): Report {
        val pm = context.packageManager
        val alias = "selftest_${System.currentTimeMillis()}"
        var keygenMs = 0L
        var att = AttestationResult()
        var first = false; var verified = false; var refused = false; var msg2 = ""; var err: String? = null
        try {
            val t0 = System.nanoTime()
            val chain = vault.create(alias, KeySpec(singleUse = true, userAuthPerUse = false))
            keygenMs = (System.nanoTime() - t0) / 1_000_000
            att = checker.verify(chain)
            val m1 = "PRAWL-SELFTEST|1|${Bytes.hex(ByteArray(8).also { java.security.SecureRandom().nextBytes(it) })}".toByteArray()
            val prompt = ApprovalPrompt("Prawl self-test", "")
            val sig = runCatching { vault.sign(alias, m1, null, prompt) }.getOrNull()
            first = sig != null
            if (sig != null) {
                verified = Signature.getInstance("SHA256withECDSA").run {
                    initVerify(xyz.prawl.core.attest.TrustAnchors.parseCert(chain[0]).publicKey); update(m1); verify(sig)
                }
            }
            try {
                vault.sign(alias, "PRAWL-SELFTEST|2".toByteArray(), null, prompt)
                msg2 = "SIGNED A SECOND TIME"
            } catch (e: Exception) { refused = true; msg2 = e.message ?: e.toString() }
        } catch (e: Exception) {
            err = e.message ?: e.toString()
        } finally {
            vault.delete(alias)
        }
        return Report(
            device = "${Build.MANUFACTURER} ${Build.MODEL}", androidRelease = Build.VERSION.RELEASE, sdk = Build.VERSION.SDK_INT,
            strongBoxFeature = pm.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE),
            singleUseFeature = pm.hasSystemFeature(PackageManager.FEATURE_KEYSTORE_SINGLE_USE_KEY),
            keygenMs = keygenMs, attestation = att, firstSignOk = first, firstSignVerified = verified,
            secondSignRefused = refused, secondSignMessage = msg2, error = err,
        )
    }
}
