package xyz.prawl.core.protocol

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import xyz.prawl.core.util.Bytes
import xyz.prawl.core.util.Keccak256
import xyz.prawl.core.util.arr
import xyz.prawl.core.util.has
import xyz.prawl.core.util.str
import java.math.BigInteger

/** Escrow deployments the product knows. */
object Escrows {
    const val SEPOLIA = "11155111"
    /** PrawlEscrowV3 (plain deposit / redeem). */
    const val SEPOLIA_V3 = "70b3b7edcd18087c999ec80e3c3b0227c7e0d6e5"
    /** PrawlEscrowV31: v3 plus commit-then-fund (private load), redeem-to-shield and refresh. */
    const val SEPOLIA_V31 = "236b1dc3b1a90e23728da6e361b0ab1c386cd779"

    /** Escrows whose plain deposit/redeem coins the product accepts and spends. */
    val PRODUCT: Set<Pair<String, String>> = setOf(SEPOLIA to SEPOLIA_V3, SEPOLIA to SEPOLIA_V31)

    /** Escrows that implement redeemToShield, refresh and commitDeposit. Shield, refresh and private load are refused elsewhere. */
    val V31: Set<Pair<String, String>> = setOf(SEPOLIA to SEPOLIA_V31)

    /** The wrapped-ether token RAILGUN shields on each chain (Sepolia WETH). */
    val WETH: Map<String, String> = mapOf(SEPOLIA to "fff9976782d46cc05630d1f6ebab18b2324d6b14")

    fun isV31(chainId: String, escrow40: String, v31: Set<Pair<String, String>> = V31) = (chainId to escrow40.lowercase().removePrefix("0x")) in v31
}

/**
 * RAILGUN ShieldRequest as the website builds it (kohaku `Shield.addErc20`), HANDOFF.md v1.1 §6/§8:
 * `{npk, tokenType, tokenAddress, tokenSubID, value, encryptedBundle[3], shieldKey}`.
 * Solidity: `((bytes32 npk, (uint8 tokenType, address tokenAddress, uint256 tokenSubID), uint120 value),
 *            (bytes32[3] encryptedBundle, bytes32 shieldKey))`, all static, so abi.encode is 9 words (288 bytes).
 */
class ShieldRequest private constructor(
    val npk: BigInteger, val tokenType: Int, val tokenAddress: BigInteger, val tokenSubId: BigInteger, val value: BigInteger,
    val encryptedBundle: List<BigInteger>, val shieldKey: BigInteger, val json: JsonObject,
) {
    /** abi.encode(request): 9 big-endian 32-byte words in the order npk, tokenType, tokenAddress, tokenSubID, value, eb[0..2], shieldKey. */
    fun abi(): ByteArray = (listOf(npk, BigInteger.valueOf(tokenType.toLong()), tokenAddress, tokenSubId, value) + encryptedBundle + shieldKey)
        .fold(ByteArray(0)) { a, w -> a + Bytes.fixed(w, 32) }

    /** sha256(abi.encode(request)), lowercase hex without 0x. */
    fun hash(): String = Bytes.sha256Hex(abi())

    /** Output key of the REDEEM-SHIELD output: sha256hex("PRAWL-REDEEM-SHIELD|chainId|escrow40|shieldHash"). */
    fun outputKey(chainId: String, escrow40: String): String =
        Bytes.sha256Hex("PRAWL-REDEEM-SHIELD|$chainId|${escrow40.lowercase().removePrefix("0x")}|${hash()}")

    val tokenAddress40: String get() = Bytes.hex(Bytes.fixed(tokenAddress, 20))

    companion object {
        private val MAX_U120 = BigInteger.ONE.shiftLeft(120) - BigInteger.ONE

        private fun hexWord(o: JsonObject, k: String, bytes: Int): BigInteger {
            val s = o.str(k).removePrefix("0x").removePrefix("0X")
            require(Bytes.isHex(s) && s.length <= bytes * 2) { "'$k' must be at most $bytes bytes of hex" }
            return BigInteger(s, 16)
        }

        private fun decimal(o: JsonObject, k: String): BigInteger {
            val s = o.str(k)
            require(s.isNotEmpty() && s.all { it in '0'..'9' } && (s == "0" || s[0] != '0') && s.length <= 78) { "'$k' must be a decimal integer" }
            return BigInteger(s)
        }

        /** Parses `request` (or a shield-target object wrapping it). Strict: every field must be present and well-formed. */
        fun parse(o: JsonObject): ShieldRequest {
            val r = if (o.has("request")) o["request"] as? JsonObject ?: throw IllegalArgumentException("request is not an object") else o
            val tokenType = decimal(r, "tokenType").also { require(it <= BigInteger.valueOf(2)) { "tokenType out of range" } }.toInt()
            val value = decimal(r, "value").also { require(it <= MAX_U120) { "value exceeds uint120" } }
            val eb = r.arr("encryptedBundle")
            require(eb.size == 3) { "encryptedBundle must have 3 words" }
            val ebw = eb.map { e ->
                val s = (e as? JsonPrimitive)?.content ?: throw IllegalArgumentException("encryptedBundle element is not a string")
                val h = s.removePrefix("0x"); require(Bytes.isHex(h) && h.length <= 64) { "encryptedBundle word malformed" }; BigInteger(h, 16)
            }
            return ShieldRequest(hexWord(r, "npk", 32), tokenType, hexWord(r, "tokenAddress", 20), decimal(r, "tokenSubID"), value, ebw, hexWord(r, "shieldKey", 32), r)
        }
    }
}

