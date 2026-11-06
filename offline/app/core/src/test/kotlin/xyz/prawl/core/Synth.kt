package xyz.prawl.core

import java.io.ByteArrayOutputStream
import java.math.BigInteger
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.PrivateKey
import java.security.PublicKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/** Minimal DER + X.509 writer for synthetic Android-attestation-shaped chains (test root injected into TrustAnchors). */
object Synth {
    fun len(n: Int): ByteArray = when {
        n < 0x80 -> byteArrayOf(n.toByte())
        n < 0x100 -> byteArrayOf(0x81.toByte(), n.toByte())
        else -> byteArrayOf(0x82.toByte(), (n shr 8).toByte(), n.toByte())
    }
    fun tlv(tag: Int, body: ByteArray) = byteArrayOf(tag.toByte()) + len(body.size) + body
    fun seq(vararg p: ByteArray) = tlv(0x30, p.fold(ByteArray(0)) { a, b -> a + b })
    fun set(vararg p: ByteArray) = tlv(0x31, p.fold(ByteArray(0)) { a, b -> a + b })
    fun int(v: Long) = tlv(0x02, BigInteger.valueOf(v).toByteArray())
    fun enum(v: Int) = tlv(0x0a, byteArrayOf(v.toByte()))
    fun oct(b: ByteArray) = tlv(0x04, b)
    fun bool(v: Boolean) = tlv(0x01, byteArrayOf(if (v) 0xff.toByte() else 0))
    fun oid(dotted: String): ByteArray {
        val p = dotted.split('.').map { it.toLong() }
        val o = ByteArrayOutputStream(); o.write((p[0] * 40 + p[1]).toInt())
        for (x in p.drop(2)) { val bytes = ArrayList<Int>(); var v = x; bytes.add((v and 0x7f).toInt()); v = v shr 7; while (v > 0) { bytes.add(((v and 0x7f) or 0x80).toInt()); v = v shr 7 }; bytes.reversed().forEach { o.write(it) } }
        return tlv(0x06, o.toByteArray())
    }
    /** EXPLICIT tag [n] of class (0=context 0x80, 1=application 0x40), constructed, high-tag-number form when n >= 31. */
    fun tagged(n: Int, body: ByteArray, cls: Int = 0x80): ByteArray {
        val first = cls or 0x20
        val head = if (n < 31) byteArrayOf((first or n).toByte()) else {
            val groups = ArrayList<Int>(); var v = n; groups.add(v and 0x7f); v = v shr 7; while (v > 0) { groups.add((v and 0x7f) or 0x80); v = v shr 7 }
            byteArrayOf((first or 0x1f).toByte()) + groups.reversed().map { it.toByte() }.toByteArray()
        }
        return head + len(body.size) + body
    }

    private val SHA256_ECDSA = seq(oid("1.2.840.10045.4.3.2"))
    private fun name(cn: String) = seq(set(seq(oid("2.5.4.3"), tlv(0x0c, cn.toByteArray()))))
    private fun time(s: String) = tlv(0x17, s.toByteArray())
    fun ext(oid: String, value: ByteArray) = seq(oid(oid), oct(value))

    fun newKey(): KeyPair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()

    fun cert(subjectKey: PublicKey, issuerKey: PrivateKey, subjectCn: String, issuerCn: String, serial: Long, extensions: List<ByteArray>, notAfter: String = "360101000000Z"): ByteArray {
        val tbs = seq(
            tagged(0, int(2), 0x80).let { byteArrayOf(0xa0.toByte()) + len(int(2).size) + int(2) },
            int(serial), SHA256_ECDSA, name(issuerCn), seq(time("260101000000Z"), time(notAfter)), name(subjectCn), subjectKey.encoded,
            if (extensions.isEmpty()) ByteArray(0) else byteArrayOf(0xa3.toByte()) + len(seq(*extensions.toTypedArray()).size) + seq(*extensions.toTypedArray()),
        )
        val s = Signature.getInstance("SHA256withECDSA"); s.initSign(issuerKey); s.update(tbs)
        return seq(tbs, SHA256_ECDSA, tlv(0x03, byteArrayOf(0) + s.sign()))
    }

    class Hw(
        var usage: List<ByteArray> = listOf(tagged(405, int(1))),
        var origin: ByteArray = tagged(702, int(0)),
        var purpose: ByteArray = tagged(1, set(int(2))),
        var alg: ByteArray = tagged(2, int(3)),
        var curve: ByteArray = tagged(10, int(1)),
        var rot: ByteArray = tagged(704, seq(oct(ByteArray(32)), bool(true), enum(0), oct(ByteArray(32)))),
        var patch: ByteArray = tagged(706, int(202611)),
        var extra: List<ByteArray> = emptyList(),
    ) { fun der(): ByteArray = seq(*(listOf(purpose, alg, curve) + usage + listOf(origin, rot, patch) + extra).toTypedArray()) }

    fun appId(pkg: String, digestHex: String) = tagged(709, oct(seq(set(seq(oct(pkg.toByteArray()), int(1))), set(oct(digestHex.chunked(2).map { it.toInt(16).toByte() }.toByteArray())))))

    fun keyDescription(attLevel: Int = 2, kmLevel: Int = 2, sw: List<ByteArray>, hw: ByteArray, challenge: ByteArray = ByteArray(32) { 7 }): ByteArray =
        seq(int(4), enum(attLevel), int(4), enum(kmLevel), oct(challenge), oct(ByteArray(0)), seq(*sw.toTypedArray()), hw)

    const val OID_KD = "1.3.6.1.4.1.11129.2.1.17"
}
