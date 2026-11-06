package xyz.prawl.core.util

/**
 * Ethereum Keccak-256 (original Keccak padding 0x01, not SHA3-256's 0x06).
 * Used for EIP-55 address checksums and for the escrow's deposit commitment
 * `keccak256(abi.encode(value, expiry, k0x, k0y, depositor))`.
 */
object Keccak256 {
    private val RC = longArrayOf(
        0x0000000000000001uL.toLong(),
        0x0000000000008082uL.toLong(),
        0x800000000000808AuL.toLong(),
        0x8000000080008000uL.toLong(),
        0x000000000000808BuL.toLong(),
        0x0000000080000001uL.toLong(),
        0x8000000080008081uL.toLong(),
        0x8000000000008009uL.toLong(),
        0x000000000000008AuL.toLong(),
        0x0000000000000088uL.toLong(),
        0x0000000080008009uL.toLong(),
        0x000000008000000AuL.toLong(),
        0x000000008000808BuL.toLong(),
        0x800000000000008BuL.toLong(),
        0x8000000000008089uL.toLong(),
        0x8000000000008003uL.toLong(),
        0x8000000000008002uL.toLong(),
        0x8000000000000080uL.toLong(),
        0x000000000000800AuL.toLong(),
        0x800000008000000AuL.toLong(),
        0x8000000080008081uL.toLong(),
        0x8000000000008080uL.toLong(),
        0x0000000080000001uL.toLong(),
        0x8000000080008008uL.toLong(),
    )
    private val ROT = intArrayOf(
        0, 1, 62, 28, 27,
        36, 44, 6, 55, 20,
        3, 10, 43, 25, 39,
        41, 45, 15, 21, 8,
        18, 2, 61, 56, 14,
    )
    private const val RATE = 136

    fun hash(input: ByteArray): ByteArray {
        val s = LongArray(25)
        val padded = run {
            val n = input.size / RATE + 1
            val p = ByteArray(n * RATE)
            System.arraycopy(input, 0, p, 0, input.size)
            p[input.size] = (p[input.size].toInt() xor 0x01).toByte()
            p[p.size - 1] = (p[p.size - 1].toInt() xor 0x80).toByte()
            p
        }
        var off = 0
        while (off < padded.size) {
            for (i in 0 until RATE / 8) {
                var lane = 0L
                for (b in 0 until 8) lane = lane or ((padded[off + 8 * i + b].toLong() and 0xff) shl (8 * b))
                s[i] = s[i] xor lane
            }
            permute(s)
            off += RATE
        }
        val out = ByteArray(32)
        for (i in 0 until 4) for (b in 0 until 8) out[8 * i + b] = (s[i] ushr (8 * b)).toByte()
        return out
    }

    fun hex(input: ByteArray): String = Bytes.hex(hash(input))

    private fun permute(a: LongArray) {
        val c = LongArray(5); val b = LongArray(25)
        for (round in 0 until 24) {
            for (x in 0 until 5) c[x] = a[x] xor a[x + 5] xor a[x + 10] xor a[x + 15] xor a[x + 20]
            for (x in 0 until 5) {
                val d = c[(x + 4) % 5] xor java.lang.Long.rotateLeft(c[(x + 1) % 5], 1)
                for (y in 0 until 5) a[x + 5 * y] = a[x + 5 * y] xor d
            }
            for (x in 0 until 5) for (y in 0 until 5) {
                b[y + 5 * ((2 * x + 3 * y) % 5)] = java.lang.Long.rotateLeft(a[x + 5 * y], ROT[x + 5 * y])
            }
            for (x in 0 until 5) for (y in 0 until 5) {
                a[x + 5 * y] = b[x + 5 * y] xor (b[(x + 1) % 5 + 5 * y].inv() and b[(x + 2) % 5 + 5 * y])
            }
            a[0] = a[0] xor RC[round]
        }
    }
}
