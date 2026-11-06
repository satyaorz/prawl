package xyz.prawl.core.android

import android.content.Context
import android.content.pm.PackageManager
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import xyz.prawl.core.keys.ApprovalPrompt
import xyz.prawl.core.keys.KeyRefusedException
import xyz.prawl.core.keys.KeySpec
import xyz.prawl.core.keys.KeyVault
import xyz.prawl.core.keys.SpendApprover
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.PublicKey
import java.security.SecureRandom
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/**
 * Hardware one-time keys in the AndroidKeyStore, exactly as `Wallet2Activity.newCoinKey` / `sign`:
 *  - EC P-256, purpose SIGN, SHA-256, random 32-byte attestation challenge;
 *  - `setMaxUsageCount(1)` (single use; the recipient checks it is HARDWARE-enforced in the attestation);
 *  - StrongBox when the phone has it (the Samsung TEE enforces the limit only in software, StrongBox in hardware);
 *  - optional per-use owner authentication: `setUserAuthenticationRequired(true)` with timeout 0 for
 *    BIOMETRIC_STRONG | DEVICE_CREDENTIAL, unlocked per signature by BiometricPrompt + CryptoObject.
 */
class AndroidKeyVault(context: Context) : KeyVault {
    override val strongBoxAvailable: Boolean =
        context.packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)

    private fun ks(): KeyStore = KeyStore.getInstance(KS).apply { load(null) }

    override fun create(alias: String, spec: KeySpec): List<ByteArray> {
        val ks = ks()
        if (ks.containsAlias(alias)) ks.deleteEntry(alias)
        val ch = ByteArray(32).also { SecureRandom().nextBytes(it) }
        val b = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setAttestationChallenge(ch)
        if (spec.singleUse) b.setMaxUsageCount(1)
        if (spec.userAuthPerUse) b.setUserAuthenticationRequired(true)
            .setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL)
        if (strongBoxAvailable) b.setIsStrongBoxBacked(true)
        val g = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, KS)
        g.initialize(b.build())
        g.generateKeyPair()
        return ks.getCertificateChain(alias).map { it.encoded }
    }

    override fun publicKey(alias: String): PublicKey? = runCatching { ks().getCertificate(alias)?.publicKey }.getOrNull()

    override fun requiresUserAuth(alias: String): Boolean = try {
        val k = ks().getKey(alias, null) as? PrivateKey ?: return false
        KeyFactory.getInstance(k.algorithm, KS).getKeySpec(k, KeyInfo::class.java).isUserAuthenticationRequired
    } catch (e: Exception) { false }

    /** Security level the key actually got (for the device check). */
    fun securityLevel(alias: String): Int? = try {
        val k = ks().getKey(alias, null) as PrivateKey
        KeyFactory.getInstance(k.algorithm, KS).getKeySpec(k, KeyInfo::class.java).securityLevel
    } catch (e: Exception) { null }

    override fun sign(alias: String, msg: ByteArray, approver: SpendApprover?, prompt: ApprovalPrompt): ByteArray {
        val k = try { ks().getKey(alias, null) as? PrivateKey } catch (e: Exception) { null }
            ?: throw KeyRefusedException("coin key no longer exists (already used once)")
        val needsAuth = requiresUserAuth(alias)
        try {
            var s = Signature.getInstance("SHA256withECDSA")
            s.initSign(k)
            if (needsAuth && approver != null) s = approver.authorize(s, prompt)
            // needsAuth with no approver: attempted silently, as malware would; the keystore refuses it
            s.update(msg)
            return s.sign()
        } catch (e: KeyRefusedException) {
            throw e
        } catch (t: Throwable) {
            throw KeyRefusedException(t.javaClass.simpleName + ": " + (t.message ?: "").lineSequence().first(), t)
        }
    }

    override fun delete(alias: String) { runCatching { ks().deleteEntry(alias) } }

    override fun aliases(): List<String> = runCatching { ks().aliases().toList() }.getOrDefault(emptyList())

    companion object { const val KS = "AndroidKeyStore" }
}
