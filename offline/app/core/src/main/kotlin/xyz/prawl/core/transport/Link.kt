package xyz.prawl.core.transport

import java.io.Closeable
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** A bidirectional message link (Bluetooth RFCOMM / L2CAP socket, or an in-memory pipe in tests). */
interface Link : Closeable {
    fun send(s: String)
    fun recv(): String
}

/**
 * The harness framing: 4-byte big-endian length, then UTF-8 bytes (`Wallet2Activity.send/recv`).
 * Used as-is (plaintext) for interop with the Java harness over RFCOMM.
 */
class FramedLink(input: InputStream, output: OutputStream, private val closer: Closeable? = null) : Link {
    private val i = DataInputStream(input)
    private val o = DataOutputStream(output)

    fun sendBytes(b: ByteArray) { o.writeInt(b.size); o.write(b); o.flush() }
    fun recvBytes(): ByteArray {
        val n = i.readInt()
        if (n < 0 || n > MAX_FRAME) throw IOException("bad frame $n")
        return ByteArray(n).also { i.readFully(it) }
    }

    override fun send(s: String) = sendBytes(s.toByteArray(StandardCharsets.UTF_8))
    override fun recv(): String = String(recvBytes(), StandardCharsets.UTF_8)
    override fun close() { closer?.close() }

    companion object { const val MAX_FRAME = 4_000_000 }
}

/**
 * Encrypted, authenticated framing for app-to-app sessions. The payee's QR carries a random 16-byte session
 * secret; only someone who scanned it can talk on the link, and a passive Bluetooth sniffer sees only
 * ciphertext (the bundle's attestation chains would otherwise link payments to the paying phone).
 *
 * Keys: HKDF-SHA256(secret, salt = session id) with one key per direction; AES-256-GCM, nonce = 4 zero bytes +
 * 64-bit frame counter, so a dropped, replayed or reordered frame fails authentication.
 */
class SecureLink(private val inner: FramedLink, secret: ByteArray, sessionId: ByteArray, role: Role) : Link {
    enum class Role { PAYEE, PAYER }

    private val sendKey: ByteArray
    private val recvKey: ByteArray
    private var sendCtr = 0L
    private var recvCtr = 0L

    init {
        require(secret.size >= 16) { "session secret too short" }
        val toPayer = hkdf(secret, sessionId, "prawl-offline-link-v1|payee->payer")
        val toPayee = hkdf(secret, sessionId, "prawl-offline-link-v1|payer->payee")
        if (role == Role.PAYEE) { sendKey = toPayer; recvKey = toPayee } else { sendKey = toPayee; recvKey = toPayer }
    }

    private fun nonce(c: Long) = ByteBuffer.allocate(12).putInt(0).putLong(c).array()

    override fun send(s: String) {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(sendKey, "AES"), GCMParameterSpec(128, nonce(sendCtr++)))
        inner.sendBytes(c.doFinal(s.toByteArray(StandardCharsets.UTF_8)))
    }

    override fun recv(): String {
        val ct = inner.recvBytes()
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, SecretKeySpec(recvKey, "AES"), GCMParameterSpec(128, nonce(recvCtr++)))
        val pt = try { c.doFinal(ct) } catch (e: Exception) { throw LinkAuthException() }
        return String(pt, StandardCharsets.UTF_8)
    }

    override fun close() = inner.close()

    companion object {
        /** RFC 5869 HKDF-SHA256, 32-byte output. */
        fun hkdf(ikm: ByteArray, salt: ByteArray, info: String): ByteArray {
            val mac = Mac.getInstance("HmacSHA256")
            mac.init(SecretKeySpec(if (salt.isEmpty()) ByteArray(32) else salt, "HmacSHA256"))
            val prk = mac.doFinal(ikm)
            mac.init(SecretKeySpec(prk, "HmacSHA256"))
            mac.update(info.toByteArray(StandardCharsets.UTF_8)); mac.update(1)
            return mac.doFinal()
        }
    }
}

/** A frame failed authentication: wrong session secret (not the QR we showed) or tampering. */
class LinkAuthException : IOException("link authentication failed (peer did not scan this QR, or the data was altered)")
