// UNTESTED SKETCH (no Android device on the research machine). API names verified against
// developer.android.com: KeyGenParameterSpec.Builder.setMaxUsageCount (API 31),
// setAttestationChallenge (API 24), setIsStrongBoxBacked (API 28),
// PackageManager.FEATURE_KEYSTORE_SINGLE_USE_KEY (API 31). Everything else is standard JCA.
package xyz.prawl.otk

import android.content.pm.PackageManager
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.cert.X509Certificate
import java.security.spec.ECGenParameterSpec

object PrawlOtk {
    /** True if this phone's secure hardware (not just keystore2) can enforce maxUsageCount == 1. */
    fun hardwareSingleUse(pm: PackageManager) =
        pm.hasSystemFeature(PackageManager.FEATURE_KEYSTORE_SINGLE_USE_KEY)

    /**
     * Create a one-time coin key. Returns the attestation chain (leaf first) that the payer
     * ships with every coin output addressed to this key; recipients run otk_verifier.py's policy.
     */
    fun newCoinKey(alias: String, challenge: ByteArray, strongBox: Boolean = false): List<X509Certificate> {
        val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1")) // P-256 -> EIP-7951 on-chain
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setMaxUsageCount(1)                 // the whole trick: one signature, ever
            .setAttestationChallenge(challenge)  // e.g. sha256("PRAWL.OTK.v1" || coinId || nonce)
            .setIsStrongBoxBacked(strongBox)
            .build()
        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").run {
            initialize(spec); generateKeyPair()
        }
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        return ks.getCertificateChain(alias).map { it as X509Certificate }
    }

    /** Spend: the key's single signature over the exact abi-encoded hop/redeem message bytes. */
    fun spendOnce(alias: String, abiEncodedMessage: ByteArray): ByteArray {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val sk = ks.getKey(alias, null) as java.security.PrivateKey
        return Signature.getInstance("SHA256withECDSA").run {
            initSign(sk); update(abiEncodedMessage); sign() // DER (r,s); contract wants raw r,s
        }
        // A second call throws KeyPermanentlyInvalidatedException (key exhausted and deleted).
    }
}
