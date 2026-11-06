package xyz.prawl.core

import xyz.prawl.core.attest.AttestationResult
import xyz.prawl.core.attest.ChainChecker
import xyz.prawl.core.attest.TrustAnchors
import xyz.prawl.core.keys.ApprovalPrompt
import xyz.prawl.core.keys.KeyRefusedException
import xyz.prawl.core.keys.KeySpec
import xyz.prawl.core.keys.KeyVault
import xyz.prawl.core.keys.SpendApprover
import xyz.prawl.core.util.Bytes
import java.io.ByteArrayOutputStream
import java.math.BigInteger
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.PrivateKey
import java.security.PublicKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/**
 * Software stand-in for the AndroidKeyStore for JVM flow tests: P-256 keys, a usage counter emulating
 * setMaxUsageCount(1), user-auth emulation, and a self-signed X.509 "chain" carrying the key.
 * The real attestation verifier is tested separately on the real phone chains.
 */
class FakeKeyVault : KeyVault {
    class Entry(val kp: KeyPair, val spec: KeySpec, var uses: Int = 0)
    val entries = LinkedHashMap<String, Entry>()
    override val strongBoxAvailable = false

    override fun create(alias: String, spec: KeySpec): List<ByteArray> {
        val g = KeyPairGenerator.getInstance("EC"); g.initialize(ECGenParameterSpec("secp256r1"))
        val kp = g.generateKeyPair()
        entries[alias] = Entry(kp, spec)
        return listOf(TestCerts.selfSigned(kp, alias))
    }

    override fun publicKey(alias: String): PublicKey? = entries[alias]?.kp?.public
    override fun requiresUserAuth(alias: String) = entries[alias]?.spec?.userAuthPerUse ?: false

    override fun sign(alias: String, msg: ByteArray, approver: SpendApprover?, prompt: ApprovalPrompt): ByteArray {
        val e = entries[alias] ?: throw KeyRefusedException("coin key no longer exists (already used once)")
        var s = Signature.getInstance("SHA256withECDSA"); s.initSign(e.kp.private)
        if (e.spec.userAuthPerUse) {
            if (approver == null) throw KeyRefusedException("Key user not authenticated")
            s = approver.authorize(s, prompt)
        }
        if (e.spec.singleUse && e.uses >= 1) throw KeyRefusedException("Key is exhausted")
        s.update(msg)
        val sig = s.sign()
        e.uses++
        if (e.spec.singleUse) entries.remove(alias)   // keystore2 deletes an exhausted single-use key
        return sig
    }

    override fun delete(alias: String) { entries.remove(alias) }
    override fun aliases() = entries.keys.toList()
}

/** Accepts every chain as a "hardware one-time key", except leaf keys listed in [bad]. */
class FakeChecker(val bad: MutableSet<String> = HashSet()) : ChainChecker {
    override fun verify(chainDer: List<ByteArray>): AttestationResult {
        val r = AttestationResult()
        val k = TrustAnchors.parseCert(chainDer[0]).publicKey
        r.leafKey = k; r.leafKeyHash = Bytes.sha256Hex(k.encoded); r.level = "Fake"
        if (r.leafKeyHash in bad) r.fails.add("usageCountLimit==1 hardware-enforced")
        r.ok = r.fails.isEmpty()
        return r
    }
}

/** Minimal DER writer to build a self-signed ECDSA certificate on the plain JVM. */
object TestCerts {
    private fun tlv(tag: Int, body: ByteArray): ByteArray {
        val o = ByteArrayOutputStream(); o.write(tag)
        val n = body.size
        when {
            n < 0x80 -> o.write(n)
            n < 0x100 -> { o.write(0x81); o.write(n) }
            else -> { o.write(0x82); o.write(n shr 8); o.write(n and 0xff) }
        }
        o.write(body); return o.toByteArray()
    }
    private fun seq(vararg p: ByteArray) = tlv(0x30, p.fold(ByteArray(0)) { a, b -> a + b })
    private fun int(v: BigInteger) = tlv(0x02, v.toByteArray())
    private val ECDSA_SHA256 = seq(byteArrayOf(0x06, 0x08, 0x2a, 0x86.toByte(), 0x48, 0xce.toByte(), 0x3d, 0x04, 0x03, 0x02))
    private fun name(cn: String) = seq(tlv(0x31, seq(byteArrayOf(0x06, 0x03, 0x55, 0x04, 0x03), tlv(0x0c, cn.toByteArray()))))
    private fun time(s: String) = tlv(0x17, s.toByteArray())

    fun selfSigned(kp: KeyPair, cn: String): ByteArray = sign(kp.public, kp.private, cn)

    private fun sign(pub: PublicKey, priv: PrivateKey, cn: String): ByteArray {
        val tbs = seq(
            tlv(0xa0, int(BigInteger.valueOf(2))), int(BigInteger(64, java.security.SecureRandom()).add(BigInteger.ONE)),
            ECDSA_SHA256, name(cn), seq(time("260101000000Z"), time("360101000000Z")), name(cn), pub.encoded,
        )
        val s = Signature.getInstance("SHA256withECDSA"); s.initSign(priv); s.update(tbs)
        return seq(tbs, ECDSA_SHA256, tlv(0x03, byteArrayOf(0) + s.sign()))
    }
}
