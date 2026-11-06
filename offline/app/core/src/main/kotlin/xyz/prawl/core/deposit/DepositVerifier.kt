package xyz.prawl.core.deposit

import kotlinx.serialization.json.JsonObject
import xyz.prawl.core.model.Bundle
import xyz.prawl.core.model.CoinHeader
import xyz.prawl.core.util.Bytes
import xyz.prawl.core.util.Eth
import xyz.prawl.core.util.Keccak256
import xyz.prawl.core.util.arr
import xyz.prawl.core.util.long
import xyz.prawl.core.util.objects
import xyz.prawl.core.util.obj
import xyz.prawl.core.util.optObj
import xyz.prawl.core.util.optStr
import xyz.prawl.core.util.str
import java.math.BigInteger
import java.security.PublicKey
import java.security.interfaces.ECPublicKey

/** Outcome of the "is this coin backed by a real deposit" check (accept step [1]). */
data class DepositCheck(val backed: Boolean, val source: String, val detail: String)

/**
 * Checks, offline, that a coin is backed by an on-chain escrow deposit.
 *
 * Implementations:
 *  - [SnapshotDepositVerifier]: the harness's laptop-built snapshot (coinId, value, expiry, k0 hash).
 *  - [CommitmentSnapshotDepositVerifier]: escrow commitments synced while online (deposits[coinId]).
 *  - [LightClientDepositVerifier]: the Ethereum light-client DepositProof carried in the bundle (`depositProof`),
 *    verified by raw/v3/deposit_proofs' DepositProof.java behind [DepositProofBackend] (see [LightClient]).
 *
 * [genesisKey] is the public key of the ATTESTED genesis leaf certificate (null if it could not be parsed);
 * [k0Hash] its SPKI SHA-256.
 */
interface DepositVerifier {
    val name: String
    fun check(header: CoinHeader, genesisKey: PublicKey?, k0Hash: String?, bundle: Bundle, nowS: Long): DepositCheck
}

/** Deposit commitment exactly as the escrow stores it (`PrawlEscrowV3.commitment`). */
object DepositCommitment {
    fun abiWord(v: BigInteger): ByteArray = Bytes.fixed(v, 32)

    /** keccak256(abi.encode(uint256 value, uint64 expiry, uint256 k0x, uint256 k0y, address depositor)). */
    fun commitment(value: BigInteger, expiry: Long, k0x: BigInteger, k0y: BigInteger, depositor40: String): ByteArray =
        Keccak256.hash(abiWord(value) + abiWord(BigInteger.valueOf(expiry)) + abiWord(k0x) + abiWord(k0y) +
            abiWord(BigInteger(depositor40.lowercase().removePrefix("0x"), 16)))

    fun commitment(h: CoinHeader): ByteArray = commitment(h.value, h.expiry,
        BigInteger(requireNotNull(h.k0x) { "header has no k0x" }, 16), BigInteger(requireNotNull(h.k0y) { "header has no k0y" }, 16), h.depositor)

    /** Storage key of `deposits[coinId]` (mapping at slot 0): keccak256(abi.encode(coinId, uint256(0))). */
    fun storageKey(coinIdHex: String): ByteArray = Keccak256.hash(Bytes.unhex(coinIdHex) + ByteArray(32))

    /** True if the header's (k0x, k0y) is the attested genesis key. */
    fun headerKeyMatches(h: CoinHeader, key: PublicKey?): Boolean {
        val w = (key as? ECPublicKey)?.w ?: return false
        val x = h.k0x?.let { runCatching { BigInteger(it, 16) }.getOrNull() } ?: return false
        val y = h.k0y?.let { runCatching { BigInteger(it, 16) }.getOrNull() } ?: return false
        return x == w.affineX && y == w.affineY
    }
}

/**
 * The harness snapshot format `{"deposits":[{"coinId","value","expiry","k0"}]}` (built by `snapshot3` in
 * w3_lib.sh from mint files). Matching rule identical to `Wallet3Activity.accept3` step [1].
 */
class SnapshotDepositVerifier(private val snapshot: JsonObject, override val name: String = "synced snapshot") : DepositVerifier {
    override fun check(header: CoinHeader, genesisKey: PublicKey?, k0Hash: String?, bundle: Bundle, nowS: Long): DepositCheck {
        if (k0Hash == null) return DepositCheck(false, name, "genesis key unreadable")
        val hit = snapshot.arr("deposits").objects().any { d ->
            d.str("coinId") == header.coinId && d.str("value") == header.value.toString() &&
                d.long("expiry") == header.expiry && d.str("k0") == k0Hash
        }
        return DepositCheck(hit, name, if (hit) "deposit listed in the synced snapshot" else "coin not in the synced snapshot")
    }
}

/**
 * Escrow commitments synced while online, e.g. from `Deposited` events or `deposits(coinId)` reads made by the
 * wallet over its private RPC:
 * `{"v":1,"t":"deposits","chainId":11155111,"escrow":"0x…","block":N,"syncedAt":unix,"commitments":{"0x<coinId>":"0x<bytes32>"}}`.
 *
 * Recomputes `keccak256(abi.encode(value, expiry, k0x, k0y, depositor))` from the coin header and requires
 * the header's (k0x, k0y) to be the attested genesis key, so the commitment binds the hardware key.
 */
