package xyz.prawl.core.protocol

import xyz.prawl.core.attest.AttestationResult
import xyz.prawl.core.attest.ChainChecker
import xyz.prawl.core.certs.CertStore
import xyz.prawl.core.certs.CertResolver
import xyz.prawl.core.deposit.DepositCommitment
import xyz.prawl.core.deposit.DepositVerifier
import xyz.prawl.core.model.Bundle
import xyz.prawl.core.util.Bytes
import xyz.prawl.core.util.Eth
import java.math.BigInteger
import java.security.PublicKey
import java.security.Signature

/** One human-readable verification line ("[3.1] spend 2 of 2: …"). */
data class VerifyLine(val step: String, val title: String, val ok: Boolean, val detail: String)

class VerificationReport(val payeeName: String) {
    val lines = ArrayList<VerifyLine>()
    val fails = ArrayList<String>()
    /** Value of the note received (the output the path ends in). */
    var receivedValue: BigInteger = BigInteger.ZERO
    var noteId: String? = null
    var lastKeyHash: String? = null
    var hops = 0
    var coinLabel = "coin"
    var coinId = ""
    var depositValue: BigInteger = BigInteger.ZERO
    var expiry = 0L
    var capWei: BigInteger = BigInteger.ZERO
    var revocationStale = false
    var ms = 0L
    /** The amount the payee asked for (null if none). A smaller payment is accepted but [shortfall] is set (audit F-10). */
    var requestedWei: BigInteger? = null
    val shortfall: Boolean get() = requestedWei?.let { receivedValue < it } ?: false
    val accepted: Boolean get() = fails.isEmpty()
}

/**
 * Recipient-side verification of a v3 bundle: `Wallet3Activity.accept3` with the same checks and failure texts,
 * plus three tightenings (each only rejects more):
 *  - header.v must be 3;
 *  - the header's (k0x, k0y) must be the attested genesis key (the escrow verifies spends with k0x/k0y, so a
 *    mismatch would make the note unredeemable even though every phone check passed);
 *  - an optional escrow allowlist ([RecipientPolicy.acceptedEscrows]).
 * A missing certificate becomes a failed line instead of aborting.
 */
