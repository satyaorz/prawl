package xyz.prawl.core.android

import android.app.Activity
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricPrompt
import android.os.CancellationSignal
import android.os.Handler
import android.os.Looper
import xyz.prawl.core.keys.ApprovalPrompt
import xyz.prawl.core.keys.KeyRefusedException
import xyz.prawl.core.keys.SpendApprover
import java.security.Signature
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * Owner approval per spend: BiometricPrompt with a CryptoObject wrapping the initialised Signature, so the
 * keystore authorises exactly this one signing operation (fingerprint, face class 3, or device PIN/pattern).
 * Same flow as `Wallet2Activity.sign`. Must be called off the main thread; blocks until the owner answers.
 */
class BiometricApprover(private val activity: Activity, private val timeoutS: Long = 90) : SpendApprover {
    override fun authorize(sig: Signature, prompt: ApprovalPrompt): Signature {
        check(Looper.myLooper() != Looper.getMainLooper()) { "BiometricApprover must not block the main thread" }
        val done = CountDownLatch(1)
        val res = AtomicReference<Any>()
        val cancel = CancellationSignal()
        Handler(Looper.getMainLooper()).post {
            try {
                val b = BiometricPrompt.Builder(activity)
                    .setTitle(prompt.title)
                    .setSubtitle(prompt.subtitle)
                    .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL)
                prompt.description?.let { b.setDescription(it) }
                b.build().authenticate(BiometricPrompt.CryptoObject(sig), cancel, activity.mainExecutor,
                    object : BiometricPrompt.AuthenticationCallback() {
                        override fun onAuthenticationSucceeded(r: BiometricPrompt.AuthenticationResult) {
                            res.set(r.cryptoObject?.signature ?: KeyRefusedException("no signature returned")); done.countDown()
                        }
                        override fun onAuthenticationError(code: Int, msg: CharSequence) {
                            res.set(KeyRefusedException("owner approval error $code: $msg")); done.countDown()
                        }
                    })
            } catch (t: Throwable) { res.set(t); done.countDown() }
        }
        if (!done.await(timeoutS, TimeUnit.SECONDS)) { cancel.cancel(); throw KeyRefusedException("no owner approval within $timeoutS s") }
        val o = res.get()
        if (o is Throwable) throw (o as? KeyRefusedException ?: KeyRefusedException(o.toString(), o))
        return o as Signature
    }

    companion object {
        /** True if the phone has a secure lock screen or a strong biometric (needed for owner-approval keys). */
        fun available(context: android.content.Context): Boolean {
            val bm = context.getSystemService(BiometricManager::class.java) ?: return false
            return bm.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL) ==
                BiometricManager.BIOMETRIC_SUCCESS
        }
    }
}