class CommitmentSnapshotDepositVerifier(private val snap: JsonObject, override val name: String = "synced escrow commitments") : DepositVerifier {
    val chainId: String = snap.str("chainId")
    val escrow40: String = Eth.normalize40(snap.str("escrow")) ?: throw IllegalArgumentException("bad escrow")
    val syncedAt: Long? = snap.optStr("syncedAt")?.toLongOrNull()
    private val commitments: Map<String, String> = snap.obj("commitments").mapKeys { it.key.lowercase().removePrefix("0x") }
        .mapValues { (it.value as? kotlinx.serialization.json.JsonPrimitive)?.content?.lowercase()?.removePrefix("0x") ?: "" }

    val size: Int get() = commitments.size

    override fun check(header: CoinHeader, genesisKey: PublicKey?, k0Hash: String?, bundle: Bundle, nowS: Long): DepositCheck {
        if (header.chainId != chainId || Eth.normalize40(header.escrow) != escrow40)
            return DepositCheck(false, name, "coin is for another escrow/chain")
        val stored = commitments[header.coinId.lowercase()] ?: return DepositCheck(false, name, "coin not among the synced deposits")
        if (!DepositCommitment.headerKeyMatches(header, genesisKey)) return DepositCheck(false, name, "header key is not the attested genesis key")
        val mine = runCatching { Bytes.hex(DepositCommitment.commitment(header)) }.getOrNull()
            ?: return DepositCheck(false, name, "header fields malformed")
        val ok = mine == stored
        return DepositCheck(ok, name, if (ok) "matches escrow deposits[coinId]" else "header does not match the on-chain commitment")
    }
}

/**
 * Pluggable light-client backend. The Java verifier in raw/v3/deposit_proofs/java (`DepositProof.verify(cache,
 * proofJson, address, storageKey, expectedValue, nowUnix)`) fits behind this interface once its sync-committee
 * cache is persisted by the app.
 */
interface DepositProofBackend {
    /** Verifies that storage slot [storageKey] of [escrow] holds [expectedValue] at a finalized block. */
    fun verifyStorage(proofJson: String, escrow: ByteArray, storageKey: ByteArray, expectedValue: ByteArray, nowS: Long): DepositCheck
}

/**
 * Deposit check from a light-client proof carried with the coin (`header.depositProof` or bundle
 * `depositProof`). The backend is [LightClient.backend] (sync-committee cache + DepositProof.verify). Without a proof,
 * or if it fails (e.g. the recipient's committee cache is too old), the composite falls back to synced snapshots.
 */
class LightClientDepositVerifier(
    private val backend: DepositProofBackend?,
    /**
     * (chainId, escrow40) pairs whose storage is trusted. A proof only shows what some contract stores, so the
     * contract must be the real escrow: anyone can deploy a look-alike whose storage says anything.
     */
    private val trustedEscrows: Set<Pair<String, String>> = xyz.prawl.core.protocol.Escrows.PRODUCT,
    /** Called with (coinId, proof JSON) after a proof verified, so the holder can forward it with the coin. */
    private val onVerified: ((String, String) -> Unit)? = null,
) : DepositVerifier {
    override val name = "light-client deposit proof"
    override fun check(header: CoinHeader, genesisKey: PublicKey?, k0Hash: String?, bundle: Bundle, nowS: Long): DepositCheck {
        val proof = header.json.optObj("depositProof") ?: bundle.json.optObj("depositProof")
            ?: return DepositCheck(false, name, "no proof carried")
        if ((header.chainId to header.escrow.lowercase().removePrefix("0x")) !in trustedEscrows)
            return DepositCheck(false, name, "proof is about escrow 0x${header.escrow} on chain ${header.chainId}, not the trusted escrow")
        val be = backend ?: return DepositCheck(false, name, "light-client verifier not installed")
        if (!DepositCommitment.headerKeyMatches(header, genesisKey)) return DepositCheck(false, name, "header key is not the attested genesis key")
        val expected = runCatching { DepositCommitment.commitment(header) }.getOrNull()
            ?: return DepositCheck(false, name, "header fields malformed")
        val r = be.verifyStorage(proof.toString(), Bytes.unhex(header.escrow), DepositCommitment.storageKey(header.coinId), expected, nowS)
        if (r.backed) onVerified?.let { cb -> runCatching { cb(header.coinId, proof.toString()) } }
        return r
    }
}

const val SEPOLIA_CHAIN_ID = "11155111"
const val SEPOLIA_ESCROW_V3 = "70b3b7edcd18087c999ec80e3c3b0227c7e0d6e5"
const val SEPOLIA_ESCROW_V31 = "236b1dc3b1a90e23728da6e361b0ab1c386cd779"

/** Backed if any source vouches for the coin. */
class CompositeDepositVerifier(private val sources: List<DepositVerifier>) : DepositVerifier {
    override val name = "deposit sources"
    override fun check(header: CoinHeader, genesisKey: PublicKey?, k0Hash: String?, bundle: Bundle, nowS: Long): DepositCheck {
        if (sources.isEmpty()) return DepositCheck(false, name, "no deposit data synced yet (sync while online)")
        val results = sources.map { runCatching { it.check(header, genesisKey, k0Hash, bundle, nowS) }
            .getOrElse { e -> DepositCheck(false, it.name, "error: ${e.message}") } }
        results.firstOrNull { it.backed }?.let { return it }
        return DepositCheck(false, name, results.joinToString("; ") { "${it.source}: ${it.detail}" })
    }
}
