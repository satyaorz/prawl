package xyz.prawl.offline.harness

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.widget.ScrollView
import android.widget.TextView
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import xyz.prawl.core.android.BiometricApprover
import xyz.prawl.core.android.BluetoothTransport
import xyz.prawl.core.android.DeviceSelfTest
import xyz.prawl.core.deposit.DepositCommitment
import xyz.prawl.core.deposit.SnapshotDepositVerifier
import xyz.prawl.core.handoff.Handoff
import xyz.prawl.core.keys.KeySpec
import xyz.prawl.core.model.ReceiveRequest
import xyz.prawl.core.protocol.OfflineWallet
import xyz.prawl.core.protocol.OfflineWallet.PayOutcome
import xyz.prawl.core.protocol.Escrows
import xyz.prawl.core.protocol.ShieldRequest
import xyz.prawl.core.transport.PayQr
import xyz.prawl.core.transport.PaymentSession
import xyz.prawl.core.transport.SecureLink
import xyz.prawl.core.util.Eth
import xyz.prawl.core.util.Js
import xyz.prawl.offline.graph
import java.io.File
import java.security.SecureRandom
import java.util.UUID

/**
 * DEBUG-ONLY harness mode: the Java harness's `Wallet3Activity` commands and files, on top of the app's `:core`.
 * Same intent extras, same `files/in`, `files/out`, `files/wallet`, `files/certs`, same logcat tag (PRAWL_W2)
 * and the same `END <status>` line, so the coordinator's w2_lib.sh / w3_lib.sh scripts drive it unchanged.
 *
 * Component: `<applicationId>/xyz.prawl.offline.harness.HarnessActivity`; in the compat flavor
 * (applicationId xyz.prawl.otktest) also `xyz.prawl.otktest/xyz.prawl.otktest.Wallet3Activity` (activity-alias).
 *
 * Commands (extra "cmd"), as Wallet3Activity:
 *   mint      coin eth [expiresIn] [chainId] [escrow] [depositor] [multiuse] [auth]  -> out/mint3_<coin>.json (+ out/handoff_load_<coin>.json)
 *   request   name [auth]                               -> out/req_<name>.json
 *   pay       coin amount req [note] [precheck=false] [silent=true] -> out/pay3_<coin>_<name>.json
 *   accept    pay name [snapshot]                       -> ACCEPTED / REJECTED
 *   redeem    coin payout                               -> out/redeem3_<coin>_<alias>.json (+ out/handoff_redeem_…json)
 *   bt3_receive name snapshot [auth] | bt3_pay coin amount addr   (plaintext RFCOMM, harness UUID: interop with the Java harness)
 *   show | perm
 * v3.1 (escrow 0x236b…d779; refused on v3):
 *   redeem    coin shield=<file>                        shield-target JSON (or bare request) in files/in -> out/redeem3_… + out/handoff_redeem_shield_….json
 *                                                       (refuses unless value == the note, plain WETH, matching escrow)
 *   refresh   coin depositor=<reclaim addr> [expiresIn] [note=<alias>] [label=<new>] -> out/refresh3_<coin>_<alias>.json,
 *                                                       out/handoff_refresh_….json; logs "REFRESH newCoinId 0x…"
 *   mark_refreshed newcoin=<hex>                        the refresh landed: the new coin's genesis note appears
 *   load_private coin eth depositor=<reclaim addr> [expiresIn] [chainId] [escrow] [tip=<eth>] -> out/mint3_<coin>.json,
 *                                                       out/handoff_load_private_<coin>.json (params + depositAddress)
 *   any command: v31escrow=<addr> [chainId] also treats that escrow as v3.1 (local anvil)
 * New:
 *   ble_receive name [snapshot] [transport=rfcomm]      -> out/qr_<name>.txt (the receive code), then listens (encrypted)
 *   ble_pay     coin amount qr                          (qr = file in files/in holding the prawl://offline/pay link)
 *   selftest | lc_sync | lc_proof coin | import_snapshot file
 * A carried light-client `depositProof` is checked first; the `snapshot` file is the fallback, as in the app.
 */
