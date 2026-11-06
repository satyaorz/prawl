package xyz.prawl.core.attest

import xyz.prawl.core.util.Bytes
import java.io.ByteArrayInputStream
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate

/**
 * The offline trust inputs of the attestation verifier:
 *  - the pinned Google hardware-attestation roots (`roots.pem`),
 *  - the cached revocation list (`revoked.txt`: lowercase hex serials, one per line) and when it was fetched.
 *
 * The fetch time drives the "revocation freshness" rule: if the list is older than
 * [RecipientPolicy.revocationMaxAgeS], recipients drop to the small stale cap.
 */
class TrustAnchors(
    val rootsDer: List<ByteArray>,
    val revokedSerials: Set<String>,
    /** Unix seconds at which [revokedSerials] was fetched from Google (HTTP Date of the status response). */
    val revocationFetchedAt: Long,
) {
    val rootSpkis: List<ByteArray> = rootsDer.map { parseCert(it).publicKey.encoded }

    companion object {
        /** 2026-11-05T11:37:48Z: the status.hdr Date of the list bundled with the harness (`Wallet2Activity.REVOCATION_FETCHED`). */
        const val BUNDLED_REVOCATION_FETCHED = 1793878668L

        fun parsePem(pem: String): List<ByteArray> =
            pem.split("-----END CERTIFICATE-----").mapNotNull { part ->
                val b = part.replace("-----BEGIN CERTIFICATE-----", "").replace(Regex("\\s"), "")
                if (b.isEmpty()) null else Bytes.unb64(b)
            }

        fun parseRevoked(text: String): Set<String> =
            text.lineSequence().map { it.trim().lowercase() }.filter { it.isNotEmpty() && !it.startsWith("#") }.toSet()

        fun fromText(rootsPem: String, revokedTxt: String, fetchedAt: Long = BUNDLED_REVOCATION_FETCHED) =
            TrustAnchors(parsePem(rootsPem), parseRevoked(revokedTxt), fetchedAt)

        fun parseCert(der: ByteArray): X509Certificate =
            CertificateFactory.getInstance("X.509").generateCertificate(ByteArrayInputStream(der)) as X509Certificate
    }
}
