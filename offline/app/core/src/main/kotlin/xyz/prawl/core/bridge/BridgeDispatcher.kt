package xyz.prawl.core.bridge

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import xyz.prawl.core.handoff.Handoff
import xyz.prawl.core.keys.SpendApprover
import xyz.prawl.core.model.CoinHeader
import xyz.prawl.core.model.Note
import xyz.prawl.core.protocol.OfflineWallet
import xyz.prawl.core.protocol.ShieldRequest
import xyz.prawl.core.util.Eth
import xyz.prawl.core.util.Js
import xyz.prawl.core.util.obj
import xyz.prawl.core.util.optObj
import xyz.prawl.core.util.optStr
import xyz.prawl.core.util.str
import java.math.BigInteger
import java.security.SecureRandom

/** What the user is asked, natively, before the hardware key signs anything on a page's request. [mono] is a FULL address or key. */
data class BridgeConfirm(val title: String, val text: String, val mono: String?, val warning: String? = null)

/** A refused bridge call. [code] is a short machine word; for a user's "no" the code AND the message contain "declined". */
class BridgeException(val code: String, message: String) : Exception(message)

/** Everything the dispatcher needs from the app. Kept an interface so the rules run (and are tested) on the JVM. */
interface BridgeHost {
    fun wallet(): OfflineWallet
    fun notes(): List<Note>
    val chainId: String
    /** Escrow for a public load (plain deposit), and the escrow that supports private load / shield / refresh. */
    val publicEscrow40: String
    val privateEscrow40: String
    fun approver(): SpendApprover?
    /** The NATIVE confirmation dialog. Blocks (off the main thread) until the user answers; false = declined or timed out. */
    fun confirm(c: BridgeConfirm): Boolean
    fun changed()
    fun nowS(): Long
    /**
     * The Wallet tab's own public address (40 lowercase hex, validated), offered to the native Load form as a ONE-TAP default.
     * Memory only, never persisted: it is a convenience, not an authority (the form still shows the full address and the user submits).
     */
    fun walletAddressSeen(addr40: String) {}
}

/**
 * `window.prawlOffline.*` for the wallet website, implemented over the same wallet the native screens use.
 *
 * Rules (the page is NOT trusted; only the allowed origin ever reaches this, and it still cannot spend by itself):
 *  - **Nothing signs without the native confirmation.** `cashOut` and `refresh` show the full destination or key natively, then the
 *    hardware key asks the owner (fingerprint / PIN) when the key requires it. The page only asks.
 *  - A user's "no" rejects with code and message containing "declined".
 *  - Results never contain keys, certificates or attestation chains: only the HANDOFF payloads the page already needs.
 *  - Every argument is validated strictly (canonical numbers, addresses, ids, size caps); at most [maxPendingMints] undeposited coins.
 */