class HarnessActivity : Activity() {
    private val out = StringBuilder()
    private lateinit var tv: TextView
    private lateinit var inDir: File
    private lateinit var outDir: File

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        tv = TextView(this).apply { setTextIsSelectable(true); setPadding(24, 24, 24, 24); textSize = 12f }
        setContentView(ScrollView(this).apply { addView(tv) })
        inDir = File(filesDir, "in").apply { mkdirs() }
        outDir = File(filesDir, "out").apply { mkdirs() }
        val x = intent.extras ?: Bundle()
        if (x.getString("cmd") == "perm") {
            log("requesting Bluetooth and camera permissions: tap Allow")
            requestPermissions(arrayOf(Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_SCAN,
                Manifest.permission.BLUETOOTH_ADVERTISE, Manifest.permission.CAMERA), 7)
            return
        }
        Thread {
            val status = try { run(x) } catch (t: Throwable) { log("ERROR $t"); Log.e(TAG, "err", t); "ERROR" }
            log("END $status")
        }.start()
    }

    override fun onRequestPermissionsResult(code: Int, perms: Array<out String>, res: IntArray) {
        val b = StringBuilder()
        for (i in perms.indices) b.append(perms[i].replace("android.permission.", "")).append('=')
            .append(if (res[i] == PackageManager.PERMISSION_GRANTED) "granted " else "DENIED ")
        log("permission result: $b")
        log("END " + if (b.contains("DENIED")) "DENIED" else "OK")
    }

    private fun log(s: String) {
        Log.i(TAG, s)
        synchronized(out) { out.append(s).append('\n') }
        runOnUiThread { tv.text = synchronized(out) { out.toString() } }
    }

    private fun read(name: String) = File(inDir, name).readText()
    private fun write(name: String, s: String) = File(outDir, name).writeText(s)

    private fun snapshot(name: String?) = name?.let { SnapshotDepositVerifier(Js.parse(read(it))) }
    /** Extra escrow treated as v3.1 (local anvil tests): extras `v31escrow` (+ `chainId`, default 11155111). */
    private var v31Extra: Set<Pair<String, String>> = emptySet()

    private fun wallet(snapshotFile: String? = null): OfflineWallet = graph.harnessWallet(snapshot(snapshotFile), ::log, v31Extra)

    private fun handoffFile(kind: String, payload: JsonObject): String {
        val d = Handoff.encode(payload)
        return buildJsonObject {
            put("payload", payload); put("d", d)
            put("https", Handoff.httpsLink(xyz.prawl.offline.BuildConfig.HANDOFF_SITE, kind, d)); put("prawl", Handoff.prawlLink(kind, d))
        }.toString()
    }

    private fun run(x: Bundle): String {
        val cmd = x.getString("cmd", "show")
        log("v3 cmd=$cmd on ${Build.MANUFACTURER} ${Build.MODEL}")
        val auth = x.getString("auth") == "true"
        val g = graph
        v31Extra = x.getString("v31escrow")?.let { e -> Eth.normalize40(e)?.let { setOf((x.getString("chainId") ?: "11155111") to it) } } ?: emptySet()
        when (cmd) {
            "mint" -> {
                val label = x.getString("coin")!!
                val m = wallet().mint(label, Eth.wei(x.getString("eth")!!), (x.getString("expiresIn") ?: (14 * 86400).toString()).toLong(),
                    x.getString("chainId") ?: "11155111", x.getString("escrow") ?: "00000000000000000000000000000000000e5c70",
                    x.getString("depositor") ?: "0".repeat(40), KeySpec(singleUse = x.getString("multiuse") != "true", userAuthPerUse = auth))
                write("mint3_$label.json", m.mintFile.toString())
                write("handoff_load_$label.json", handoffFile("load", m.handoff))
                return "OK"
            }
            "request" -> {
                val name = x.getString("name")!!
                write("req_$name.json", wallet().request(name, KeySpec(userAuthPerUse = auth)).json.toString())
                return "OK"
            }
            "pay" -> {
                val req = ReceiveRequest(Js.parse(read(x.getString("req")!!)))
                val coin = x.getString("coin")!!
                val approver = if (x.getString("silent") == "true") null else BiometricApprover(this)
                return when (val o = wallet().pay(Eth.wei(x.getString("amount")!!), req, approver,
                    OfflineWallet.PayOptions(coinLabel = coin, forceNote = x.getString("note"), payerPrechecks = x.getString("precheck") != "false"))) {
                    is PayOutcome.Paid -> { write("pay3_${coin}_${req.name}.json", o.bundle.toString()); "OK" }
                    is PayOutcome.Refused -> { log("refused: ${o.reason}"); "REFUSED" }
                }
            }
            "accept" -> {
                val rep = wallet(x.getString("snapshot")).accept(Js.parse(read(x.getString("pay")!!)), x.getString("name")!!)
                return if (rep.accepted) "ACCEPTED" else "REJECTED"
            }
            "redeem" -> {
                val coin = x.getString("coin")!!
                val w = wallet()
                val shieldFile = x.getString("shield")
                if (shieldFile != null) {
                    // cash out into a RAILGUN shield: the note whose value equals the request's value exactly (Wallet3Activity.redeemShield)
                    val target = Js.parse(read(shieldFile))
                    val req = try { ShieldRequest.parse(target) } catch (e: Exception) { log("REFUSED: ${e.message}"); return "REFUSED" }
                    val note = g.notes.notes().firstOrNull { !it.spent && !it.pendingDeposit && it.label == coin && it.value == req.value }
                        ?: run { log("REFUSED: no unspent note of $coin worth exactly ${req.value} wei (shield value must equal the note)"); return "REFUSED" }
                    return when (val o = w.redeemShield(note.alias, target, BiometricApprover(this))) {
                        is OfflineWallet.RedeemOutcome.Signed -> {
                            write("redeem3_${coin}_${note.alias}.json", o.bundle.toString())
                            write("handoff_redeem_shield_${coin}_${note.alias}.json", handoffFile("redeem-shield", o.handoff))
                            "OK"
                        }
                        is OfflineWallet.RedeemOutcome.Refused -> { log("REFUSED: ${o.reason}"); "REFUSED" }
                    }
                }
                val note = g.notes.notes().firstOrNull { !it.spent && !it.pendingDeposit && it.label == coin }
                    ?: run { log("no unspent note of $coin"); return "NONE" }
                return when (val o = w.redeem(note.alias, x.getString("payout")!!, BiometricApprover(this))) {
                    is OfflineWallet.RedeemOutcome.Signed -> {
                        write("redeem3_${coin}_${note.alias}.json", o.bundle.toString())
                        write("handoff_redeem_${coin}_${note.alias}.json", handoffFile("redeem", o.handoff))
                        "OK"
                    }
                    is OfflineWallet.RedeemOutcome.Refused -> { log("refused: ${o.reason}"); "REFUSED" }
                }
            }
            "refresh" -> {
                // sign a note into a new coin: coin=<label> depositor=<reclaim address> [expiresIn=<s>, default 14 d] [note=<alias>] [label=<new label>]
                val coin = x.getString("coin")!!
                val note = g.notes.notes().firstOrNull { !it.spent && !it.pendingDeposit && it.label == coin && (x.getString("note") == null || it.alias == x.getString("note")) }
                    ?: run { log("no unspent note of $coin"); return "NONE" }
                val secs = (x.getString("expiresIn") ?: (14 * 86400).toString()).toLong()
                return when (val o = wallet().refresh(note.alias, secs, x.getString("depositor")!!, BiometricApprover(this), x.getString("label"))) {
                    is OfflineWallet.RefreshOutcome.Signed -> {
                        write("refresh3_${coin}_${note.alias}.json", o.bundle.toString())
                        write("handoff_refresh_${coin}_${note.alias}.json", handoffFile("refresh", o.handoff))
                        log("REFRESH newCoinId 0x${o.newCoinId} newExpiry ${o.newExpiry}")
                        "OK"
                    }
                    is OfflineWallet.RefreshOutcome.Refused -> { log("refused: ${o.reason}"); "REFUSED" }
                }
            }
            "mark_refreshed" -> {
                // newcoin=<hex coin id from the refresh>: the refresh landed, create the new coin's genesis note
                val n = wallet().markRefreshed(x.getString("newcoin")!!)
                log("new coin live: label ${n.label}, coinId ${n.header.coinId}, ${Eth.eth(n.value)} ETH")
                return "OK"
            }
            "load_private" -> {
                // coin=<label> eth=<value> depositor=<RECLAIM address> [expiresIn] [chainId] [escrow, default v3.1] [tip=<eth>]
                val label = x.getString("coin")!!
                val m = wallet().mint(label, Eth.wei(x.getString("eth")!!), (x.getString("expiresIn") ?: (14 * 86400).toString()).toLong(),
                    x.getString("chainId") ?: "11155111", x.getString("escrow") ?: ("0x" + Escrows.SEPOLIA_V31), x.getString("depositor")!!,
                    KeySpec(userAuthPerUse = auth), privateLoad = true, tipWei = x.getString("tip")?.let { Eth.wei(it) } ?: java.math.BigInteger.ZERO)
                write("mint3_$label.json", m.mintFile.toString())
                write("handoff_load_private_$label.json", handoffFile("load-private", m.handoffPrivate))
                log("depositAddress " + m.handoffPrivate.let { (it["depositAddress"] as kotlinx.serialization.json.JsonPrimitive).content })
                return "OK"
            }
            "bt3_receive" -> {
                val name = x.getString("name")!!
                val w = wallet(x.getString("snapshot"))
                val req = w.request(name, KeySpec(userAuthPerUse = auth))
                val l = g.bluetooth.RfcommListener(BluetoothTransport.HARNESS_UUID, "PrawlOTK3")
                log("BT LISTENING as '$name' (offline)")
                val s = try { l.accept(120_000) } finally { l.close() }
                val t0 = System.nanoTime()
                val r = s.use { PaymentSession.payee(g.bluetooth.link(it), req, rich = false, accept = { b -> w.accept(b, name) }, log = ::log) }
                log("BT session ${(System.nanoTime() - t0) / 1_000_000} ms, payment ${r.paymentBytes} B")
                return r.status.name
            }
            "bt3_pay" -> {
                val t0 = System.nanoTime()
                val s = g.bluetooth.connectRfcommByAddress(x.getString("addr")!!, BluetoothTransport.HARNESS_UUID)
                val w = wallet()
                val amount = Eth.wei(x.getString("amount")!!)
                val r = s.use { PaymentSession.payer(g.bluetooth.link(it), { req ->
                    w.pay(amount, req, BiometricApprover(this), OfflineWallet.PayOptions(coinLabel = x.getString("coin")))
                }, ::log) }
                log("BT total ${(System.nanoTime() - t0) / 1_000_000} ms")
                return payerStatus(r)
            }
            "ble_receive" -> {
                val name = x.getString("name")!!
                val w = wallet(x.getString("snapshot"))
                val req = w.request(name, KeySpec(userAuthPerUse = auth))
                val secret = ByteArray(16).also { SecureRandom().nextBytes(it) }
                val uuid = UUID.randomUUID()
                val rf = x.getString("transport") == PayQr.RFCOMM
                val (listener, qr) = if (rf) g.bluetooth.RfcommListener(uuid, "Prawl") to
                    PayQr(name, w.pendingKeyHash(name)!!, secret, PayQr.RFCOMM, uuid, btName = g.bluetooth.localName())
                else g.bluetooth.L2capListener(uuid).let { it to PayQr(name, w.pendingKeyHash(name)!!, secret, PayQr.L2CAP, uuid, psm = it.psm) }
                write("qr_$name.txt", qr.link())
                log("QR ${qr.link()}")
                log("BT LISTENING as '$name' (${qr.transport}, encrypted)")
                val s = try { listener.accept(120_000) } finally { listener.close() }
                val t0 = System.nanoTime()
                val r = s.use {
                    PaymentSession.payee(SecureLink(g.bluetooth.link(it), secret, qr.sessionId(), SecureLink.Role.PAYEE), req, rich = true,
                        accept = { b -> w.accept(b, name) }, log = ::log)
                }
                log("BT session ${(System.nanoTime() - t0) / 1_000_000} ms, payment ${r.paymentBytes} B")
                return r.status.name
            }
            "ble_pay" -> {
                val qr = PayQr.parse(read(x.getString("qr")!!).trim())
                val t0 = System.nanoTime()
                val s = if (qr.transport == PayQr.RFCOMM) g.bluetooth.connectRfcommByDiscovery(qr.btName!!, qr.serviceUuid, log = ::log)
                else g.bluetooth.connectL2cap(qr.serviceUuid, qr.psm!!, log = ::log)
                val w = wallet()
                val amount = Eth.wei(x.getString("amount")!!)
                val r = s.use {
                    PaymentSession.payer(SecureLink(g.bluetooth.link(it), qr.secret, qr.sessionId(), SecureLink.Role.PAYER), { req ->
                        if (req.name != qr.id) PayOutcome.Refused("request does not match the code")
                        else w.pay(amount, req, BiometricApprover(this), OfflineWallet.PayOptions(coinLabel = x.getString("coin"), expectedKeyHash = qr.keyHash))
                    }, ::log)
                }
                log("BT total ${(System.nanoTime() - t0) / 1_000_000} ms")
                return payerStatus(r)
            }
            "selftest" -> {
                val r = DeviceSelfTest(applicationContext, g.keys, g.checker()).run()
                log("device ${r.device}, Android ${r.androidRelease} (SDK ${r.sdk}); strongbox=${r.strongBoxFeature} single_use_key=${r.singleUseFeature}")
                log("key in ${r.keygenMs} ms; attestation: ${r.attestation.summary()}; hwLimit=${r.attestation.usageLimitInHardware}")
                log("sign #1 ${if (r.firstSignOk && r.firstSignVerified) "OK" else "FAILED"}; sign #2 ${if (r.secondSignRefused) "REFUSED" else "SIGNED"}: ${r.secondSignMessage}")
                r.error?.let { log("error: $it") }
                return if (r.pass) "PASS" else "FAIL"
            }
            "lc_sync" -> { log(g.lightClient.syncCommittees()); return "OK" }
            "lc_proof" -> {
                val note = g.notes.notes().firstOrNull { it.label == x.getString("coin") && it.isGenesis } ?: return "NONE"
                if (g.lightClient.cache() == null) log(g.lightClient.syncCommittees())
                val h = note.header
                val r = g.lightClient.buildProof(h.escrow, h.coinId, DepositCommitment.commitment(h))
                log("proof: ${r.summary()}")
                if (r.ok && note.pendingDeposit) wallet().markDeposited(note.alias, "light-client")
                return if (r.ok) "OK" else "FAIL"
            }
            "import_snapshot" -> { log("installed " + g.depositSources.install(Js.parse(read(x.getString("file")!!)))); return "OK" }
            else -> return wallet().show()
        }
    }

    private fun payerStatus(r: PaymentSession.PayerResult): String = when (r) {
        is PaymentSession.PayerResult.Answered -> { log("BT payee verdict: ${r.verdict.verdict}" + if (r.verdict.fails.isNotEmpty()) " ${r.verdict.fails}" else ""); "PAID:${r.verdict.verdict}" }
        is PaymentSession.PayerResult.VerdictLost -> { log("no verdict (${r.error}); payment stored for resend"); "LINK_LOST" }
        is PaymentSession.PayerResult.Refused -> { log("refused: ${r.outcome.reason}"); "REFUSED" }
    }

    companion object { const val TAG = "PRAWL_W2" }
}

