package xyz.prawl.core.protocol

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import xyz.prawl.core.attest.AttestationResult
import xyz.prawl.core.attest.ChainChecker
import xyz.prawl.core.attest.TrustAnchors
import xyz.prawl.core.certs.CertResolver
import xyz.prawl.core.certs.CertStore
import xyz.prawl.core.deposit.DepositVerifier
import xyz.prawl.core.handoff.Handoff
import xyz.prawl.core.keys.ApprovalPrompt
import xyz.prawl.core.keys.KeyRefusedException
import xyz.prawl.core.keys.KeySpec
import xyz.prawl.core.keys.KeyVault
import xyz.prawl.core.keys.SpendApprover
import xyz.prawl.core.model.Bundle
import xyz.prawl.core.model.Note
import xyz.prawl.core.model.Output
import xyz.prawl.core.model.ReceiveRequest
import xyz.prawl.core.store.NoteStore
import xyz.prawl.core.util.Bytes
import xyz.prawl.core.util.Eth
import xyz.prawl.core.util.Js
import xyz.prawl.core.util.arr
import xyz.prawl.core.util.jsonArrayOf
import xyz.prawl.core.util.optStr
import xyz.prawl.core.util.str
import xyz.prawl.core.util.strings
import xyz.prawl.core.util.with
import xyz.prawl.core.util.without
import java.math.BigInteger
import java.security.SecureRandom
import java.security.interfaces.ECPublicKey
import java.util.zip.Deflater

/**
 * The v3 wallet: mint, receive request, pay (split + change), accept, redeem. A port of Wallet3Activity
 * (which extends Wallet2Activity) onto interfaces, so the same logic drives the screens, the debug harness
 * mode, and the JVM tests. Wire formats and file formats are unchanged.
 *
 * Safety rules kept from the harness:
 *  - the payee's key is checked (attestation policy) BEFORE the payer signs;
 *  - the signed spend is persisted before it is sent; a retry to the same recipient key resends the same bytes;
 *  - a pending receive key is reused until a payment to it is accepted;
 *  - the secure hardware refuses a second signature; a malicious-wallet re-spend fails there.
 * Added (each only refuses more): no reuse of a label/name that still holds value; a receive key accepts only
 * one note; optional payer pre-checks (hop limit, lifetime) so a key is never burnt on a payment the payee must reject.
 */
