package xyz.prawl.core.transport

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import xyz.prawl.core.model.ReceiveRequest
import xyz.prawl.core.protocol.OfflineWallet
import xyz.prawl.core.protocol.VerificationReport
import xyz.prawl.core.protocol.VerifyLine
import xyz.prawl.core.util.Js
import xyz.prawl.core.util.arr
import xyz.prawl.core.util.bool
import xyz.prawl.core.util.objects
import xyz.prawl.core.util.optStr
import xyz.prawl.core.util.str
import java.math.BigInteger

/**
 * One payment over one link (the harness's Bluetooth exchange):
 *   payee -> payer: receive request
 *   payer -> payee: bundle, or "{}" if the payer's hardware refused
 *   payee -> payer: verdict
 *
 * Harness mode ([rich] = false) sends the verdict as the bare string ACCEPTED / REJECTED / NOTHING, exactly as
 * Wallet3Activity does. App-to-app sessions ([rich] = true) send a JSON verdict with every check line, so the
 * payer can show why a payment was rejected.
 */
object PaymentSession {
    enum class PayeeStatus { ACCEPTED, REJECTED, LINK_LOST, NO_PAYMENT }

    class PayeeResult(val status: PayeeStatus, val report: VerificationReport?, val paymentBytes: Int)

    /** Runs the payee side. The receive key stays pending unless the payment is accepted (safe retry). */
    fun payee(
        link: Link, request: ReceiveRequest, rich: Boolean, accept: (JsonObject) -> VerificationReport, log: (String) -> Unit = {},
        /** How long to wait for the payer's close-ack / disconnect after the verdict before closing ourselves. */
        ackTimeoutMs: Long = ACK_TIMEOUT_MS,
    ): PayeeResult {
        link.send(request.json.toString())
        val pay = try { link.recv() } catch (e: Exception) {
            log("link lost before payment arrived; receive key kept for retry")
            return PayeeResult(PayeeStatus.LINK_LOST, null, 0)
        }
        if (pay == "{}") {
            log("payer sent no payment (payer's secure hardware refused)")
            runCatching { link.send(if (rich) verdictJson("NOTHING", null).toString() else "NOTHING") }
            awaitPeerDone(link, ackTimeoutMs)
            return PayeeResult(PayeeStatus.NO_PAYMENT, null, pay.length)
        }
        val rep = try { accept(Js.parse(pay)) } catch (e: Exception) {
            log("payment unreadable: ${e.message}")
            runCatching { link.send(if (rich) verdictJson("REJECTED", null, listOf("unreadable payment")).toString() else "REJECTED") }
            awaitPeerDone(link, ackTimeoutMs)
            return PayeeResult(PayeeStatus.REJECTED, null, pay.length)
        }
        val v = if (rep.accepted) "ACCEPTED" else "REJECTED"
        runCatching { link.send(if (rich) verdictJson(v, rep).toString() else v) }
        // Do NOT close right after writing: the Bluetooth stack may still hold the verdict in its send queue, and
        // closing the socket then drops it (seen: Samsung payee -> OnePlus payer, EOF instead of a verdict). Wait for
        // the payer to acknowledge / hang up first; only then is our close safe.
        awaitPeerDone(link, ackTimeoutMs)
        return PayeeResult(if (rep.accepted) PayeeStatus.ACCEPTED else PayeeStatus.REJECTED, rep, pay.length)
    }

    /** Frame the payer sends once it has read the verdict ("close-ack"). Old harness payers just disconnect instead. */
    const val ACK = "ACK"
    const val ACK_TIMEOUT_MS = 4000L

    /**
     * Blocks until the peer sends a frame (its ACK), disconnects (EOF) or [timeoutMs] passes. The read runs on a
     * helper thread so a silent peer cannot hang the caller; the caller closes the link afterwards, which also
     * unblocks the helper.
     */
    fun awaitPeerDone(link: Link, timeoutMs: Long) {
        if (timeoutMs <= 0) return
        val t = Thread { runCatching { link.recv() } }.apply { isDaemon = true; start() }
        runCatching { t.join(timeoutMs) }
    }

    class Verdict(val verdict: String, val value: BigInteger?, val fails: List<String>, val lines: List<VerifyLine>) {
        val accepted get() = verdict == "ACCEPTED"
    }

    sealed class PayerResult {
        /** The payee answered. */
        class Answered(val outcome: OfflineWallet.PayOutcome.Paid, val verdict: Verdict) : PayerResult()
        /** Signed and sent, but the verdict never came: the payment is stored; reconnect to the same QR to resend. */
        class VerdictLost(val outcome: OfflineWallet.PayOutcome.Paid, val error: String) : PayerResult()
        class Refused(val outcome: OfflineWallet.PayOutcome.Refused) : PayerResult()
    }

    /** Runs the payer side; [pay] receives the payee's request (checks + signing happen there). */
    fun payer(link: Link, pay: (ReceiveRequest) -> OfflineWallet.PayOutcome, log: (String) -> Unit = {}): PayerResult {
        val req = ReceiveRequest(Js.parse(link.recv()))
        log("BT got request from '${req.name}'")
        when (val o = pay(req)) {
            is OfflineWallet.PayOutcome.Refused -> { runCatching { link.send("{}") }; return PayerResult.Refused(o) }
            is OfflineWallet.PayOutcome.Paid -> {
                return try {
                    link.send(o.bundle.toString())
                    val v = parseVerdict(link.recv())
                    log("BT payee verdict: ${v.verdict}")
                    // tell the payee it may close now (it waits for this so the verdict is never cut off)
                    runCatching { link.send(ACK) }
                    PayerResult.Answered(o, v)
                } catch (e: Exception) {
                    log("link lost after signing: payment stored, reconnect to resend the same bytes")
                    PayerResult.VerdictLost(o, e.message ?: e.toString())
                }
            }
        }
    }

    fun verdictJson(verdict: String, rep: VerificationReport?, extraFails: List<String> = emptyList()): JsonObject = buildJsonObject {
        put("v", 1); put("verdict", verdict)
        rep?.let { put("value", it.receivedValue.toString()) }
        put("fails", buildJsonArray { (rep?.fails.orEmpty() + extraFails).forEach { add(JsonPrimitive(it)) } })
        put("lines", buildJsonArray {
            rep?.lines?.forEach { l -> add(buildJsonObject { put("step", l.step); put("title", l.title); put("ok", l.ok); put("detail", l.detail) }) }
        })
    }

    fun parseVerdict(s: String): Verdict {
        val t = s.trim()
        if (!t.startsWith("{")) return Verdict(t, null, emptyList(), emptyList())
        val j = Js.parse(t)
        return Verdict(j.str("verdict"), j.optStr("value")?.let { BigInteger(it) },
            j["fails"]?.let { (it as? kotlinx.serialization.json.JsonArray)?.map { e -> (e as JsonPrimitive).content } } ?: emptyList(),
            j.arr("lines").objects().map { VerifyLine(it.str("step"), it.str("title"), it.bool("ok"), it.str("detail")) })
    }
}
