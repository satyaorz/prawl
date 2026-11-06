package xyz.prawl.core.keys

import java.security.PublicKey
import java.security.Signature

/** How a coin key is created. */
data class KeySpec(
    /** `setMaxUsageCount(1)`. Only the debug harness's "multiuse" cheat test sets this to false. */
    val singleUse: Boolean = true,
    /** Owner approval (fingerprint/PIN) bound to the key in hardware, required for every signature. */
    val userAuthPerUse: Boolean = false,
)

/** Text for the owner-approval prompt. */
data class ApprovalPrompt(val title: String, val subtitle: String, val description: String? = null)

/**
 * Unlocks one signature that requires the owner. Android: BiometricPrompt with a CryptoObject wrapping [sig],
 * so the hardware authorises exactly this operation. Blocks until approved; throws if declined or timed out.
 */
fun interface SpendApprover {
    fun authorize(sig: Signature, prompt: ApprovalPrompt): Signature
}

/** The secure hardware refused to sign (key used up, deleted, not authorised, ...). */
class KeyRefusedException(msg: String, cause: Throwable? = null) : Exception(msg, cause)

/**
 * Hardware one-time keys. Android implementation: AndroidKeyStore, StrongBox if present else TEE,
 * `setMaxUsageCount(1)`, attestation challenge, optional per-use user authentication.
 */
interface KeyVault {
    val strongBoxAvailable: Boolean

    /** Creates a fresh key under [alias] (replacing any old one) and returns its attestation chain, leaf first. */
    fun create(alias: String, spec: KeySpec): List<ByteArray>
    fun publicKey(alias: String): PublicKey?
    fun exists(alias: String): Boolean = publicKey(alias) != null
    fun requiresUserAuth(alias: String): Boolean

    /**
     * Signs [msg] (SHA256withECDSA). If the key requires the owner, [approver] is asked; with a null approver the
     * signature is attempted silently, which the hardware refuses (the harness's "malware" test).
     */
    fun sign(alias: String, msg: ByteArray, approver: SpendApprover?, prompt: ApprovalPrompt): ByteArray
    fun delete(alias: String)
    fun aliases(): List<String>
}