class OfflineWallet(
    val keys: KeyVault,
    val notes: NoteStore,
    val certStore: CertStore,
    val anchors: TrustAnchors,
    val checker: ChainChecker,
    val policy: () -> RecipientPolicy,
    val deposits: () -> DepositVerifier,
    /** Owner approval for keys created from now on (the "owner approval per spend" setting). */
    val ownerApprovalForNewKeys: () -> Boolean = { false },
    val nowMillis: () -> Long = System::currentTimeMillis,
    val log: (String) -> Unit = {},
    /** Shared by every wallet instance over the same stores, so two spends never interleave. */
    private val lock: Any = Any(),
    /**
     * Light-client DepositProof to forward with a coin (bundle field `depositProof`), prepared for the recipient's
     * advertised committee range (request field `lc`); null if none is held.
     */
    val depositProofFor: (coinId: String, recipientLc: JsonObject?) -> JsonObject? = { _, _ -> null },
    /** This phone's committee range, advertised in receive requests (`lc`: {"min","max"}), or null. */
    val lcAdvertisement: () -> JsonObject? = { null },
) {
    val certs = CertResolver(certStore, anchors)
    private val rnd = SecureRandom()

    private fun nowS() = nowMillis() / 1000

    /** [base], or [base] + random suffix if that alias is taken: never replace a key that may hold value. */
    private fun freshAlias(base: String): String {
        var a = base
        while (keys.exists(a) || notes.note(a) != null) a = base + "_" + Bytes.hex(ByteArray(3).also { rnd.nextBytes(it) })
        return a
    }

    private fun newKey(alias: String, spec: KeySpec): JsonArray {
        val t0 = System.nanoTime()
        val chain = keys.create(alias, spec)
        val ids = chain.map { certStore.put(it) }
        log("new key $alias" + (if (keys.strongBoxAvailable) " [StrongBox]" else " [TEE]") +
            (if (spec.singleUse) " single-use" else " MULTI-USE (cheat)") + (if (spec.userAuthPerUse) " +auth-per-spend" else "") +
            " in ${(System.nanoTime() - t0) / 1_000_000} ms")
        return jsonArrayOf(ids)
    }

    // ================================================================ mint

    class MintResult(val header: JsonObject, val mintFile: JsonObject, val note: Note) {
        /** HANDOFF.md `load` payload for the website. */
        val handoff: JsonObject get() = Handoff.load(mintFile)
    }

    fun mint(
        label: String, valueWei: BigInteger, expiresInS: Long, chainId: String, escrow: String, depositor: String,
        spec: KeySpec = KeySpec(userAuthPerUse = ownerApprovalForNewKeys()), pendingDeposit: Boolean = false,
    ): MintResult = synchronized(lock) {
        require(valueWei.signum() > 0) { "value must be positive" }
        val escrow40 = Eth.normalize40(escrow) ?: throw IllegalArgumentException("escrow is not an address")
        val dep40 = Eth.normalize40(depositor) ?: throw IllegalArgumentException("depositor is not an address")
        val alias = "n_${label}_g"
        notes.note(alias)?.let { if (!it.spent) throw IllegalStateException("label '$label' already holds an unspent coin") }
        val id = ByteArray(32).also { rnd.nextBytes(it) }
        val c0 = newKey(alias, spec)
        val k0 = certs.leafKey(c0.strings()) as ECPublicKey
        val now = nowS()
        val h = buildJsonObject {
            put("v", 3); put("label", label); put("coinId", Bytes.hex(id)); put("chainId", chainId); put("escrow", escrow40)
            put("expiry", now + expiresInS); put("value", valueWei.toString()); put("k0", c0)
            put("k0x", k0.w.affineX.toString(16)); put("k0y", k0.w.affineY.toString(16)); put("depositor", dep40)
        }
        var noteJson = buildJsonObject {
            put("header", h); put("path", JsonArray(emptyList())); put("alias", alias); put("value", valueWei.toString())
            put("noteId", Protocol.genesisNoteId(Bytes.hex(id)))
        }
        if (pendingDeposit) noteJson = noteJson.with("pendingDeposit", true).with("createdAt", now)
        val note = Note(noteJson)
        notes.put(note)
        val certsJson = buildJsonObject { c0.strings().forEach { put(it, Bytes.b64(certs.get(it))) } }
        val mintFile = h.with("certs", certsJson)
        log("MINTED $label = ${Eth.eth(valueWei)} ETH, coinId ${Bytes.hex(id).take(16)}…, genesis key $alias")
        MintResult(h, mintFile, note)
    }

    /** The wallet confirmed the deposit: the coin becomes spendable on this phone. */
    fun markDeposited(alias: String, txHash: String? = null) = synchronized(lock) {
        val n = notes.note(alias) ?: throw IllegalArgumentException("no note $alias")
        var j = n.json.without("pendingDeposit").with("depositedAt", nowS())
        if (txHash != null) j = j.with("depositTx", txHash)
        notes.put(Note(j))
    }

    /** Cancels a coin that was never deposited: deletes the genesis key and the note. */
    fun discardUndeposited(alias: String) = synchronized(lock) {
        val n = notes.note(alias) ?: return@synchronized
        require(n.pendingDeposit) { "only an undeposited coin can be discarded" }
        keys.delete(alias)
        notes.put(Note(n.json.with("spent", true).with("discarded", true)))
    }

    // ================================================================ request

    fun request(name: String, spec: KeySpec = KeySpec(userAuthPerUse = ownerApprovalForNewKeys())): ReceiveRequest = synchronized(lock) {
        val alias = "recv_$name"
        pruneAccepted()
        val pend = notes.pendingChain(name)
        val acc = notes.accepted(name)
        val c: JsonArray
        if (pend != null) {
            c = pend.arr("chain")
            log("reusing pending receive key $alias (retry of an interrupted payment)")
        } else if (acc != null) {
            // payment already accepted on this key: present the SAME key again so a payer whose verdict was lost can
            // resend the identical signed bytes (the accept below answers ACCEPTED idempotently)
            c = acc.arr("chain")
            log("receive key $alias already accepted a payment: re-presenting it for the payer's resend")
        } else {
            notes.note(alias)?.let { if (!it.spent) throw IllegalStateException("receive name '$name' already holds a note") }
            c = newKey(alias, spec)
            notes.putPending(name, buildJsonObject { put("chain", c) })
        }
        val roots = certs.rootIds
        val certsJson = buildJsonObject { c.strings().filter { it !in roots }.forEach { put(it, Bytes.b64(certs.get(it))) } }
        val known = certs.knownReusableIds()
        val lc = runCatching { lcAdvertisement() }.getOrNull()
        val req = buildJsonObject {
            put("name", name); put("chain", c); put("certs", certsJson); put("known", jsonArrayOf(known))
            if (lc != null) put("lc", lc)
        }
        log("REQUEST '$name': key ${certs.leafKeyHash(c.strings()).take(16)}, tells payer it already has ${known.size} certs; ${req.toString().length} B")
        ReceiveRequest(req)
    }

    /** Leaf key hash of a pending receive request (what the QR commits to). */
    fun pendingKeyHash(name: String): String? = keys.publicKey("recv_$name")?.let { Bytes.sha256Hex(it.encoded) }

    /** Abandons a pending receive request (deletes the unused one-time key). */
    fun cancelRequest(name: String) = synchronized(lock) {
        if (notes.note("recv_$name") == null) keys.delete("recv_$name")
        notes.deletePending(name)
    }

    // ================================================================ pay

    sealed class PayOutcome {
        class Paid(val bundle: JsonObject, val amount: BigInteger, val change: BigInteger, val fromAlias: String, val resent: Boolean, val payeeCheck: AttestationResult) : PayOutcome()
        class Refused(val reason: String, val payeeCheck: AttestationResult? = null) : PayOutcome()
    }

    data class PayOptions(
        /** Restrict to notes of this coin label (harness `coin`); null = any coin. */
        val coinLabel: String? = null,
        /** Debug harness: spend this alias even if this wallet's records say it is spent (malicious wallet test). */
        val forceNote: String? = null,
        /** Key hash committed in the payee's QR; the request received over the link must match. */
        val expectedKeyHash: String? = null,
        /** Refuse notes the payee's policy would reject (hop limit, lifetime). */
        val payerPrechecks: Boolean = true,
    )

    fun pay(amount: BigInteger, reqIn: ReceiveRequest, approver: SpendApprover?, opts: PayOptions = PayOptions()): PayOutcome = synchronized(lock) {
        if (amount.signum() <= 0) return PayOutcome.Refused("amount must be positive")
        val req = reqIn.json
        val reqCerts = reqIn.certs
        val to = reqIn.chain
        for (id in to) if (reqCerts.containsKey(id)) certStore.put(certs.get(id, reqCerts))
        val toKey = try { certs.leafKeyHash(to) } catch (e: Exception) { return PayOutcome.Refused("payee request unreadable: ${e.message}") }
        if (opts.expectedKeyHash != null && !opts.expectedKeyHash.equals(toKey, ignoreCase = true)) {
            log("REFUSING TO PAY: the key received over the link is not the one in the payee's QR")
            return PayOutcome.Refused("the payee's key does not match the scanned QR code")
        }
        // Check the payee's key is a genuine hardware one-time key BEFORE spending: paying a software key
        // would let the payee equivocate and freeze the coin's subtree.
        val pr = try { checker.verify(certs.chain(to)) } catch (e: Exception) { AttestationResult().apply { fails.add(e.message ?: "unreadable") } }
        log("  payee key check: " + pr.summary())
        if (!pr.ok) { log("REFUSING TO PAY: payee key is not a hardware one-time key"); return PayOutcome.Refused("payee key is not a hardware one-time key: ${pr.fails.joinToString("; ")}", pr) }
        // retry: a note already signed to this exact key -> resend the same bytes
        if (opts.forceNote == null) for (n in notes.notes()) if (n.signedTo == toKey && n.signedBundle != null) {
            log("RESEND: note ${n.alias} was already signed to this recipient key")
            val b = Bundle(Js.parse(n.signedBundle!!))
            val sp = b.path.last()
            return PayOutcome.Paid(carry(b.json, reqIn), sp.outputs[sp.index].value, BigInteger.ZERO, n.alias, true, pr)
        }
        val note: Note = if (opts.forceNote != null) {
            val n = notes.note(opts.forceNote) ?: return PayOutcome.Refused("no note ${opts.forceNote}")
            log("MALICIOUS WALLET MODE: ignoring own records, re-spending note ${opts.forceNote}" + if (n.spent) " (already spent)" else "")
            Note(n.json.without("spent", "signedTo"))
        } else {
            selectNote(amount, opts)
                ?: run {
                    val what = opts.coinLabel?.let { "of coin $it " } ?: ""
                    log("no unspent note ${what}can pay ${Eth.eth(amount)} ETH")
                    return PayOutcome.Refused("no spendable note ${what}covers ${Eth.eth(amount)} ETH" +
                        if (opts.payerPrechecks) " (notes past the hop limit or too close to expiry are not used)" else "")
                }
        }
        val v = note.value
        if (v < amount) { log("note too small"); return PayOutcome.Refused("note too small") }
        val h = note.header
        val change = v - amount
        val outs = ArrayList<Output>()
        outs.add(Output(amount, toKey))
        var chgAlias: String? = null
        var chgChain: JsonArray? = null
        if (change.signum() > 0) {
            chgAlias = freshAlias("n_${h.label}_c${nowMillis()}")
            chgChain = newKey(chgAlias, KeySpec(userAuthPerUse = ownerApprovalForNewKeys()))
            outs.add(Output(change, certs.leafKeyHash(chgChain.strings())))
        }
        val depth = note.depth
        val msg = Protocol.spendMessage(h, depth, note.noteId, outs)
        log("PAY ${Eth.eth(amount)} ETH of note ${note.alias} (${Eth.eth(v)} ETH, depth $depth) -> '${reqIn.name}'" +
            (if (chgAlias != null) " + change ${Eth.eth(change)} ETH -> own new key $chgAlias" else ""))
        val sig: ByteArray = try {
            keys.sign(note.alias, msg, approver, ApprovalPrompt("Prawl: approve payment", "Pay ${Eth.eth(amount)} ETH offline",
                "Signs this note over once. The secure hardware will not sign it again."))
        } catch (t: Throwable) {
            val m = (t.message ?: t.toString()).lineSequence().first()
            log("REFUSED BY SECURE HARDWARE: $m")
            if (chgAlias != null) keys.delete(chgAlias)
            return PayOutcome.Refused("refused by the secure hardware: $m")
        }
        val sigB64 = Bytes.b64(sig)
        // spend record appended to the path; recipient-facing bundle takes output 0
        val spendTo = buildJsonObject { put("outputs", Output.toJson(outs)); put("index", 0); put("sig", sigB64); put("next", JsonArray(to.map { JsonPrimitive(it) })) }
        val path = JsonArray(note.json.arr("path") + spendTo)
        val bundle = buildJsonObject { put("header", h.json); put("path", path) }
        // persist before sending (retry = same bytes)
        notes.put(Note(note.json.with("spent", true).with("signedTo", toKey).with("signedBundle", bundle.toString())))
        if (chgAlias != null) {
            val spendChg = spendTo.with("index", 1).with("next", chgChain!!)
            val cpath = JsonArray(note.json.arr("path") + spendChg)
            notes.put(Note(buildJsonObject {
                put("header", h.json); put("path", cpath); put("alias", chgAlias); put("value", change.toString())
                put("noteId", Protocol.childNoteId(sigB64, 1))
            }))
        }
        log("SIGNED spend at depth $depth (${sig.size} B sig), ${outs.size} outputs")
        PayOutcome.Paid(carry(bundle, reqIn), amount, change, note.alias, false, pr)
    }

    /**
     * The note [pay] would spend: harness order when a coin is named, otherwise the smallest note that covers the
     * amount (least change). With prechecks, notes the payee's policy would reject are skipped.
     */
    fun selectNote(amount: BigInteger, opts: PayOptions = PayOptions()): Note? {
        val pol = policy()
        val now = nowS()
        val cands = notes.notes().filter { n ->
            !n.spent && !n.pendingDeposit && n.value >= amount && (opts.coinLabel == null || n.label == opts.coinLabel) &&
                (!opts.payerPrechecks || (n.depth + 1 <= pol.maxHops && n.header.expiry - now >= pol.minRemainingS))
        }
        return if (opts.coinLabel != null) cands.firstOrNull() else cands.minByOrNull { it.value }
    }

    /**
     * Attach only certificates the recipient lacks (not pinned roots, not in its "known" list), and for a payment
     * the coin's light-client DepositProof if this phone holds one.
     */
    fun carry(bundle: JsonObject, req: ReceiveRequest?, withDepositProof: Boolean = req != null): JsonObject {
        val skip = HashSet(certs.rootIds)
        req?.known?.let { skip.addAll(it) }
        val b = Bundle(bundle)
        val chains = ArrayList<List<String>>()
        chains.add(b.header.k0)
        b.path.forEach { chains.add(it.next) }
        val seen = LinkedHashSet<String>(); var refs = 0
        val certsJson = buildJsonObject {
            for (c in chains) for (id in c) { refs++; if (seen.add(id) && id !in skip) put(id, Bytes.b64(certs.get(id))) }
        }
        var out = bundle.with("certs", certsJson)
        if (withDepositProof) runCatching { depositProofFor(b.header.coinId, req?.lc) }.getOrNull()?.let { out = out.with("depositProof", it) }
        val js = out.toString()
        log("  bundle ${js.length} B JSON, ${deflated(js)} B deflated; ${b.path.size} spend(s), carries ${certsJson.size} of $refs cert refs" +
            if (out.containsKey("depositProof")) " + deposit proof" else "")
        return out
    }

    // ================================================================ accept

    /** How long an accepted payment stays answerable as ACCEPTED (idempotent accept). */
    val acceptedKeepS = 7 * 86400L

    private fun pruneAccepted() {
        val now = nowS()
        for (n in notes.acceptedNames()) {
            val until = notes.accepted(n)?.optStr("until")?.toLongOrNull() ?: 0
            if (until < now) notes.deleteAccepted(n)
        }
    }

    /** sha256 of the final spend's signature: identifies exactly one payment to one receive key. */
    private fun finalSigHash(b: Bundle): String? =
        runCatching { b.path.lastOrNull()?.let { Bytes.sha256Hex(Bytes.unb64(it.sig)) } }.getOrNull()

    fun accept(bundleJson: JsonObject, name: String): VerificationReport = synchronized(lock) {
        val b = Bundle(bundleJson)
        // idempotent accept: the same payment arriving again after it was accepted (the payer lost our verdict)
        val sigHash = finalSigHash(b)
        val acc = notes.accepted(name)
        if (acc != null && sigHash != null && acc.optStr("sigHash") == sigHash && (acc.optStr("until")?.toLongOrNull() ?: 0) >= nowS()) {
            val rep = VerificationReport(name)
            rep.receivedValue = BigInteger(acc.str("value")); rep.noteId = acc.optStr("noteId")
            rep.coinLabel = b.header.label; rep.coinId = b.header.coinId; rep.hops = b.path.size
            rep.lines.add(VerifyLine("4", "Already accepted", true, "this exact payment was verified and accepted earlier; nothing is credited twice"))
            log("ACCEPTED (again): payment ${sigHash.take(12)}… was already accepted on recv_$name; answering idempotently")
            return rep
        }
        val myHash = keys.publicKey("recv_$name")?.let { Bytes.sha256Hex(it.encoded) }
        val pv = PaymentVerifier(certs, checker, deposits(), policy(), anchors.revocationFetchedAt, log)
        val rep = pv.verify(b, name, myHash, nowS())
        // a receive key holds at most one note (it can sign only once)
        val existing = notes.note("recv_$name")
        if (rep.accepted && existing != null && existing.noteId != rep.noteId) {
            rep.lines.add(VerifyLine("4", "Receive key unused", false, "recv_$name already holds a different note"))
            rep.fails.add("receive key already used")
        }
        if (!rep.accepted) { log("REJECTED in ${rep.ms} ms: ${rep.fails}"); return rep }
        if (existing != null) { log("ACCEPTED (again) in ${rep.ms} ms: retry of a payment already held as recv_$name"); return rep }
        certs.absorb(b.certs)
        val pendingChain = notes.pendingChain(name)
        notes.deletePending(name)
        val h = b.header.json.let { if (it.containsKey("label")) it else it.with("label", "coin") }
        notes.put(Note(buildJsonObject {
            put("header", h); put("path", bundleJson["path"]!!); put("alias", "recv_$name")
            put("value", rep.receivedValue.toString()); put("noteId", rep.noteId!!); put("receivedAt", nowS())
        }))
        if (sigHash != null && pendingChain != null) notes.putAccepted(name, buildJsonObject {
            put("chain", pendingChain.arr("chain")); put("sigHash", sigHash); put("value", rep.receivedValue.toString())
            put("noteId", rep.noteId!!); put("at", nowS()); put("until", nowS() + acceptedKeepS)
        })
        log("ACCEPTED in ${rep.ms} ms: I hold a ${Eth.eth(rep.receivedValue)} ETH note of coin ${b.header.label}, spendable once with recv_$name")
        rep
    }

    // ================================================================ redeem

    sealed class RedeemOutcome {
        class Signed(val bundle: JsonObject, val note: Note) : RedeemOutcome() {
            /** HANDOFF.md `redeem` payload: the exact redeem(Header, Spend[], Redemption) arguments. */
            val handoff: JsonObject get() = Handoff.redeem(bundle, null)
        }
        class Refused(val reason: String) : RedeemOutcome()
    }

    /** Signs a redemption of note [alias] to [payout] (spends the note's one-time key to a PRAWL-REDEEM output). */
    fun redeem(alias: String, payout: String, approver: SpendApprover?, checkExpiry: Boolean = true): RedeemOutcome = synchronized(lock) {
        val payout40 = Eth.normalize40(payout) ?: return RedeemOutcome.Refused("payout is not an address")
        val note = notes.note(alias) ?: return RedeemOutcome.Refused("no note $alias")
        if (note.spent) return RedeemOutcome.Refused("note already spent")
        if (note.pendingDeposit) return RedeemOutcome.Refused("coin not deposited yet")
        val h = note.header
        if (checkExpiry && h.expiry <= nowS()) return RedeemOutcome.Refused("note expired: the escrow no longer pays it")
        val outs = listOf(Output(note.value, Protocol.redeemKey(h.chainId, h.escrow, payout40)))
        val depth = note.depth
        val sig = try {
            keys.sign(alias, Protocol.spendMessage(h, depth, note.noteId, outs), approver,
                ApprovalPrompt("Prawl: approve cash out", "Redeem ${Eth.eth(note.value)} ETH to 0x${payout40.take(6)}…${payout40.takeLast(4)}"))
        } catch (t: Throwable) {
            val m = (t.message ?: t.toString()).lineSequence().first()
            log("REFUSED BY SECURE HARDWARE: $m")
            return RedeemOutcome.Refused("refused by the secure hardware: $m")
        }
        val red = buildJsonObject {
            put("header", h.json); put("path", note.json["path"]!!)
            put("redeem", buildJsonObject {
                put("outputs", Output.toJson(outs)); put("index", 0); put("payout", "0x$payout40"); put("sig", Bytes.b64(sig))
            })
        }
        val full = carry(red, null)
        notes.put(Note(note.json.with("spent", true).with("redeemedTo", "0x$payout40").with("redeemBundle", full.toString()).with("redeemedAt", nowS())))
        log("REDEEM SIGNED: ${Eth.eth(note.value)} ETH note $alias -> 0x$payout40")
        RedeemOutcome.Signed(full, note)
    }

    // ================================================================ views

    fun spendable(): List<Note> = notes.notes().filter { !it.spent && !it.pendingDeposit }
    fun spendableTotal(): BigInteger = spendable().fold(BigInteger.ZERO) { a, n -> a + n.value }

    fun show(): String {
        var total = BigInteger.ZERO
        for (n in notes.notes()) {
            if (!n.spent && !n.pendingDeposit) total += n.value
            log("NOTE ${n.label} ${Eth.eth(n.value)} ETH key=${n.alias} depth=${n.depth}" +
                (if (n.spent) " (spent" + (if (n.redeemedTo != null) ", redeemed)" else ")") else if (n.pendingDeposit) " (awaiting deposit)" else ""))
        }
        log("SPENDABLE TOTAL ${Eth.eth(total)} ETH")
        return "OK"
    }

    companion object {
        fun deflated(s: String): Int {
            val d = Deflater(Deflater.BEST_COMPRESSION)
            d.setInput(s.toByteArray(Charsets.UTF_8)); d.finish()
            val buf = ByteArray(1 shl 20); val n = d.deflate(buf); d.end(); return n
        }
    }
}
