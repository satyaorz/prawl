package xyz.prawl.core.util

import java.math.BigInteger
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.Base64

/** Byte/hex/base64/hash helpers. Pure JVM: used on the phone and in JVM unit tests. */
object Bytes {
    private val HEX = "0123456789abcdef".toCharArray()

    fun hex(b: ByteArray): String {
        val out = CharArray(b.size * 2)
        for (i in b.indices) {
            val v = b[i].toInt() and 0xff
            out[2 * i] = HEX[v ushr 4]; out[2 * i + 1] = HEX[v and 0x0f]
        }
        return String(out)
    }

    fun unhex(s: String): ByteArray {
        val h = s.removePrefix("0x").removePrefix("0X")
        require(h.length % 2 == 0) { "odd-length hex" }
        return ByteArray(h.length / 2) { i ->
            val hi = Character.digit(h[2 * i], 16); val lo = Character.digit(h[2 * i + 1], 16)
            require(hi >= 0 && lo >= 0) { "not hex: $s" }
            ((hi shl 4) or lo).toByte()
        }
    }

    fun isHex(s: String, len: Int? = null): Boolean =
        (len == null || s.length == len) && s.isNotEmpty() && s.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }

    fun sha256(b: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(b)
    fun sha256Hex(b: ByteArray): String = hex(sha256(b))
    /** sha256 of the UTF-8 bytes of [s], lowercase hex (the protocol's `sha256hex`). */
    fun sha256Hex(s: String): String = sha256Hex(s.toByteArray(StandardCharsets.UTF_8))

    /** Standard base64 with padding, no line wrapping (Android `Base64.NO_WRAP`). */
    fun b64(b: ByteArray): String = Base64.getEncoder().encodeToString(b)
    /** Lenient standard-base64 decode (ignores whitespace, as Android's decoder does). */
    fun unb64(s: String): ByteArray = Base64.getMimeDecoder().decode(s)
    fun b64url(b: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(b)
    fun unb64url(s: String): ByteArray = Base64.getUrlDecoder().decode(s.trimEnd('='))

    /** Unsigned big-endian integer as exactly [len] bytes (left-padded); fails if it does not fit. */
    fun fixed(v: BigInteger, len: Int = 32): ByteArray {
        require(v.signum() >= 0) { "negative" }
        val raw = v.toByteArray().let { if (it.size > 1 && it[0] == 0.toByte()) it.copyOfRange(1, it.size) else it }
        require(raw.size <= len) { "value does not fit in $len bytes" }
        return ByteArray(len - raw.size) + raw
    }

    fun hex32(v: BigInteger): String = "0x" + hex(fixed(v, 32))
}