/** Refresh output kind (RESULTS §3.6): move a note's value into a NEW coin with a new expiry, key and reclaim address. */
object Refresh {
    /** Coin ids whose first 4 bytes are "RFSH" are reserved for refreshed coins; a phone that draws one re-draws. */
    const val RESERVED_PREFIX = "52465348"

    private val SPKI_P256_PREFIX = Bytes.unhex("3059301306072a8648ce3d020106082a8648ce3d030107034200")

    /** SPKI-DER SHA-256 of the P-256 key (x, y): the protocol's `keyHash` form (same as sha256 of `PublicKey.encoded`). */
    fun keyHashXy(x: BigInteger, y: BigInteger): String =
        Bytes.sha256Hex(SPKI_P256_PREFIX + byteArrayOf(4) + Bytes.fixed(x, 32) + Bytes.fixed(y, 32))

    /** sha256hex("PRAWL-REFRESH|chainId|escrow40|newExpiry|newK0Hash|depositor40"). */
    fun outputKey(chainId: String, escrow40: String, newExpiry: Long, newK0Hash: String, depositor40: String): String =
        Bytes.sha256Hex("PRAWL-REFRESH|$chainId|${escrow40.lowercase().removePrefix("0x")}|$newExpiry|${newK0Hash.lowercase()}|${depositor40.lowercase().removePrefix("0x")}")

    /** newCoinId = "RFSH" || sha256hex("PRAWL-REFRESH-ID|" + msgHash + "|" + index)[8:], 64 hex chars. */
    fun coinId(msgHashHex: String, index: Int): String =
        RESERVED_PREFIX + Bytes.sha256Hex("PRAWL-REFRESH-ID|${msgHashHex.lowercase().removePrefix("0x")}|$index").substring(8)

    fun isReserved(coinIdHex: String) = coinIdHex.lowercase().removePrefix("0x").startsWith(RESERVED_PREFIX)

    /** sha256 of the signed spend message, lowercase hex: the `msgHash` the escrow derives the new coin id from. */
    fun messageHash(message: ByteArray): String = Bytes.sha256Hex(message)
}

/**
 * Commit-then-fund deposit (escrow v3.1): `DepositParams`, its deposit address (CREATE2 of a 56-byte forwarder) and the
 * `load-private` payload pieces. Mirrors `tools/prawl_v3.py deposit_params_abi / deposit_address`.
 */
object DepositParamsV31 {
    private val FORWARDER_INIT_HEAD = Bytes.unhex("60388060095f395ff3")
    private val FORWARDER_RUNTIME_TAIL = Bytes.unhex("3314601b57005b604036038060405f375f5f825f6020355f355af16036575f5ffd5b00")

    class Params(val coinId: String, val expiry: Long, val k0x: BigInteger, val k0y: BigInteger, val depositor40: String,
                 val minValue: BigInteger, val maxValue: BigInteger, val tip: BigInteger) {
        /** abi.encode(DepositParams): coinId, expiry, k0x, k0y, depositor, minValue, maxValue, tip (8 words). */
        fun abi(): ByteArray = listOf(BigInteger(coinId.removePrefix("0x"), 16), BigInteger.valueOf(expiry), k0x, k0y,
            BigInteger(depositor40, 16), minValue, maxValue, tip).fold(ByteArray(0)) { a, w -> a + Bytes.fixed(w, 32) }
    }

    /** CREATE2(escrow, keccak256(abi.encode(p)), keccak256(0x60388060095f395ff3 ‖ 0x73 ‖ escrow ‖ tail)), lowercase 40 hex. */
    fun depositAddress(escrow40: String, p: Params): String {
        val esc = Bytes.unhex(escrow40)
        require(esc.size == 20) { "escrow must be 20 bytes" }
        val init = FORWARDER_INIT_HEAD + byteArrayOf(0x73) + esc + FORWARDER_RUNTIME_TAIL
        val salt = Keccak256.hash(p.abi())
        return Bytes.hex(Keccak256.hash(byteArrayOf(0xff.toByte()) + esc + salt + Keccak256.hash(init)).copyOfRange(12, 32))
    }

    /** HANDOFF v1.1 §5 `params` object. */
    fun paramsJson(p: Params): JsonObject = buildJsonObject {
        put("coinId", "0x" + p.coinId.removePrefix("0x")); put("expiry", p.expiry)
        put("k0x", Bytes.hex32(p.k0x)); put("k0y", Bytes.hex32(p.k0y)); put("depositor", "0x" + p.depositor40)
        put("minValue", p.minValue.toString()); put("maxValue", p.maxValue.toString()); put("tip", p.tip.toString())
    }
}


/** A refresh that was signed and handed to the website, not yet confirmed on-chain (see [OfflineWallet.markRefreshed]). */
class PendingRefresh(val json: JsonObject) {
    val coinId: String get() = json.str("coinId")
    val alias: String get() = json.str("alias")
    val label: String get() = json.str("label")
    val value: BigInteger get() = BigInteger(json.str("value"))
    val oldCoinId: String get() = json.str("oldCoinId")
    val header: xyz.prawl.core.model.CoinHeader get() = xyz.prawl.core.model.CoinHeader(json["header"] as JsonObject)
    val bundle: JsonObject get() = xyz.prawl.core.util.Js.parse(json.str("bundle"))
    val at: Long get() = json.str("at").toLong()
}
