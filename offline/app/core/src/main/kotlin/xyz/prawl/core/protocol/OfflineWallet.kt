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
import xyz.prawl.core.util.objects
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
    /** Escrows that implement shield cash-out, refresh and private load (v3.1). Those operations are refused on any other escrow. */
    val v31Escrows: Set<Pair<String, String>> = Escrows.V31,
) {
    val certs = CertResolver(certStore, anchors)
    private val rnd = SecureRandom()

    private fun nowS() = nowMillis() / 1000

    /**
     * Audit F1: a note is only signed from if everything that goes into the message text is in the canonical form the escrow
     * rebuilds. (Notes accepted by this app were checked on receipt; this also covers notes from older apps.)
     */
    // ---------------------------------------------------------------- crash safety around signatures (audit F-06)
    //
    // A hardware signature cannot be repeated: the one-time key is gone the moment it signs. So the order is
    //   1. write-ahead INTENT record (before the key is used): what is about to be signed and which new keys were made for it;
    //   2. sign;
    //   3. write ONE atomic SIGNED record holding everything the signature produced (the spent note with its stored bundle, the
    //      change note, a pending-refresh record);
    //   4. apply it (put the notes), then delete the signed record and the intent.
    // `reconcile()` at startup finishes step 4 for any signed record, and cleans up intents whose signing never happened.

    /** Writes the write-ahead intent. Returns an error text (and signs nothing) if it cannot be saved. */
    private fun writeIntent(op: String, alias: String, newKeys: List<String> = emptyList(), extra: Map<String, String> = emptyMap()): String? = try {
        notes.putRecord("intent", alias, buildJsonObject {
            put("op", op); put("note", alias); put("newKeys", jsonArrayOf(newKeys)); put("at", nowS())
            extra.forEach { (k, v) -> put(k, v) }
        }); null
    } catch (e: Exception) { "could not save the write-ahead record before signing, so nothing was signed (${e.message})" }

    private fun dropIntent(alias: String) { runCatching { notes.deleteRecord("intent", alias) } }

    /**
     * Persists what a signature produced. The signed record is written first, atomically and with retries; applying it may fail and
     * is retried here and by [reconcile]. Returns false only if even the signed record could not be written (the signature then
     * exists only in memory: the caller still hands the bundle on, but the wallet cannot recover it after a restart).
     */
    private fun commitSigned(alias: String, noteWrites: List<Note>, recordWrites: List<Triple<String, String, JsonObject>> = emptyList()): Boolean {
        val rec = buildJsonObject {
            put("notes", JsonArray(noteWrites.map { it.json }))
            put("records", JsonArray(recordWrites.map { (k, n, j) -> buildJsonObject { put("kind", k); put("name", n); put("json", j) } }))
        }
        var saved = false
        for (attempt in 1..3) {
            try { notes.putRecord("signed", alias, rec); saved = true; break }
            catch (e: Exception) { log("WARNING: could not write the signed record (attempt $attempt): ${e.message}") }
        }
        if (!saved) log("WARNING: the signature exists only in memory; applying it directly")
        for (attempt in 1..2) if (applySigned(alias, rec)) break
        return saved
    }

    /** Applies a signed record (idempotent). Returns true when everything was written and the record and intent were removed. */
    private fun applySigned(alias: String, rec: JsonObject): Boolean = try {
        rec.arr("notes").objects().forEach { notes.put(Note(it)) }
        rec.arr("records").objects().forEach { notes.putRecord(it.str("kind"), it.str("name"), it["json"] as JsonObject) }
        notes.deleteRecord("signed", alias)
        notes.deleteRecord("intent", alias)
        true
    } catch (e: Exception) { log("apply of the signed record for $alias failed, reconcile will retry: ${e.message}"); false }

    /**
     * Startup reconcile (call once per process, and it is cheap to call again): finishes interrupted signatures and clears intents.
     * Returns the number of records it acted on.
     */
    fun reconcile(): Int = synchronized(lock) {
        var acted = 0
        for (n in notes.recordNames("signed")) {
            val rec = notes.record("signed", n) ?: continue
            if (applySigned(n, rec)) { acted++; log("RECONCILE: finished the interrupted signature of $n") }
        }
        for (n in notes.recordNames("intent")) {
            val it = notes.record("intent", n) ?: continue
            val note = notes.note(n)
            val keyAlive = keys.exists(n)
            val newKeys = runCatching { it.arr("newKeys").strings() }.getOrDefault(emptyList())
            when {
                keyAlive && note?.spent != true -> {            // the key never signed: forget the keys made for it
                    newKeys.forEach { k -> if (notes.note(k) == null && notes.record("refresh", k) == null) keys.delete(k) }
                    notes.deleteRecord("intent", n); acted++; log("RECONCILE: signing of $n never happened; removed its unused new keys")
                }
                !keyAlive && note != null && !note.spent -> {   // the key signed but no signature was stored: it is gone for good
                    notes.put(Note(note.json.with("spent", true).with("signatureLost", true)))
                    newKeys.forEach { k -> if (notes.note(k) == null) keys.delete(k) }
                    notes.deleteRecord("intent", n); acted++; log("RECONCILE: the signature of $n was lost in a crash; the note is marked lost")
                }
                else -> { notes.deleteRecord("intent", n); acted++ }
            }
        }
        acted
    }

    private fun canonicalRefusal(note: Note): String? =
        Canonical.noteProblems(note).firstOrNull()?.let { "refusing to sign: this note's data is not in the canonical form the escrow can verify ($it)" }

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
        /** HANDOFF v1.1 §5 `load-private` payload (only meaningful for a coin minted with `privateLoad`). */
        val handoffPrivate: JsonObject get() = Handoff.loadPrivate(note.header, note.tipWei)
    }

    /**
     * Mints a coin: a fresh single-use genesis key and a random coin id.
     *
     * [privateLoad] (escrow v3.1 commit-then-fund): the coin is funded by a RAILGUN unshield to the deposit address, so
     * [depositor] is the coin's RECLAIM address (not the funder), the escrow must be v3.1, and [tipWei] is the relayer
     * tip the unshield must cover on top of the value (exact mode: minValue = maxValue = value).
     */
    fun mint(
        label: String, valueWei: BigInteger, expiresInS: Long, chainId: String, escrow: String, depositor: String,
        spec: KeySpec = KeySpec(userAuthPerUse = ownerApprovalForNewKeys()), pendingDeposit: Boolean = false,
        privateLoad: Boolean = false, tipWei: BigInteger = BigInteger.ZERO,
    ): MintResult = synchronized(lock) {
        require(valueWei.signum() > 0) { "value must be positive" }
        val escrow40 = Eth.normalize40(escrow) ?: throw IllegalArgumentException("escrow is not an address")
        val dep40 = Eth.normalize40(depositor) ?: throw IllegalArgumentException("depositor is not an address")
        require(tipWei.signum() >= 0) { "tip must not be negative" }
        if (privateLoad) require(Escrows.isV31(chainId, escrow40, v31Escrows)) { "private load needs escrow v3.1; 0x$escrow40 does not support it" }
        else require(tipWei.signum() == 0) { "a tip applies only to private load" }
        require(Canonical.isSafeLabel(label)) { "label must be 1-24 letters, digits, '_' or '-'" }
        val alias = "n_${label}_g"
        // never overwrite a record that may be the only copy of a signed payment or redemption (audit F-09)
        notes.note(alias)?.let {
            if (!it.spent) throw IllegalStateException("label '$label' already holds an unspent coin")
            if (it.signedBundle != null || it.json.containsKey("redeemBundle")) throw IllegalStateException("label '$label' belongs to a note whose signed payment may still be unconfirmed; choose another")
        }
        if (keys.exists(alias)) throw IllegalStateException("a key named $alias already exists; refusing to replace it")
        var id: ByteArray
        do { id = ByteArray(32).also { rnd.nextBytes(it) } } while (Refresh.isReserved(Bytes.hex(id)))   // "RFSH" ids belong to refreshed coins
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
        if (privateLoad) noteJson = noteJson.with("privateLoad", true).with("tipWei", tipWei.toString())
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

    /**
     * Undoes a "deposited" mark the chain does not back (the page or the user marked a coin that was never funded): the coin is awaiting
     * deposit again, with a fresh clock for the unfunded clean-up. Does nothing to a spent or already-awaiting note.
     */
    fun markUndeposited(alias: String) = synchronized(lock) {
        val n = notes.note(alias) ?: return@synchronized
        if (n.spent || n.pendingDeposit) return@synchronized
        notes.put(Note(n.json.without("depositedAt").without("depositTx").with("pendingDeposit", true).with("createdAt", nowS())))
        log("UNDEPOSITED ${n.label}: the chain has no deposit for it, back to awaiting deposit")
    }

    /**
     * Discards coins that were minted here and never funded for [maxAgeS] (default a day): their keys are deleted. A deposit sent to one later
     * could then only be reclaimed by its depositor after expiry, which the Load screen warns about. Returns how many were discarded.
     */
    fun discardStaleUndeposited(nowS: Long, maxAgeS: Long): Int = synchronized(lock) {
        val stale = notes.notes().filter { n -> !n.spent && n.pendingDeposit && n.createdAt?.let { nowS - it > maxAgeS } == true && n.json.optStr("depositTx") == null }
        stale.forEach { discardUndeposited(it.alias) }
        if (stale.isNotEmpty()) log("DISCARDED ${stale.size} unfunded coin(s) older than ${maxAgeS / 3600} h")
        stale.size
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
            // audit F-05: a one-time key under this alias with no record is a payment's key; replacing it would destroy it
            if (keys.exists(alias)) throw IllegalStateException("receive key $alias already exists without a record; refusing to replace it")
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
        /** [persisted] is false only if the wallet could not save the signed record (disk failure): hand the bundle on now, it cannot be recovered after a restart. */
        class Paid(val bundle: JsonObject, val amount: BigInteger, val change: BigInteger, val fromAlias: String, val resent: Boolean, val payeeCheck: AttestationResult,
                   val persisted: Boolean = true) : PayOutcome()
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
        val reqCerts = reqIn.certs
        val to = reqIn.chain
        // bounds before any crypto or write (audit F-07, F-13): a hostile payee's request is checked and used from memory
        if (to.isEmpty() || to.size > CertStore.MAX_CHAIN) return PayOutcome.Refused("payee's certificate chain has ${to.size} entries (1..${CertStore.MAX_CHAIN} allowed)")
        val toKey = try { certs.leafKeyHash(to, reqCerts) } catch (e: Exception) { return PayOutcome.Refused("payee request unreadable: ${e.message}") }
        if (opts.expectedKeyHash != null && !opts.expectedKeyHash.equals(toKey, ignoreCase = true)) {
            log("REFUSING TO PAY: the key received over the link is not the one in the payee's QR")
            return PayOutcome.Refused("the payee's key does not match the scanned QR code")
        }
        // Check the payee's key is a genuine hardware one-time key BEFORE spending: paying a software key
        // would let the payee equivocate and freeze the coin's subtree.
        val pr = try { checker.verify(certs.chain(to, reqCerts)) } catch (e: Exception) { AttestationResult().apply { fails.add(e.message ?: "unreadable") } }
        log("  payee key check: " + pr.summary())
        if (!pr.ok) { log("REFUSING TO PAY: payee key is not a hardware one-time key"); return PayOutcome.Refused("payee key is not a hardware one-time key: ${pr.fails.joinToString("; ")}", pr) }
        // only now (the chain verified) keep the certificates it uses; junk the payee attached is dropped (audit F-13)
        try { certs.absorb(reqCerts, to) } catch (e: Exception) { return PayOutcome.Refused("could not store the payee's certificates: ${e.message}") }
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
        canonicalRefusal(note)?.let { log("REFUSED: $it"); return PayOutcome.Refused(it) }
        val h = note.header
        val change = v - amount
        val outs = ArrayList<Output>()
        outs.add(Output(amount, toKey))
        var chgAlias: String? = null
        var chgChain: JsonArray? = null
        if (change.signum() > 0) {
            chgAlias = freshAlias("n_${h.coinId.take(8)}_c${nowMillis()}")      // from the coin id, never from the attacker-chosen label (audit F-09)
            chgChain = newKey(chgAlias, KeySpec(userAuthPerUse = ownerApprovalForNewKeys()))
            outs.add(Output(change, certs.leafKeyHash(chgChain.strings())))
        }
        val depth = note.depth
        val msg = Protocol.spendMessage(h, depth, note.noteId, outs)
        log("PAY ${Eth.eth(amount)} ETH of note ${note.alias} (${Eth.eth(v)} ETH, depth $depth) -> '${reqIn.name}'" +
            (if (chgAlias != null) " + change ${Eth.eth(change)} ETH -> own new key $chgAlias" else ""))
        writeIntent("pay", note.alias, listOfNotNull(chgAlias), mapOf("to" to toKey, "msgHash" to Bytes.sha256Hex(msg)))?.let { err ->
            if (chgAlias != null) keys.delete(chgAlias)
            log("REFUSED: $err"); return PayOutcome.Refused(err)
        }
        val sig: ByteArray = try {
            keys.sign(note.alias, msg, approver, ApprovalPrompt("Prowl: approve payment", "Pay ${Eth.eth(amount)} ETH offline",
                "Pays ${Eth.eth(amount)} ETH to the one-time key ${toKey.take(16)}…\nSigns this note over once. The secure hardware will not sign it again."))
        } catch (t: Throwable) {
            val m = (t.message ?: t.toString()).lineSequence().first()
            log("REFUSED BY SECURE HARDWARE: $m")
            if (chgAlias != null) keys.delete(chgAlias)
            dropIntent(note.alias)
            return PayOutcome.Refused("refused by the secure hardware: $m")
        }
        val sigB64 = Bytes.b64(sig)
        // spend record appended to the path; recipient-facing bundle takes output 0
        val spendTo = buildJsonObject { put("outputs", Output.toJson(outs)); put("index", 0); put("sig", sigB64); put("next", JsonArray(to.map { JsonPrimitive(it) })) }
        val path = JsonArray(note.json.arr("path") + spendTo)
        val bundle = buildJsonObject { put("header", h.json); put("path", path) }
        // ONE atomic record with the spent note (stored bundle: retry = same bytes) and the change note (audit F-06)
        val spentNote = Note(note.json.with("spent", true).with("signedTo", toKey).with("signedBundle", bundle.toString()))
        val changeNote = if (chgAlias != null) {
            val spendChg = spendTo.with("index", 1).with("next", chgChain!!)
            val cpath = JsonArray(note.json.arr("path") + spendChg)
            Note(buildJsonObject {
                put("header", h.json); put("path", cpath); put("alias", chgAlias); put("value", change.toString())
                put("noteId", Protocol.childNoteId(sigB64, 1))
            })
        } else null
        val persisted = commitSigned(note.alias, listOfNotNull(spentNote, changeNote))
        log("SIGNED spend at depth $depth (${sig.size} B sig), ${outs.size} outputs")
        PayOutcome.Paid(carry(bundle, reqIn), amount, change, note.alias, false, pr, persisted)
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
    fun carry(bundle: JsonObject, req: ReceiveRequest?, withDepositProof: Boolean = req != null, extraChains: List<List<String>> = emptyList()): JsonObject {
        val skip = HashSet(certs.rootIds)
        req?.known?.let { skip.addAll(it) }
        val b = Bundle(bundle)
        val chains = ArrayList<List<String>>()
        chains.add(b.header.k0)
        b.path.forEach { chains.add(it.next) }
        chains.addAll(extraChains)
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

    /** [requestedWei]: the amount the payee asked for (QR `a`); a smaller payment is still accepted but flagged ([VerificationReport.shortfall], audit F-10). */
    fun accept(bundleJson: JsonObject, name: String, requestedWei: BigInteger? = null): VerificationReport = synchronized(lock) {
        val b = Bundle(bundleJson)
        // Idempotent accept: the SAME payment arriving again after it was accepted (the payer lost our verdict). "Same" means the whole
        // accepted bundle (header, every spend's outputs, index, signature, next chain), not just the final signature: an altered copy keeps
        // its signature bytes and must go through full verification, which rejects it. A record without a bundle digest (older build) never matches.
        val sigHash = finalSigHash(b)
        val digest = Canonical.bundleDigest(b)
        val acc = notes.accepted(name)
        if (acc != null && sigHash != null && digest != null && acc.optStr("sigHash") == sigHash && acc.optStr("bundleHash") == digest &&
            (acc.optStr("until")?.toLongOrNull() ?: 0) >= nowS()) {
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
        rep.requestedWei = requestedWei
        if (requestedWei != null) rep.lines.add(VerifyLine("4", "Amount matches the request", rep.receivedValue >= requestedWei,
            if (rep.receivedValue >= requestedWei) "${Eth.eth(rep.receivedValue)} ETH for ${Eth.eth(requestedWei)} ETH asked"
            else "paid ${Eth.eth(rep.receivedValue)} ETH but ${Eth.eth(requestedWei)} ETH was asked"))
        val pendingChain = notes.pendingChain(name)
        val keepAccepted = {
            if (sigHash != null && pendingChain != null) notes.putAccepted(name, buildJsonObject {
                put("chain", pendingChain.arr("chain")); put("sigHash", sigHash); put("value", rep.receivedValue.toString())
                digest?.let { put("bundleHash", it) }
                put("noteId", rep.noteId!!); put("at", nowS()); put("until", nowS() + acceptedKeepS)
            })
        }
        if (existing != null) {
            log("ACCEPTED (again) in ${rep.ms} ms: retry of a payment already held as recv_$name")
            keepAccepted(); notes.deletePending(name)       // finish the bookkeeping a crash may have interrupted
            return rep
        }
        // audit F-05 order: note first, then the idempotency record, and only then forget the pending key. A failure at any step
        // leaves the pending record, so the payer's retry finds the same key instead of a replaced one.
        certs.absorb(b.certs, b.header.k0 + b.path.flatMap { it.next })
        val hj = b.header.json
        val h = hj.with("label", Canonical.safeLabel(hj.optStr("label"), b.header.coinId))   // label is attacker-chosen and not signed (audit F-09)
        notes.put(Note(buildJsonObject {
            put("header", h); put("path", bundleJson["path"]!!); put("alias", "recv_$name")
            put("value", rep.receivedValue.toString()); put("noteId", rep.noteId!!); put("receivedAt", nowS())
        }))
        keepAccepted()
        notes.deletePending(name)
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
        canonicalRefusal(note)?.let { log("REFUSED: $it"); return RedeemOutcome.Refused(it) }
        val outs = listOf(Output(note.value, Protocol.redeemKey(h.chainId, h.escrow, payout40)))
        val depth = note.depth
        writeIntent("redeem", alias)?.let { log("REFUSED: $it"); return RedeemOutcome.Refused(it) }
        val sig = try {
            // the FULL destination is in the prompt: a truncated address is what a look-alike address exploits (audit F-03)
            keys.sign(alias, Protocol.spendMessage(h, depth, note.noteId, outs), approver,
                ApprovalPrompt("Prowl: approve cash out", "Redeem ${Eth.eth(note.value)} ETH",
                    "Pays out to this address. Check every character:\n${Eth.checksum(payout40)}"))
        } catch (t: Throwable) {
            val m = (t.message ?: t.toString()).lineSequence().first()
            log("REFUSED BY SECURE HARDWARE: $m")
            dropIntent(alias)
            return RedeemOutcome.Refused("refused by the secure hardware: $m")
        }
        val red = buildJsonObject {
            put("header", h.json); put("path", note.json["path"]!!)
            put("redeem", buildJsonObject {
                put("outputs", Output.toJson(outs)); put("index", 0); put("payout", "0x$payout40"); put("sig", Bytes.b64(sig))
            })
        }
        val full = carry(red, null)
        commitSigned(alias, listOf(Note(note.json.with("spent", true).with("redeemedTo", "0x$payout40").with("redeemBundle", full.toString()).with("redeemedAt", nowS()))))
        log("REDEEM SIGNED: ${Eth.eth(note.value)} ETH note $alias -> 0x$payout40")
        RedeemOutcome.Signed(full, note)
    }

    // ================================================================ v3.1: cash out into a RAILGUN shield

    /** Result of checking a website `shield-target` against a note (also shown to the user as "value check" lines). */
    class ShieldCheck(val request: ShieldRequest?, val lines: List<VerifyLine>, val nonceSupplied: Boolean = false, val bound: Boolean = false) {
        val ok: Boolean get() = request != null && lines.all { it.ok }
        val failures: List<String> get() = lines.filter { !it.ok }.map { "${it.title}: ${it.detail}" }
        /**
         * A target with no nonce (the user typed the value into the website) is accepted, but it is not tied to a request this phone
         * made: the UI must show this in the confirmation, next to the full destination (audit F-03).
         */
        val warning: String? get() = if (request != null && !nonceSupplied)
            "NOT BOUND to a request from this phone: nothing proves this target came from your wallet. Check the full destination in the confirmation character by character." else null
    }

    /**
     * The refusals of `Wallet3Activity.redeemShield`, plus the v3.1-only rule:
     *  - the coin's escrow must be v3.1 (v3 has no redeemToShield);
     *  - the target must be for this coin's chain and escrow (when it names them);
     *  - plain ERC20 WETH only (tokenType 0, the chain's WETH, subID 0);
     *  - the shield value must equal the note's value exactly (the escrow shields the output's whole value).
     */
    fun checkShield(note: Note, target: JsonObject): ShieldCheck {
        val h = note.header
        val req = try { ShieldRequest.parse(target) } catch (e: Exception) {
            return ShieldCheck(null, listOf(VerifyLine("0", "Shield request readable", false, e.message ?: "malformed")))
        }
        val lines = ArrayList<VerifyLine>()
        // HANDOFF v1.2 §11: a target that carries a nonce must echo the one from THIS phone's last shield-ask; a wrong, stale or used nonce is refused
        val got = target.optStr("nonce")?.lowercase()
        var bound = false
        if (got != null) {
            val last = notes.record("shieldask", "last")?.takeIf { it.str("at").toLong() + SHIELD_ASK_TTL_S > nowS() }
            val ok = last != null && last.str("alias") == note.alias && last.str("value") == note.value.toString() &&
                java.security.MessageDigest.isEqual(last.str("nonce").toByteArray(), got.toByteArray())
            bound = ok
            lines.add(VerifyLine("0", "Answers this phone's own request (nonce)", ok, when {
                ok -> "the target echoes the nonce of the shield-ask this phone showed for this note"
                last == null -> "this phone has no open shield-ask (the nonce was already used, or expired): show a new one"
                else -> "the target's nonce is not the one of this phone's last request: it did not come from the wallet that scanned it"
            }))
        }
        val v31 = Escrows.isV31(h.chainId, h.escrow, v31Escrows)
        lines.add(VerifyLine("1", "Coin is on escrow v3.1", v31,
            if (v31) "0x${h.escrow}" else "this coin is on escrow 0x${h.escrow}, which cannot pay into RAILGUN; cash it out to an address"))
        val tChain = target.optStr("chainId"); val tEsc = target.optStr("escrow")?.let { Eth.normalize40(it) }
        val chainOk = tChain == null || tChain == h.chainId
        val escOk = target.optStr("escrow") == null || tEsc == h.escrow.lowercase()
        lines.add(VerifyLine("2", "Request is for this coin's escrow", chainOk && escOk,
            if (chainOk && escOk) (if (tEsc == null) "the request does not name an escrow; the signed output binds this coin's" else "chain ${h.chainId}, escrow 0x${h.escrow}")
            else "request is for chain ${tChain ?: h.chainId}, escrow ${tEsc?.let { "0x$it" } ?: "?"}"))
        val weth = Escrows.WETH[h.chainId]
        val tokenOk = req.tokenType == 0 && weth != null && req.tokenAddress40 == weth && req.tokenSubId.signum() == 0
        lines.add(VerifyLine("3", "Plain WETH (ERC20, subID 0)", tokenOk,
            if (tokenOk) "token 0x${req.tokenAddress40}" else "tokenType ${req.tokenType}, token 0x${req.tokenAddress40}, subID ${req.tokenSubId}"))
        val valueOk = req.value == note.value
        lines.add(VerifyLine("4", "Shield value equals the note", valueOk, "${Eth.eth(req.value)} ETH vs note ${Eth.eth(note.value)} ETH"))
        return ShieldCheck(req, lines, nonceSupplied = got != null, bound = bound)
    }

    /** How long a `shield-ask` nonce stays valid. */
    val SHIELD_ASK_TTL_S = 30 * 60L

    /**
     * The `shield-ask` QR for note [alias] (HANDOFF v1.2 §11):
     * `{"v":1,"t":"shield-ask","chainId":11155111,"escrow":"0x…","value":"V","nonce":"<32 lowercase hex chars>"}`.
     * The nonce is 16 fresh random bytes, NEW for every ask; only the last ask is kept, so a new ask invalidates the previous one, and
     * [redeemShield] consumes it. A target that carries a nonce must echo it (audit F-03).
     */
    fun shieldAsk(alias: String): JsonObject = synchronized(lock) {
        val note = notes.note(alias) ?: throw IllegalArgumentException("no note $alias")
        require(!note.spent && !note.pendingDeposit) { "note is not spendable" }
        val h = note.header
        require(Escrows.isV31(h.chainId, h.escrow, v31Escrows)) { "this coin is on an escrow that cannot pay into RAILGUN" }
        val nonce = Bytes.hex(ByteArray(16).also { rnd.nextBytes(it) })
        notes.putRecord("shieldask", "last", buildJsonObject { put("alias", alias); put("nonce", nonce); put("value", note.value.toString()); put("at", nowS()) })
        buildJsonObject {
            put("v", 1); put("t", "shield-ask"); put("chainId", h.chainId.toLong()); put("escrow", "0x${h.escrow}")
            put("value", note.value.toString()); put("nonce", nonce)
        }
    }

    /** Signs a redemption of note [alias] into the RAILGUN shield [target] (`shield-target` object or a bare request). */
    fun redeemShield(alias: String, target: JsonObject, approver: SpendApprover?, checkExpiry: Boolean = true): RedeemOutcome = synchronized(lock) {
        val note = notes.note(alias) ?: return RedeemOutcome.Refused("no note $alias")
        if (note.spent) return RedeemOutcome.Refused("note already spent")
        if (note.pendingDeposit) return RedeemOutcome.Refused("coin not deposited yet")
        val h = note.header
        if (checkExpiry && h.expiry <= nowS()) return RedeemOutcome.Refused("note expired: the escrow no longer pays it")
        canonicalRefusal(note)?.let { log("REFUSED: $it"); return RedeemOutcome.Refused(it) }
        val chk = checkShield(note, target)
        if (!chk.ok) { log("REFUSED: ${chk.failures}"); return RedeemOutcome.Refused("refused: " + chk.failures.joinToString("; ")) }
        val req = chk.request!!
        chk.warning?.let { log("WARNING: $it") }
        val sh = req.hash()
        val outs = listOf(Output(note.value, req.outputKey(h.chainId, h.escrow)))
        writeIntent("shield", alias)?.let { log("REFUSED: $it"); return RedeemOutcome.Refused(it) }
        val npkFull = "0x" + req.npk.toString(16).padStart(64, '0')
        val sig = try {
            keys.sign(alias, Protocol.spendMessage(h, note.depth, note.noteId, outs), approver,
                ApprovalPrompt("Prowl: approve private cash out", "Shield ${Eth.eth(note.value)} ETH into a private balance",
                    "Into the RAILGUN account with this key. Check every character:\n$npkFull"))
        } catch (t: Throwable) {
            val m = (t.message ?: t.toString()).lineSequence().first()
            log("REFUSED BY SECURE HARDWARE: $m")
            dropIntent(alias)
            return RedeemOutcome.Refused("refused by the secure hardware: $m")
        }
        val red = buildJsonObject {
            put("header", h.json); put("path", note.json["path"]!!)
            put("redeem", buildJsonObject {
                put("outputs", Output.toJson(outs)); put("index", 0); put("payout", "0x" + "0".repeat(40))
                put("kind", "shield"); put("shield", req.json); put("shieldHash", "0x$sh"); put("sig", Bytes.b64(sig))
            })
        }
        val full = carry(red, null)
        val npk = req.json.optStr("npk") ?: ""
        commitSigned(alias, listOf(Note(note.json.with("spent", true).with("redeemedTo", "RAILGUN shield npk ${npk.take(18)}…").with("redeemBundle", full.toString()).with("redeemedAt", nowS()))))
        runCatching { if (notes.record("shieldask", "last")?.optStr("alias") == alias) notes.deleteRecord("shieldask", "last") }   // a nonce works once
        log("REDEEM-TO-SHIELD SIGNED: ${Eth.eth(note.value)} ETH note $alias -> RAILGUN npk ${npk.take(18)}… (shieldHash ${sh.take(16)}…)")
        RedeemOutcome.Signed(full, note)
    }

    /** Unspent notes a shield of exactly [valueWei] could use (v3.1 coins whose value equals it). */
    fun notesForShield(valueWei: BigInteger): List<Note> = spendable().filter {
        it.value == valueWei && Escrows.isV31(it.header.chainId, it.header.escrow, v31Escrows) && it.header.expiry > nowS()
    }

    // ================================================================ v3.1: refresh

    sealed class RefreshOutcome {
        class Signed(val bundle: JsonObject, val newCoinId: String, val newExpiry: Long, val value: BigInteger, val reclaim40: String, val oldAlias: String) : RefreshOutcome() {
            /** Website payload (`t:"refresh"`, provisional): redeem arguments + (newCoinId, newExpiry, newK0x, newK0y). */
            val handoff: JsonObject get() = Handoff.redeem(bundle, null)
        }
        class Refused(val reason: String) : RefreshOutcome()
    }

    private fun uniqueLabel(base0: String): String {
        val base = Canonical.safeLabel(base0, "0".repeat(6))
        val taken = notes.notes().filter { !it.spent || it.pendingDeposit }.map { it.label }.toSet()
        if (base !in taken) return base
        var i = 2
        while ("$base$i" in taken) i++
        return "$base$i"
    }

    /**
     * Refresh (RESULTS §3.6): signs the WHOLE note into a PRAWL-REFRESH output, which the escrow turns into a new coin
     * with a new expiry, a new genesis key (made here) and [reclaim] as its depositor. The new coin id is derived from
     * the signed message (`RFSH` prefix), so nobody can pre-empt it. The new coin is NOT spendable until
     * [markRefreshed] (after the refresh landed on-chain); until then it is kept as a pending record with its key.
     */
    fun refresh(alias: String, expiresInS: Long, reclaim: String, approver: SpendApprover?, newLabel: String? = null): RefreshOutcome = synchronized(lock) {
        val dep40 = Eth.normalize40(reclaim) ?: return RefreshOutcome.Refused("reclaim address is not an address")
        if (dep40 == "0".repeat(40)) return RefreshOutcome.Refused("reclaim address must not be the zero address")
        val note = notes.note(alias) ?: return RefreshOutcome.Refused("no note $alias")
        if (note.spent) return RefreshOutcome.Refused("note already spent")
        if (note.pendingDeposit) return RefreshOutcome.Refused("coin not deposited yet")
        val h = note.header
        if (!Escrows.isV31(h.chainId, h.escrow, v31Escrows))
            return RefreshOutcome.Refused("this coin is on escrow 0x${h.escrow}, which has no refresh; refresh needs escrow v3.1. Cash it out and load again")
        val now = nowS()
        if (h.expiry <= now) return RefreshOutcome.Refused("note expired: the escrow no longer pays it")
        canonicalRefusal(note)?.let { log("REFUSED: $it"); return RefreshOutcome.Refused(it) }
        if (expiresInS < REFRESH_MIN_S || expiresInS > REFRESH_MAX_S)
            return RefreshOutcome.Refused("new lifetime must be between 1 and ${REFRESH_MAX_S / 86400} days (the escrow allows at most 30 from submission)")
        val newExpiry = now + expiresInS
        val label = uniqueLabel((newLabel ?: (Canonical.safeLabel(h.label, h.coinId) + "r")).take(24))
        val newAlias = freshAlias("n_${label}_g")
        writeIntent("refresh", alias, listOf(newAlias))?.let { log("REFUSED: $it"); return RefreshOutcome.Refused(it) }
        val c0 = newKey(newAlias, KeySpec(userAuthPerUse = ownerApprovalForNewKeys()))
        var signed = false
        try {
            val k0 = certs.leafKey(c0.strings()) as ECPublicKey
            val newK0Hash = certs.leafKeyHash(c0.strings())
            check(newK0Hash == Refresh.keyHashXy(k0.w.affineX, k0.w.affineY)) { "internal: new key hash mismatch" }
            val outs = listOf(Output(note.value, Refresh.outputKey(h.chainId, h.escrow, newExpiry, newK0Hash, dep40)))
            val msg = Protocol.spendMessage(h, note.depth, note.noteId, outs)
            val newCoinId = Refresh.coinId(Refresh.messageHash(msg), 0)
            check(Refresh.isReserved(newCoinId))
            val sig = try {
                keys.sign(alias, msg, approver, ApprovalPrompt("Prowl: approve refresh", "Move ${Eth.eth(note.value)} ETH into a new coin (${expiresInS / 86400} days)",
                    "The new coin's reclaim address. Check every character:\n${Eth.checksum(dep40)}"))
            } catch (t: Throwable) {
                val m = (t.message ?: t.toString()).lineSequence().first()
                log("REFUSED BY SECURE HARDWARE: $m")
                keys.delete(newAlias); dropIntent(alias)
                return RefreshOutcome.Refused("refused by the secure hardware: $m")
            }
            signed = true      // from here on the old key is spent: the new key must NEVER be deleted (audit F-06)
            val k0x = k0.w.affineX.toString(16); val k0y = k0.w.affineY.toString(16)
            val red = buildJsonObject {
                put("header", h.json); put("path", note.json["path"]!!)
                put("redeem", buildJsonObject {
                    put("outputs", Output.toJson(outs)); put("index", 0); put("payout", "0x$dep40"); put("kind", "refresh")
                    put("refresh", buildJsonObject { put("expiry", newExpiry); put("k0", c0); put("k0x", k0x); put("k0y", k0y); put("depositor", dep40); put("coinId", newCoinId) })
                    put("sig", Bytes.b64(sig))
                })
            }
            val full = carry(red, null, extraChains = listOf(c0.strings()))
            val newHeader = buildJsonObject {
                put("v", 3); put("label", label); put("coinId", newCoinId); put("chainId", h.chainId); put("escrow", h.escrow)
                put("expiry", newExpiry); put("value", note.value.toString()); put("k0", c0); put("k0x", k0x); put("k0y", k0y); put("depositor", dep40)
            }
            // ONE atomic record: the spent old note and the pending-refresh record (the old key is spent, so these are the money)
            commitSigned(alias,
                listOf(Note(note.json.with("spent", true).with("refreshedTo", newCoinId).with("redeemBundle", full.toString()).with("redeemedAt", now))),
                listOf(Triple("refresh", newCoinId, buildJsonObject {
                    put("coinId", newCoinId); put("alias", newAlias); put("label", label); put("value", note.value.toString())
                    put("oldAlias", alias); put("oldCoinId", h.coinId); put("header", newHeader); put("bundle", full.toString()); put("at", now)
                })))
            log("REFRESH SIGNED: ${Eth.eth(note.value)} ETH note $alias -> new coin ${newCoinId.take(16)}… (key $newAlias, expires ${newExpiry}, reclaim 0x$dep40)")
            RefreshOutcome.Signed(full, newCoinId, newExpiry, note.value, dep40, alias)
        } catch (e: Exception) {
            // only a key that has not been committed to a signature may be deleted; after signing the pending record owns it (audit F-06)
            if (!signed) { keys.delete(newAlias); dropIntent(alias) }
            else log("WARNING: refresh signed but finishing failed (${e.message}); the new coin's key $newAlias is kept")
            RefreshOutcome.Refused(e.message ?: e.toString())
        }
    }

    /** Refreshes signed but not yet confirmed, newest first. */
    fun pendingRefreshes(): List<PendingRefresh> =
        notes.recordNames("refresh").mapNotNull { n -> notes.record("refresh", n)?.let { PendingRefresh(it) } }.sortedByDescending { it.at }

    /**
     * Drops a pending refresh that can never land, because the old coin it refreshes was never deposited (the chain has nothing to
     * re-assign). Only call this when that is PROVEN: a real signed refresh is the money and must be kept. Deletes the new coin's unused key.
     */
    fun abandonRefresh(coinId: String) = synchronized(lock) {
        val id = coinId.lowercase().removePrefix("0x")
        val rec = notes.record("refresh", id) ?: return@synchronized
        runCatching { keys.delete(rec.str("alias")) }
        notes.deleteRecord("refresh", id)
        log("ABANDONED refresh of coin 0x${rec.str("oldCoinId").take(16)}…: the old coin was never deposited")
    }

    /**
     * The user confirmed the refresh landed (or the light-client check proved it): the new coin's genesis note is created
     * and becomes spendable, keyed by the genesis key made at refresh time. The pending record is consumed, so a second call fails.
     */
    fun markRefreshed(coinId: String): Note = synchronized(lock) {
        val id = coinId.lowercase().removePrefix("0x")
        val rec = notes.record("refresh", id) ?: throw IllegalArgumentException("no pending refresh for coin 0x$id")
        val alias = rec.str("alias")
        notes.note(alias)?.let { notes.deleteRecord("refresh", id); return@synchronized it }
        check(keys.exists(alias)) { "the new coin's genesis key $alias is missing" }
        val note = Note(buildJsonObject {
            put("header", rec["header"]!!); put("path", JsonArray(emptyList())); put("alias", alias); put("value", rec.str("value"))
            put("noteId", Protocol.genesisNoteId(id)); put("refreshedFrom", rec.str("oldCoinId")); put("depositedAt", nowS())
        })
        notes.put(note)
        notes.deleteRecord("refresh", id)
        log("REFRESH CONFIRMED: coin 0x${id.take(16)}… is live, ${Eth.eth(note.value)} ETH, key $alias")
        note
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
        /** New coin lifetime on refresh: 1 to 28 days (the escrow requires newExpiry <= submission time + 30 days). */
        const val REFRESH_MIN_S = 86400L
        const val REFRESH_MAX_S = 28 * 86400L

        fun deflated(s: String): Int {
            val d = Deflater(Deflater.BEST_COMPRESSION)
            d.setInput(s.toByteArray(Charsets.UTF_8)); d.finish()
            val buf = ByteArray(1 shl 20); val n = d.deflate(buf); d.end(); return n
        }
    }
}