class BridgeDispatcher(
    private val host: BridgeHost,
    private val maxPendingMints: Int = 5,
    private val coinLifeS: Long = 14L * 86400,
) {
    /** The last shield target the page handed over (validated); `cashOut(to:{shield})` must present the same request. */
    private var accepted: JsonObject? = null
    private val rnd = SecureRandom()

    companion object {
        val METHODS = setOf("mint", "coins", "cashOut", "refresh", "shieldAsk", "acceptShieldTarget", "markDeposited", "markRefreshed", "setAccount")
        const val MAX_ARGS_CHARS = 65_536
        private val DEC = Regex("^(0|[1-9][0-9]{0,77})$")
        private val HEX64 = Regex("^[0-9a-f]{64}$")
        private val TX = Regex("^0x[0-9a-f]{64}$")
        private val MAX_WEI = BigInteger.TEN.pow(24)
    }

    /** [argsText] is the call's JSON object text. Returns the JSON text of the result; throws [BridgeException] for anything refused. */
    fun dispatch(method: String, argsText: String): String {
        if (method !in METHODS) throw BridgeException("unknown_method", "unknown method")
        if (argsText.length > MAX_ARGS_CHARS) throw BridgeException("invalid_args", "arguments too large")
        val args = try { Js.parse(argsText) } catch (e: Exception) { throw BridgeException("invalid_args", "arguments are not a JSON object") }
        return try {
            when (method) {
                "mint" -> mint(args)
                "coins" -> coins()
                "shieldAsk" -> shieldAsk(args)
                "acceptShieldTarget" -> acceptShieldTarget(args)
                "cashOut" -> cashOut(args)
                "refresh" -> refresh(args)
                "markDeposited" -> markDeposited(args)
                "setAccount" -> setAccount(args)
                else -> markRefreshed(args)
            }.toString()
        } catch (e: BridgeException) { throw e }
        catch (e: IllegalArgumentException) { throw BridgeException("invalid_args", e.message ?: "invalid arguments") }
        catch (e: IllegalStateException) { throw BridgeException("refused", e.message ?: "refused") }
    }

    // ------------------------------------------------------------------ helpers

    private fun amount(s: String): BigInteger {
        if (!DEC.matches(s)) throw BridgeException("invalid_args", "valueWei must be a plain decimal number")
        val v = BigInteger(s)
        if (v.signum() <= 0 || v > MAX_WEI) throw BridgeException("invalid_args", "valueWei out of range")
        return v
    }

    private fun address(s: String, what: String): String {
        val a = Eth.validateAddress(s)
        if (!a.ok) throw BridgeException("invalid_args", "$what: ${a.note}")
        return a.addr40!!
    }

    private fun coinKey(s: String): String {
        val k = s.lowercase().removePrefix("0x")
        if (!HEX64.matches(k)) throw BridgeException("invalid_args", "coinId must be 32 bytes of hex")
        return k
    }

    private fun spendable(coin: String) = host.notes().filter { it.header.coinId == coin && !it.spent && !it.pendingDeposit }

    private fun pickNote(args: JsonObject): Note {
        val coin = coinKey(args.str("coinId"))
        var c = spendable(coin)
        args.optStr("noteId")?.let { n -> val want = n.lowercase().removePrefix("0x"); c = c.filter { it.noteId.lowercase().removePrefix("0x") == want } }
        if (c.isEmpty()) throw BridgeException("no_such_coin", "no spendable note for that coin")
        if (c.size > 1) throw BridgeException("ambiguous", "the coin has several notes: pass noteId")
        return c.single()
    }

    private fun declinedText() = "declined: you declined on the phone; nothing was signed"

    private fun requireApproval(c: BridgeConfirm) { if (!host.confirm(c)) throw BridgeException("declined", declinedText()) }

    /** The wallet refuses with a reason; an owner's cancel of the fingerprint prompt is a "declined", anything else a plain refusal. */
    private fun refusal(reason: String): BridgeException {
        val r = reason.lowercase()
        return if ("owner approval" in r || "cancel" in r || "not authenticated" in r) BridgeException("declined", "declined: $reason")
        else BridgeException("refused", reason)
    }

    private fun hex(id: String) = "0x$id"

    // ------------------------------------------------------------------ methods

    private fun mint(a: JsonObject): JsonObject {
        val dep = address(a.str("depositor"), "depositor")
        val wei = amount(a.str("valueWei"))
        val mode = a.optStr("mode", "public")
        if (mode != "public" && mode != "private") throw BridgeException("invalid_args", "mode must be public or private")
        if (host.notes().count { it.pendingDeposit && !it.spent } >= maxPendingMints)
            throw BridgeException("too_many_pending", "too many coins are waiting for a deposit; finish or discard one first")
        val priv = mode == "private"
        val label = "w" + host.nowS() + ByteArray(2).also { rnd.nextBytes(it) }.joinToString("") { "%02x".format(it) }
        val m = host.wallet().mint(label, wei, coinLifeS, host.chainId, if (priv) host.privateEscrow40 else host.publicEscrow40, dep,
            pendingDeposit = true, privateLoad = priv)
        host.changed()
        return if (priv) Handoff.loadPrivate(CoinHeader(m.header)) else Handoff.load(m.header)
    }

    /** `setAccount({address})`: the wallet's public address, only to pre-fill the native Load form. Signs and spends nothing. */
    private fun setAccount(a: JsonObject): JsonObject {
        val addr40 = address(a.str("address"), "address")
        host.walletAddressSeen(addr40)
        return buildJsonObject { put("ok", true) }
    }

    /** A bare JSON array: the website's `BridgeCoin[]` contract (`coins.map(...)`); a wrapping object crashes the page. */
    private fun coins(): JsonArray {
        val now = host.nowS()
        val live = host.notes().filter { !it.spent }
        val arr = live.groupBy { it.header.coinId }.map { (id, ns) ->
            val h = ns.first().header
            val state = when { ns.any { it.pendingDeposit } -> "awaiting_deposit"; h.expiry <= now -> "expired"; else -> "spendable" }
            buildJsonObject {
                put("coinId", hex(id)); put("valueWei", ns.fold(BigInteger.ZERO) { s, n -> s + n.value }.toString())
                put("expiry", h.expiry); put("state", state); put("escrow", hex(h.escrow))
                put("notes", JsonArray(ns.filter { !it.pendingDeposit }.map { n -> buildJsonObject { put("noteId", n.noteId); put("valueWei", n.value.toString()) } }))
            }
        }
        return JsonArray(arr)
    }

    private fun shieldAsk(a: JsonObject): JsonObject {
        val wei = amount(a.str("valueWei"))
        val note = host.wallet().notesForShield(wei).firstOrNull() ?: throw BridgeException("no_such_coin", "no note is worth exactly that value on an escrow that can pay into RAILGUN")
        val ask = host.wallet().shieldAsk(note.alias)
        return buildJsonObject { put("nonce", ask.str("nonce")) }
    }

    private fun acceptShieldTarget(a: JsonObject): JsonObject {
        val req = try { ShieldRequest.parse(a) } catch (e: Exception) { throw BridgeException("invalid_args", "not a shield target: ${e.message}") }
        val note = host.wallet().notesForShield(req.value).firstOrNull() ?: throw BridgeException("no_such_coin", "no note is worth exactly that value")
        val chk = host.wallet().checkShield(note, a)
        if (!chk.ok) throw BridgeException("invalid_target", chk.failures.joinToString("; "))
        accepted = a
        return buildJsonObject { put("ok", true); put("valueWei", req.value.toString()); chk.warning?.let { put("warning", it) } }
    }

    private fun cashOut(a: JsonObject): JsonObject {
        val note = pickNote(a)
        val to = a.obj("to")
        val approver = host.approver()
        val outcome: OfflineWallet.RedeemOutcome
        val eth = Eth.eth(note.value)
        if (to.optObj("shield") != null) {
            val target = accepted ?: throw BridgeException("invalid_args", "call acceptShieldTarget first")
            val want = try { ShieldRequest.parse(to.obj("shield")).hash() } catch (e: Exception) { throw BridgeException("invalid_args", "bad shield request") }
            if (ShieldRequest.parse(target).hash() != want) throw BridgeException("invalid_args", "the shield request is not the one accepted")
            val req = ShieldRequest.parse(target)
            if (req.value != note.value) throw BridgeException("invalid_args", "the shield request value is not this note's value")
            val chk = host.wallet().checkShield(note, target)
            requireApproval(BridgeConfirm("Cash out to this private balance?",
                "$eth ETH goes into the RAILGUN account with this key (npk). It cannot be redirected or undone after you approve. Compare every character with what your wallet shows.",
                "0x" + req.npk.toString(16).padStart(64, '0'), chk.warning))
            outcome = host.wallet().redeemShield(note.alias, target, approver)
            accepted = null
        } else {
            val addr = address(to.str("address"), "address")
            requireApproval(BridgeConfirm("Cash out to this address?",
                "$eth ETH is paid to this address. It cannot be redirected or undone after you approve. Compare every character with what your wallet shows.",
                Eth.checksum(addr)))
            outcome = host.wallet().redeem(note.alias, addr, approver)
        }
        host.changed()
        return when (outcome) {
            is OfflineWallet.RedeemOutcome.Signed -> outcome.handoff
            is OfflineWallet.RedeemOutcome.Refused -> throw refusal(outcome.reason)
        }
    }

    private fun refresh(a: JsonObject): JsonObject {
        val note = pickNote(a)
        val reclaim40 = a.optStr("depositor")?.let { address(it, "depositor") }
            ?: note.header.depositor.takeIf { it != "0".repeat(40) } ?: throw BridgeException("invalid_args", "depositor (the reclaim address) is required")
        requireApproval(BridgeConfirm("Refresh this coin?",
            "${Eth.eth(note.value)} ETH moves into a NEW coin that lasts ${coinLifeS / 86400} days. Nothing is paid out. If the new coin is never cashed out, its value can be reclaimed by this address after it expires. Compare every character.",
            Eth.checksum(reclaim40)))
        val out = host.wallet().refresh(note.alias, coinLifeS, reclaim40, host.approver())
        host.changed()
        return when (out) {
            is OfflineWallet.RefreshOutcome.Signed -> out.handoff
            is OfflineWallet.RefreshOutcome.Refused -> throw refusal(out.reason)
        }
    }

    private fun markDeposited(a: JsonObject): JsonObject {
        val coin = coinKey(a.str("coinId"))
        val tx = a.optStr("txHash")?.also { if (!TX.matches(it)) throw BridgeException("invalid_args", "txHash must be 0x + 64 lowercase hex") }
        val n = host.notes().firstOrNull { it.header.coinId == coin && it.pendingDeposit && !it.spent }
            ?: throw BridgeException("no_such_coin", "no undeposited coin with that id")
        host.wallet().markDeposited(n.alias, tx)
        host.changed()
        return buildJsonObject { put("ok", true) }
    }

    private fun markRefreshed(a: JsonObject): JsonObject {
        val newId = coinKey(a.str("newCoinId"))
        a.optStr("txHash")?.let { if (!TX.matches(it)) throw BridgeException("invalid_args", "txHash must be 0x + 64 lowercase hex") }
        host.wallet().markRefreshed(newId)
        host.changed()
        return buildJsonObject { put("ok", true) }
    }
}
