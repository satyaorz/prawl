package xyz.prawl.core.certs

import kotlinx.serialization.json.JsonObject
import xyz.prawl.core.attest.AttestationVerifier
import xyz.prawl.core.attest.TrustAnchors
import xyz.prawl.core.util.Bytes
import xyz.prawl.core.util.optStr
import java.io.File
import java.security.PublicKey

/**
 * Certificate cache keyed by the protocol's compact certificate id: the first 128 bits of SHA-256(DER), hex.
 * Bundles and requests reference certificates by id and carry only those the recipient lacks.
 */
interface CertStore {
    fun get(id: String): ByteArray?
    /** Stores [der] (idempotent) and returns its id. */
    fun put(der: ByteArray): String
    fun ids(): List<String>

    companion object {
        fun certId(der: ByteArray): String = Bytes.hex(Bytes.sha256(der).copyOfRange(0, 16))
    }
}

class MemoryCertStore : CertStore {
    private val m = LinkedHashMap<String, ByteArray>()
    @Synchronized override fun get(id: String) = m[id]
    @Synchronized override fun put(der: ByteArray): String = CertStore.certId(der).also { m.putIfAbsent(it, der) }
    @Synchronized override fun ids() = m.keys.toList()
}

/** Same layout as the harness: one file per certificate in `files/certs/<id>`. */
class FileCertStore(private val dir: File) : CertStore {
    init { dir.mkdirs() }
    override fun get(id: String): ByteArray? {
        if (!Bytes.isHex(id, 32)) return null
        val f = File(dir, id)
        return if (f.exists()) f.readBytes() else null
    }
    @Synchronized override fun put(der: ByteArray): String {
        val id = CertStore.certId(der)
        val f = File(dir, id)
        if (!f.exists()) {
            val tmp = File(dir, "$id.tmp")
            tmp.writeBytes(der)
            if (!tmp.renameTo(f)) { tmp.delete(); if (!f.exists()) throw java.io.IOException("cannot store cert $id") }
        }
        return id
    }
    override fun ids(): List<String> = dir.listFiles()?.map { it.name }?.filter { Bytes.isHex(it, 32) }?.sorted() ?: emptyList()
}

/**
 * Resolves certificate ids exactly as the harness's `getCert`: a certificate carried in the message
 * (checked against its id), else the local cache, else a pinned root.
 */
class CertResolver(private val store: CertStore, private val anchors: TrustAnchors) {
    private val rootById: Map<String, ByteArray> = anchors.rootsDer.associateBy { CertStore.certId(it) }

    val rootIds: Set<String> get() = rootById.keys

    fun get(id: String, carried: JsonObject? = null): ByteArray {
        carried?.optStr(id)?.let { b64 ->
            val d = Bytes.unb64(b64)
            if (CertStore.certId(d) != id) throw MissingCertException("cert hash mismatch $id")
            return d
        }
        store.get(id)?.let { return it }
        rootById[id]?.let { return it }
        throw MissingCertException("missing cert $id")
    }

    fun chain(ids: List<String>, carried: JsonObject? = null): List<ByteArray> = ids.map { get(it, carried) }

    fun leafKey(ids: List<String>, carried: JsonObject? = null): PublicKey =
        TrustAnchors.parseCert(get(ids.first(), carried)).publicKey

    fun leafKeyHash(ids: List<String>, carried: JsonObject? = null): String = Bytes.sha256Hex(leafKey(ids, carried).encoded)

    /** Stores every carried certificate (after a payment was accepted). */
    fun absorb(carried: JsonObject?) {
        carried?.keys?.forEach { id -> store.put(get(id, carried)) }
    }

    /**
     * Ids a payer may skip: reusable certificates (CAs, or anything without a KeyDescription), as in the
     * harness's request "known" list. One-time leaf certificates are never advertised.
     */
    fun knownReusableIds(): List<String> = store.ids().filter { id ->
        try {
            val c = TrustAnchors.parseCert(store.get(id)!!)
            c.basicConstraints >= 0 || c.getExtensionValue(AttestationVerifier.OID_KEY_DESC) == null
        } catch (e: Exception) { false }
    }
}

class MissingCertException(msg: String) : Exception(msg)
