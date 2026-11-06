package xyz.prawl.core.transport

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import xyz.prawl.core.handoff.Handoff
import xyz.prawl.core.util.Bytes
import xyz.prawl.core.util.optStr
import xyz.prawl.core.util.str
import java.math.BigInteger
import java.util.UUID

/**
 * The payee's receive QR (phone -> phone), `prawl://offline/pay?d=<base64url JSON>` in the HANDOFF.md style:
 *
 * {"v":1,"t":"pay","id":"<request name>","kh":"0x<sha256 of the one-time receive key's SPKI>",
 *  "sk":"<base64url 16-byte session secret>","bt":"l2cap"|"rfcomm","u":"<session UUID>","p":<L2CAP PSM>,
 *  "n":"<Bluetooth name, rfcomm only>","a":"<requested wei, optional>"}
 *
 * - `kh` binds the in-person QR to the request that arrives over Bluetooth: the payer refuses any other key.
 * - `u` is a fresh random UUID: advertised over BLE (l2cap) or registered as the RFCOMM service (rfcomm),
 *   so the payer finds the payee without its MAC address (Android 12+ hides it from apps).
 * - `sk` keys the encrypted link ([SecureLink]).
 */
data class PayQr(
    val id: String,
    val keyHash: String,
    val secret: ByteArray,
    val transport: String,
    val serviceUuid: UUID,
    val psm: Int? = null,
    val btName: String? = null,
    val amountWei: BigInteger? = null,
) {
    fun toJson(): JsonObject = buildJsonObject {
        put("v", 1); put("t", "pay"); put("id", id); put("kh", "0x" + keyHash.lowercase().removePrefix("0x"))
        put("sk", Bytes.b64url(secret)); put("bt", transport); put("u", serviceUuid.toString())
        psm?.let { put("p", it) }
        btName?.let { put("n", it) }
        amountWei?.let { put("a", it.toString()) }
    }

    fun link(): String = Handoff.prawlLink("pay", Handoff.encode(toJson()))

    /** Session id for key derivation: the UUID's 16 bytes. */
    fun sessionId(): ByteArray = java.nio.ByteBuffer.allocate(16).putLong(serviceUuid.mostSignificantBits).putLong(serviceUuid.leastSignificantBits).array()

    companion object {
        const val L2CAP = "l2cap"
        const val RFCOMM = "rfcomm"

        fun parse(link: String): PayQr {
            val p = Handoff.parseLink(link)
            require(p.kind == "pay") { "not a Prawl receive code" }
            return fromJson(p.payload)
        }

        fun fromJson(j: JsonObject): PayQr {
            val kh = j.str("kh").lowercase().removePrefix("0x")
            require(Bytes.isHex(kh, 64)) { "bad key hash" }
            val id = j.str("id")
            require(id.isNotEmpty() && id.length <= 40 && id.all { it.isLetterOrDigit() || it == '_' || it == '-' }) { "bad request id" }
            val sk = Bytes.unb64url(j.str("sk"))
            require(sk.size == 16) { "bad session secret" }
            val bt = j.str("bt")
            require(bt == L2CAP || bt == RFCOMM) { "unknown transport $bt" }
            val psm = j.optStr("p")?.toInt()
            if (bt == L2CAP) require(psm != null && psm in 1..0xFFFF) { "missing L2CAP channel" }
            return PayQr(id, kh, sk, bt, UUID.fromString(j.str("u")), psm, j.optStr("n"), j.optStr("a")?.let { BigInteger(it) }?.takeIf { it.signum() > 0 })
        }
    }

    override fun equals(other: Any?) = other is PayQr && other.toJson() == toJson()
    override fun hashCode() = toJson().hashCode()
}
