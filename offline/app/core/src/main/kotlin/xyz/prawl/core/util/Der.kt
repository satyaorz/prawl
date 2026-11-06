package xyz.prawl.core.util

import java.math.BigInteger

/**
 * Minimal DER TLV reader (high-tag-number form, long lengths). Byte-for-byte port of `OtkVerify.Der`
 * from the Java harness, so the attestation extension is parsed exactly as on the tested phones.
 */
class Der private constructor(val tag: Int, val constructed: Boolean, val value: ByteArray, val end: Int) {
    fun children(): List<Der> {
        val out = ArrayList<Der>()
        var i = 0
        while (i < value.size) { val c = parse(value, i); out.add(c); i = c.end }
        return out
    }

    /** Unwraps an EXPLICIT [tag] wrapper. */
    fun inner(): Der = parse(value, 0)
    fun intVal(): BigInteger = BigInteger(value)

    companion object {
        fun parse(b: ByteArray, start: Int): Der {
            var i = start
            val b0 = b[i++].toInt() and 0xff
            val constructed = (b0 and 0x20) != 0
            var tag = b0 and 0x1f
            if (tag == 0x1f) {
                tag = 0
                while (true) {
                    val x = b[i++].toInt() and 0xff
                    tag = (tag shl 7) or (x and 0x7f)
                    if ((x and 0x80) == 0) break
                }
            }
            var len = b[i++].toInt() and 0xff
            if ((len and 0x80) != 0) {
                val n = len and 0x7f
                len = 0
                for (k in 0 until n) len = (len shl 8) or (b[i++].toInt() and 0xff)
            }
            if (len < 0 || i + len > b.size) throw IllegalArgumentException("DER length out of range")
            return Der(tag, constructed, b.copyOfRange(i, i + len), i + len)
        }
    }
}

/** ECDSA signature helpers (DER <-> r,s), used for the website handoff `redeem(...)` arguments. */
object EcdsaDer {
    data class RS(val r: BigInteger, val s: BigInteger)

    /**
     * Parses a DER `SEQUENCE { INTEGER r, INTEGER s }` strictly: minimal lengths and integers, no trailing bytes.
     * The escrow rebuilds DER from (r, s), so a non-strict encoding would make the signed bytes differ.
     */
    /** Minimal DER of (r, s): `30 len 02 len r 02 len s`, integers without redundant leading zero bytes. */
    fun encode(r: BigInteger, s: BigInteger): ByteArray {
        fun int(v: BigInteger): ByteArray { val b = v.toByteArray(); return byteArrayOf(0x02, b.size.toByte()) + b }   // BigInteger.toByteArray is minimal two's complement
        val body = int(r) + int(s)
        return byteArrayOf(0x30, body.size.toByte()) + body
    }

    /**
     * True if [sig] is exactly the minimal DER of its own (r, s), the form the escrow rebuilds (`derSig(r, s)`): the lowercase hex of the
     * signature is part of the child note id, so any other encoding of the same signature would change every descendant's message.
     */
    fun isCanonical(sig: ByteArray): Boolean = try {
        val rs = parseStrict(sig)
        encode(rs.r, rs.s).contentEquals(sig)
    } catch (e: Exception) { false }

    fun parseStrict(sig: ByteArray): RS {
        require(sig.size >= 8 && sig[0] == 0x30.toByte()) { "signature is not a DER SEQUENCE" }
        val seqLen = sig[1].toInt() and 0xff
        require(seqLen < 0x80 && seqLen == sig.size - 2) { "signature: bad sequence length" }
        var i = 2
        fun readInt(): BigInteger {
            require(sig[i] == 0x02.toByte()) { "signature: expected INTEGER" }
            val len = sig[i + 1].toInt() and 0xff
            require(len in 1..33 && i + 2 + len <= sig.size) { "signature: bad INTEGER length" }
            val v = sig.copyOfRange(i + 2, i + 2 + len)
            require(v[0].toInt() and 0x80 == 0) { "signature: negative INTEGER" }
            if (len > 1) require(!(v[0] == 0.toByte() && (v[1].toInt() and 0x80) == 0)) { "signature: non-minimal INTEGER" }
            i += 2 + len
            return BigInteger(1, v)
        }
        val r = readInt(); val s = readInt()
        require(i == sig.size) { "signature: trailing bytes" }
        require(r.signum() > 0 && s.signum() > 0) { "signature: zero r or s" }
        return RS(r, s)
    }
}
