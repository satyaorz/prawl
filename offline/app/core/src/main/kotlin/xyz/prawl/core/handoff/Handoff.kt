package xyz.prawl.core.handoff

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import xyz.prawl.core.attest.TrustAnchors
import xyz.prawl.core.certs.CertResolver
import xyz.prawl.core.model.Bundle
import xyz.prawl.core.model.CoinHeader
import xyz.prawl.core.model.Output
import xyz.prawl.core.protocol.DepositParamsV31
import xyz.prawl.core.util.Bytes
import xyz.prawl.core.util.Eth
import xyz.prawl.core.util.EcdsaDer
import xyz.prawl.core.util.Js
import xyz.prawl.core.util.int
import xyz.prawl.core.util.long
import xyz.prawl.core.util.obj
import xyz.prawl.core.util.optStr
import xyz.prawl.core.util.str
import java.math.BigInteger
import java.security.interfaces.ECPublicKey

/**
 * Phone <-> website handoff, v1 (raw/v3/HANDOFF.md). Kotlin twin of raw/v3/handoff.py: same fields, same order,
 * compact JSON (`separators=(",", ":")`), base64url without padding. Unit-tested byte-for-byte against
 * raw/v3/handoff_vectors/.
 *
 *  - QR / link: `https://<site>/#/offline/<kind>?d=<d>`; the app also accepts `prawl://offline/<kind>?d=<d>`.
 *  - kinds: `load` (mint fields for deposit) and `redeem` (exact redeem(Header, Spend[], Redemption) args).
 */
object Handoff {
    const val VERSION = 1

    fun h32(x: String): String = "0x" + x.lowercase().replace("0x", "").padStart(64, '0')
    fun a40(x: String): String = "0x" + x.lowercase().replace("0x", "").padStart(40, '0')
    private fun hexInt32(v: BigInteger) = "0x" + v.toString(16).padStart(64, '0')

    private fun header(h: CoinHeader): JsonObject = buildJsonObject {
        put("coinId", h32(h.coinId)); put("value", h.value.toString()); put("expiry", h.expiry)
        put("k0x", h32(requireNotNull(h.k0x) { "header has no k0x" })); put("k0y", h32(requireNotNull(h.k0y) { "header has no k0y" }))
        put("depositor", a40(h.depositor))
    }

    private fun outs(os: List<Output>): JsonArray = buildJsonArray {
        os.forEach { o -> add(buildJsonObject { put("value", o.value.toString()); put("keyHash", h32(o.key)) }) }
    }

    /** `load` payload from a mint3 file / coin header. */
    fun load(mint: JsonObject): JsonObject {
        val h = CoinHeader(mint)
        return buildJsonObject {
            put("v", VERSION); put("t", "load"); put("chainId", h.chainId.toLong()); put("escrow", a40(h.escrow))
            header(h).forEach { (k, v) -> put(k, v) }
        }
    }

