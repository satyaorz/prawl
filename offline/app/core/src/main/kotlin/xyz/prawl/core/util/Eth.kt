package xyz.prawl.core.util

import java.math.BigDecimal
import java.math.BigInteger
import java.math.RoundingMode

/** Amounts (wei <-> ETH) and Ethereum addresses. */
object Eth {
    val WEI_PER_ETH: BigInteger = BigInteger.TEN.pow(18)

    /** "0.25" -> 250000000000000000. Throws if the amount has more than 18 decimals or is malformed. */
    fun wei(eth: String): BigInteger =
        BigDecimal(eth.trim()).multiply(BigDecimal(WEI_PER_ETH)).toBigIntegerExact()

    /** Same as the harness's `eth()`: plain decimal string, trailing zeros stripped. */
    fun eth(wei: BigInteger): String =
        BigDecimal(wei).divide(BigDecimal(WEI_PER_ETH)).stripTrailingZeros().toPlainString()

    /** Display form with at most [decimals] decimals (rounded down), e.g. "0.0123". */
    fun ethShort(wei: BigInteger, decimals: Int = 6): String =
        BigDecimal(wei).divide(BigDecimal(WEI_PER_ETH)).setScale(decimals, RoundingMode.DOWN)
            .stripTrailingZeros().toPlainString()

    /** "0xAbC…" or "abc…" -> 40 lowercase hex chars, or null if not a 20-byte hex address. */
    fun normalize40(addr: String): String? {
        val s = addr.trim().removePrefix("0x").removePrefix("0X")
        return if (s.length == 40 && Bytes.isHex(s)) s.lowercase() else null
    }

    /**
     * Validates an address typed or scanned by the user. All-lowercase or all-uppercase is accepted
     * (no checksum); mixed case must be a correct EIP-55 checksum, so a typo in a checksummed address is caught.
     */
    fun validateAddress(addr: String): AddressCheck {
        val raw = addr.trim().removePrefix("0x").removePrefix("0X")
        val n = normalize40(addr) ?: return AddressCheck(false, null, "not a 0x + 40 hex address")
        val mixed = raw.any { it in 'a'..'f' } && raw.any { it in 'A'..'F' }
        if (mixed && checksum(n) != "0x$raw") return AddressCheck(false, null, "EIP-55 checksum mismatch (typo?)")
        if (n == "0".repeat(40)) return AddressCheck(false, null, "zero address")
        return AddressCheck(true, n, if (mixed) "checksum ok" else "no checksum (lower/upper case)")
    }

    data class AddressCheck(val ok: Boolean, val addr40: String?, val note: String)

    /** EIP-55 mixed-case checksum encoding of a 40-hex address. */
    fun checksum(addr40: String): String {
        val a = addr40.lowercase().removePrefix("0x")
        val h = Keccak256.hex(a.toByteArray(Charsets.US_ASCII))
        val sb = StringBuilder("0x")
        for (i in a.indices) {
            val c = a[i]
            sb.append(if (c in 'a'..'f' && Character.digit(h[i], 16) >= 8) c.uppercaseChar() else c)
        }
        return sb.toString()
    }

    /**
     * Parses the website's depositor QR: EIP-681 `ethereum:0xADDR@11155111` (optionally `ethereum:pay-0x…`,
     * extra path/query ignored), or a bare address. Returns null if no valid address is present.
     */
    fun parseEip681(text: String): Eip681? {
        val t = text.trim()
        if (!t.startsWith("ethereum:", ignoreCase = true)) {
            val c = validateAddress(t)
            return if (c.ok) Eip681(c.addr40!!, null) else null
        }
        var rest = t.substring("ethereum:".length)
        if (rest.startsWith("pay-", ignoreCase = true)) rest = rest.substring(4)
        val target = rest.split('/', '?')[0]
        val parts = target.split('@')
        val c = validateAddress(parts[0])
        if (!c.ok) return null
        val chain = parts.getOrNull(1)?.let { it.toLongOrNull() ?: return null }
        return Eip681(c.addr40!!, chain)
    }

    data class Eip681(val addr40: String, val chainId: Long?)
}