class PaymentVerifier(
    private val certs: CertResolver,
    private val attest: ChainChecker,
    private val deposits: DepositVerifier,
    private val policy: RecipientPolicy,
    private val revocationFetchedAt: Long,
    private val log: (String) -> Unit = {},
) {
    fun verify(b: Bundle, payeeName: String, myKeyHash: String?, nowS: Long): VerificationReport {
        val t0 = System.nanoTime()
        val rep = VerificationReport(payeeName)
        fun line(step: String, title: String, ok: Boolean, detail: String, fail: String?) {
            rep.lines.add(VerifyLine(step, title, ok, detail))
            if (!ok && fail != null) rep.fails.add(fail)
        }
        try {
            verifyInto(b, myKeyHash, nowS, rep, ::line)
        } catch (e: Exception) {
            line("!", "Bundle readable", false, e.message ?: e.toString(), "malformed bundle: ${e.message}")
        }
        rep.ms = (System.nanoTime() - t0) / 1_000_000
        return rep
    }

    private fun verifyInto(
        b: Bundle, myKeyHash: String?, nowS: Long, rep: VerificationReport,
        line: (String, String, Boolean, String, String?) -> Unit,
    ) {
        // Every limit is checked on the RAW JSON before anything is parsed into numbers or any cryptography runs (audit F-07): the
        // hostile bundle's work is bounded by its size, not by what it claims.
        val records = Canonical.spendRecords(b)
        val hdrJson = b.json["header"] as? kotlinx.serialization.json.JsonObject
        if (records == null || hdrJson == null) { line("0", "Bundle structure", false, "the header or the path is malformed", "malformed bundle"); return }
        // [0a] hop limit first: the path length is attacker-chosen
        if (records.size > policy.maxHops) {
            line("0", "Offline hops", false, "${records.size} of max ${policy.maxHops}", "too many offline hops (${records.size} > ${policy.maxHops})"); return
        }
        // [0b] attestation-chain lengths (real chains have 4-5 certificates)
        val chains = Canonical.chainProblems(hdrJson, records)
        line("0", "Certificate chains (at most ${CertStore.MAX_CHAIN} each)", chains.isEmpty(), chains.firstOrNull() ?: "within limits", chains.firstOrNull())
        if (chains.isNotEmpty()) return
        // [0c] audit F-02: bound the redeemability of every spend BEFORE touching its outputs
        val counts = Canonical.outputCountProblems(records)
        line("0", "Outputs per spend (at most ${Protocol.MAX_OUTPUTS})", counts.isEmpty(),
            if (counts.isEmpty()) records.joinToString(", ") { ((it["outputs"] as kotlinx.serialization.json.JsonArray).size).toString() }.ifEmpty { "no spends" } else counts.first(),
            counts.firstOrNull())
        counts.drop(1).forEach { rep.fails.add(it) }
        if (counts.isNotEmpty()) return
        // [0d] audit F-01: every string that goes into a signed message is in the one form the escrow can rebuild (this also caps every
        // number at 78 digits, so no quadratic BigInteger parse of a hostile decimal can happen below)
        val canon = Canonical.headerProblems(hdrJson) + Canonical.pathProblems(records, includeCounts = false)
        line("0", "Canonical text", canon.isEmpty(),
            if (canon.isEmpty()) "every string in the signed messages is the form the escrow rebuilds" else canon.first(),
            canon.firstOrNull()?.let { "non-canonical text in the signed message: $it" })
        canon.drop(1).take(4).forEach { rep.fails.add("non-canonical text in the signed message: $it") }
        if (canon.isNotEmpty()) return

        val h = b.header
        val carried = b.certs
        val path = b.path
        rep.coinLabel = h.label; rep.coinId = h.coinId; rep.depositValue = h.value; rep.expiry = h.expiry; rep.hops = path.size
        log("ACCEPT? coin ${h.coinId.take(16)}… (${Eth.eth(h.value)} ETH deposit), ${path.size} spend(s), as '${rep.payeeName}'")

        // [0] coin-level policy
        line("0", "Coin format", h.v == 3, "v=${h.v}", "not a v3 coin")
        policy.acceptedEscrows?.let { set ->
            val ok = set.contains(h.chainId to h.escrow.lowercase())
            line("0", "Escrow", ok, "chain ${h.chainId}, escrow 0x${h.escrow}", "coin is for an escrow this wallet does not accept")
        }
        line("0", "Offline hops", path.size <= policy.maxHops, "${path.size} of max ${policy.maxHops}",
            "too many offline hops (${path.size} > ${policy.maxHops})")
        val left = h.expiry - nowS
        line("0", "Lifetime left", left >= policy.minRemainingS, "${fmtDuration(left)} left (need ${fmtDuration(policy.minRemainingS)})",
            "coin expired or about to expire")

        // [1] deposit backing (snapshot / commitments now; light-client DepositProof when integrated)
        val k0Ids = h.k0
        val k0Key: PublicKey? = runCatching { certs.leafKey(k0Ids, carried) }.getOrNull()
        val k0Hash = k0Key?.let { Bytes.sha256Hex(it.encoded) }
        val dep = deposits.check(h, k0Key, k0Hash, b, nowS)
        log("  [1] deposit backing: " + if (dep.backed) "yes (${dep.source})" else "NO (${dep.detail})")
        line("1", "Backed by an on-chain deposit", dep.backed, "${dep.source}: ${dep.detail}", "not backed by a known deposit")
        val keyMatch = DepositCommitment.headerKeyMatches(h, k0Key)
        line("1", "Header key = attested genesis key", keyMatch, if (keyMatch) "k0x/k0y match the certificate" else "k0x/k0y differ from the genesis certificate",
            "header k0x/k0y are not the attested genesis key")

        // [2] genesis key attestation
        val r = attestChain(k0Ids, carried)
        log("  [2] genesis key: " + r.summary())
        line("2", "Genesis key is a hardware one-time key", r.ok, attestDetail(r), "genesis key fails policy")

        // [3] spends along the path
        var signer: PublicKey? = r.leafKey
        var noteValue = h.value
        var noteId = Protocol.genesisNoteId(h.coinId)
        var lastKey: String? = null
        for ((d, s) in path.withIndex()) {
            val outs = s.outputs
            val idx = s.index
            val pos = outs.all { it.value.signum() > 0 }
            val sum = outs.fold(BigInteger.ZERO) { a, o -> a + o.value }
            val conserve = pos && sum == noteValue
            var sigOk = false
            if (signer != null) {
                sigOk = try {
                    val sg = Signature.getInstance("SHA256withECDSA")
                    sg.initVerify(signer)
                    sg.update(Protocol.spendMessage(h, d, noteId, outs))
                    sg.verify(Bytes.unb64(s.sig))
                } catch (e: Exception) { false }
            }
            val rn = attestChain(s.next, carried)
            val linked = rn.leafKeyHash != null && idx >= 0 && idx < outs.size && outs[idx].key == rn.leafKeyHash
            val od = outs.withIndex().joinToString(" + ") { (i, o) -> if (i == idx) "[" + Eth.eth(o.value) + "]" else Eth.eth(o.value) }
            log("  [3.$d] spend of ${Eth.eth(noteValue)} ETH -> $od: signature ${if (sigOk) "valid" else "INVALID"}, conservation " +
                (if (conserve) "ok" else "BROKEN") + ", output→key " + (if (linked) "ok" else "MISMATCH") + "; next key " + rn.summary())
            val st = "3.$d"
            line(st, "Spend ${d + 1}: signature", sigOk, "by the one-time key of the ${Eth.eth(noteValue)} ETH note", "spend $d signature invalid")
            line(st, "Spend ${d + 1}: value conserved", conserve, "$od ETH", "spend $d does not conserve value")
            line(st, "Spend ${d + 1}: output bound to next key", linked, "output #$idx pays the next key", "spend $d output not bound to the next key")
            line(st, "Spend ${d + 1}: next key is a hardware one-time key", rn.ok, attestDetail(rn), "spend $d next key fails policy")
            if (idx >= 0 && idx < outs.size) noteValue = outs[idx].value
            noteId = Protocol.childNoteId(s.sig, idx)
            signer = rn.leafKey; lastKey = rn.leafKeyHash
        }

        // [4] cap on what I receive, and it must pay my pending receive key
        rep.revocationStale = policy.isStale(nowS, revocationFetchedAt)
        val cap = policy.effectiveCap(nowS, revocationFetchedAt)
        rep.capWei = cap
        line("4", "Within offline cap", noteValue <= cap,
            "${Eth.eth(noteValue)} ETH ≤ ${Eth.eth(cap)} ETH" + if (rep.revocationStale) " (revocation list stale: reduced cap)" else "",
            "received value above offline cap ${Eth.eth(cap)}")
        val toMe = path.isNotEmpty() && myKeyHash != null && myKeyHash == lastKey
        log("  [4] receives ${Eth.eth(noteValue)} ETH (cap ${Eth.eth(cap)}) on my key recv_${rep.payeeName}: " + if (toMe) "yes" else "NO")
        line("4", "Pays my one-time receive key", toMe, "recv_${rep.payeeName}", "not addressed to me")
        rep.receivedValue = noteValue; rep.noteId = noteId; rep.lastKeyHash = lastKey
    }

    private fun attestChain(ids: List<String>, carried: kotlinx.serialization.json.JsonObject?): AttestationResult =
        try { attest.verify(certs.chain(ids, carried)) } catch (e: Exception) {
            AttestationResult().apply { fails.add(e.message ?: "certificate missing") }
        }

    companion object {
        fun attestDetail(r: AttestationResult): String =
            if (r.ok) "${r.level}, " + (if (r.rkp) "RKP" else "factory") + " chain, patch ${r.patch}" + (if (r.authPerUse) ", owner approval per spend" else "")
            else r.fails.joinToString("; ")

        fun fmtDuration(s: Long): String = when {
            s < 0 -> "expired"
            s < 3600 -> "${s / 60} min"
            s < 2 * 86400 -> "${s / 3600} h"
            else -> "${s / 86400} d"
        }
    }
}