    /**
     * `redeem` payload from a phone-signed redemption bundle. nextX/nextY come from the attestation leaf of each
     * spend's next key (carried certificate first, then [resolver]).
     */
    fun redeem(bundleJson: JsonObject, resolver: CertResolver?): JsonObject {
        val b = Bundle(bundleJson)
        val carried = b.certs
        fun leaf(ids: List<String>): ECPublicKey {
            val id = ids.first()
            val der = carried?.optStr(id)?.let { Bytes.unb64(it) } ?: resolver?.get(id, carried)
                ?: throw IllegalArgumentException("missing next-key certificate $id")
            return TrustAnchors.parseCert(der).publicKey as ECPublicKey
        }
        val h = b.header
        val path = buildJsonArray {
            for (s in b.path) {
                val k = leaf(s.next)
                val rs = EcdsaDer.parseStrict(Bytes.unb64(s.sig))
                add(buildJsonObject {
                    put("outputs", outs(s.outputs)); put("index", s.index)
                    put("r", hexInt32(rs.r)); put("s", hexInt32(rs.s))
                    put("nextX", hexInt32(k.w.affineX)); put("nextY", hexInt32(k.w.affineY))
                })
            }
        }
        val rd = bundleJson.obj("redeem")
        val rrs = EcdsaDer.parseStrict(Bytes.unb64(rd.str("sig")))
        val kind = rd.optStr("kind") ?: "redeem"
        require(kind == "redeem" || kind == "shield" || kind == "refresh") { "unknown redemption kind '$kind'" }
        return buildJsonObject {
            put("v", VERSION); put("t", when (kind) { "shield" -> "redeem-shield"; "refresh" -> "refresh"; else -> "redeem" })
            put("chainId", h.chainId.toLong()); put("escrow", a40(h.escrow))
            put("header", header(h)); put("path", path)
            put("redemption", buildJsonObject {
                put("outputs", outs(Output.list(rd["outputs"] as JsonArray))); put("index", rd.int("index"))
                put("payout", a40(rd.str("payout"))); put("r", hexInt32(rrs.r)); put("s", hexInt32(rrs.s))
            })
            when (kind) {
                // HANDOFF v1.1 §7: "the same object as redeem, plus shield: the request" (echoed exactly as the website sent it)
                "shield" -> put("shield", rd.obj("shield"))
                // PROVISIONAL (not in HANDOFF.md yet): the extra arguments of refresh(header, path, redemption, newCoinId, newExpiry, newK0x, newK0y);
                // redemption.payout is the new coin's depositor (reclaim address)
                "refresh" -> rd.obj("refresh").let { r ->
                    put("refresh", buildJsonObject {
                        put("newCoinId", h32(r.str("coinId"))); put("newExpiry", r.long("expiry"))
                        put("newK0x", h32(r.str("k0x"))); put("newK0y", h32(r.str("k0y")))
                    })
                }
            }
        }
    }

    /**
     * HANDOFF v1.1 §5 `load-private` payload for a coin minted for commit-then-fund (escrow v3.1): the `DepositParams`
     * (exact mode: minValue = maxValue = the coin value; `depositor` = the reclaim address) and the CREATE2 `depositAddress`
     * the website must unshield to. [tipWei] is the relayer tip the unshield amount must also cover.
     */
    fun loadPrivate(h: CoinHeader, tipWei: BigInteger = BigInteger.ZERO): JsonObject {
        val p = DepositParamsV31.Params(h.coinId, h.expiry, BigInteger(requireNotNull(h.k0x) { "header has no k0x" }, 16),
            BigInteger(requireNotNull(h.k0y) { "header has no k0y" }, 16), h.depositor.lowercase(), h.value, h.value, tipWei)
        require(Eth.normalize40(h.escrow) != null)
        return buildJsonObject {
            put("v", VERSION); put("t", "load-private"); put("chainId", h.chainId.toLong()); put("escrow", a40(h.escrow))
            put("params", DepositParamsV31.paramsJson(p))
            put("depositAddress", "0x" + DepositParamsV31.depositAddress(h.escrow, p))
        }
    }

    /** `<d>`: compact JSON, UTF-8, base64url without padding. */
    fun encode(payload: JsonObject): String = Bytes.b64url(payload.toString().toByteArray(Charsets.UTF_8))

    fun httpsLink(site: String, kind: String, d: String) = "${site.trimEnd('/')}/#/offline/$kind?d=$d"
    fun prawlLink(kind: String, d: String) = "prawl://offline/$kind?d=$d"

    data class Parsed(val kind: String, val payload: JsonObject)

    /**
     * Parses `prawl://offline/<kind>?d=…` or `https://…/#/offline/<kind>?d=…`. Rejects an unknown `v`
     * (HANDOFF.md: unknown fields are ignored, an unknown version is rejected).
     */
    fun parseLink(link: String): Parsed {
        val s = link.trim()
        val tail = when {
            s.startsWith("prawl://offline/") -> s.removePrefix("prawl://offline/")
            s.contains("#/offline/") -> s.substringAfter("#/offline/")
            else -> throw IllegalArgumentException("not a Prawl offline link")
        }
        val kind = tail.substringBefore('?').trim('/')
        val query = tail.substringAfter('?', "")
        val d = query.split('&').firstOrNull { it.startsWith("d=") }?.removePrefix("d=")
            ?: throw IllegalArgumentException("link has no d= payload")
        val payload = Js.parse(String(Bytes.unb64url(d), Charsets.UTF_8))
        val v = payload.optStr("v")?.toIntOrNull()
        require(v == VERSION) { "unsupported payload version $v" }
        payload.optStr("t")?.let { require(it == kind) { "payload type '$it' does not match link kind '$kind'" } }
        return Parsed(kind, payload)
    }
}
