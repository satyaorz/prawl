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

        /** Largest certificate accepted anywhere (real attestation certificates are 1-2.5 KB; a 4096-bit root is 1.4 KB). */
        const val MAX_CERT_BYTES = 16 * 1024
        /** Most certificates the store will hold: refuses more rather than evicting (held notes need their chains to be forwarded). */
        const val MAX_CERTS = 5000
        /** Longest attestation chain (cert id list) accepted from a peer; real chains have 4-5. */
        const val MAX_CHAIN = 8

        fun checkSize(der: ByteArray) { require(der.size in 1..MAX_CERT_BYTES) { "certificate of ${der.size} bytes is outside 1..$MAX_CERT_BYTES" } }
    }
}

class MemoryCertStore : CertStore {
    private val m = LinkedHashMap<String, ByteArray>()
    @Synchronized override fun get(id: String) = m[id]
    @Synchronized override fun put(der: ByteArray): String {
        CertStore.checkSize(der)
        val id = CertStore.certId(der)
        if (!m.containsKey(id)) { check(m.size < CertStore.MAX_CERTS) { "certificate store is full" }; m[id] = der }
        return id
    }
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
        CertStore.checkSize(der)
        val id = CertStore.certId(der)
        val f = File(dir, id)
        if (!f.exists()) {
            check(ids().size < CertStore.MAX_CERTS) { "certificate store is full" }
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
            if (b64.length > CertStore.MAX_CERT_BYTES * 4 / 3 + 8) throw MissingCertException("carried certificate $id is too large")
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

    /**
     * Stores the carried certificates that [referenced] chains actually use (after a payment was accepted, or a chain verified).
     * Anything else in the carried map is junk a peer attached: it is dropped, never stored (audit F-13).
     */
    fun absorb(carried: JsonObject?, referenced: Collection<String>) {
        if (carried == null) return
        for (id in referenced.toSet()) if (carried.containsKey(id) && id !in rootIds) store.put(get(id, carried))
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
