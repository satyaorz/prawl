package xyz.prawl.offline.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.RadioButton
import androidx.compose.material3.RadioButtonDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import xyz.prawl.core.android.BiometricApprover
import xyz.prawl.core.handoff.Handoff
import xyz.prawl.core.model.Note
import xyz.prawl.core.protocol.Escrows
import xyz.prawl.core.protocol.OfflineWallet
import xyz.prawl.core.protocol.ShieldRequest
import xyz.prawl.core.util.Eth
import xyz.prawl.core.util.Js
import xyz.prawl.core.util.str
import xyz.prawl.offline.BuildConfig
import xyz.prawl.offline.LocalHostActivity
import xyz.prawl.offline.Nav
import xyz.prawl.offline.graph
import xyz.prawl.offline.ui.Fmt
import xyz.prawl.offline.ui.components.CheckList
import xyz.prawl.offline.ui.components.ConfirmDialog
import xyz.prawl.offline.ui.components.Field
import xyz.prawl.offline.ui.components.HandoffActions
import xyz.prawl.offline.ui.components.Mono
import xyz.prawl.offline.ui.components.PCard
import xyz.prawl.offline.ui.components.Page
import xyz.prawl.offline.ui.components.PermissionGate
import xyz.prawl.offline.ui.components.Perms
import xyz.prawl.offline.ui.components.PrimaryButton
import xyz.prawl.offline.ui.components.QrImage
import xyz.prawl.offline.ui.components.QrScanner
import xyz.prawl.offline.ui.components.Secondary
import xyz.prawl.offline.ui.components.SecondaryButton
import xyz.prawl.offline.ui.components.Segmented
import xyz.prawl.offline.ui.components.StatusLine
import xyz.prawl.offline.ui.theme.Status
import xyz.prawl.offline.ui.theme.Tw

/** A signed redemption ready for the website: HANDOFF payload (`redeem` or `redeem-shield`) + the full phone file. */
private data class Signed(val alias: String, val valueWei: java.math.BigInteger, val where: String, val kind: String, val https: String, val prawl: String, val fileName: String, val fileJson: String)

private fun signedOf(n: Note): Signed? {
    val bundle = n.json["redeemBundle"]?.let { (it as? kotlinx.serialization.json.JsonPrimitive)?.content } ?: return null
    if (n.redeemedTo == null) return null
    val p = runCatching { Handoff.redeem(Js.parse(bundle), null) }.getOrNull() ?: return null
    val kind = p.str("t")
    val d = Handoff.encode(p)
    val where = if (kind == "redeem-shield") "private balance" else Fmt.addr(n.redeemedTo!!.removePrefix("0x"))
    return Signed(n.alias, n.value, where, kind, Handoff.httpsLink(BuildConfig.HANDOFF_SITE, kind, d), Handoff.prawlLink(kind, d), "redeem3_${n.label}_${n.alias}.json", bundle)
}

/** A `shield-target` from a link (`https://…/#/offline/shield-target?d=…`, `prawl://offline/shield-target?d=…`) or raw JSON. */
fun parseShieldTarget(text: String): JsonObject {
    val t = text.trim()
    return if (t.startsWith("{")) Js.parse(t)
    else Handoff.parseLink(t).also { require(it.kind == "shield-target") { "that is a '${it.kind}' link, not a private-balance target" } }.payload
}

/**
 * Cash out: pick a note, then either
 *  - to an ADDRESS: sign a redemption to a PRAWL-REDEEM output (the website submits redeem(...)); or
 *  - to a PRIVATE BALANCE (escrow v3.1): paste/scan the website's `shield-target`, check that its value equals the note exactly,
 *    and sign a redemption whose output is bound to that exact RAILGUN ShieldRequest (the website submits redeemToShield(...)).
 * Anyone may submit; the destination is fixed by the signature.
 */
@Composable
fun CashOutScreen(nav: Nav, payoutIn: String?, shieldIn: String? = null) {
    val ctx = LocalContext.current
    val g = ctx.graph
    val activity = LocalHostActivity.current
    val scope = rememberCoroutineScope()
    val version by g.version.collectAsState()
    val now = System.currentTimeMillis() / 1000
    val allNotes = remember(version) { g.notes.notes().filter { !it.spent && !it.pendingDeposit && it.header.expiry > now }.sortedBy { it.header.expiry } }
    val signed = remember(version) { g.notes.notes().filter { it.redeemedTo != null }.mapNotNull { signedOf(it) }.reversed() }
    var mode by remember { mutableStateOf(if (shieldIn != null) "private" else "address") }
    var shieldText by remember { mutableStateOf(shieldIn ?: "") }
    var payout by remember { mutableStateOf(payoutIn ?: g.settings.lastDepositor?.let { Eth.checksum(it) } ?: "") }
    var scanning by remember { mutableStateOf(false) }
    var scanningShield by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var showing by remember { mutableStateOf<String?>(null) }
    val addr = Eth.validateAddress(payout)
    val priv = mode == "private"
    val notes = if (priv) allNotes.filter { Escrows.isV31(it.header.chainId, it.header.escrow) } else allNotes
    var pickRaw by remember { mutableStateOf(allNotes.firstOrNull()?.alias) }
    var askTick by remember { mutableStateOf(0) }
    var ask by remember { mutableStateOf<JsonObject?>(null) }
    var confirming by remember { mutableStateOf(false) }

    // private mode: parse the target and auto-pick the note whose value equals the request's
    val target: Result<JsonObject>? = remember(shieldText) { if (shieldText.isBlank()) null else runCatching { parseShieldTarget(shieldText) } }
    val request = target?.getOrNull()?.let { runCatching { ShieldRequest.parse(it) }.getOrNull() }
    val autoNote = request?.let { r -> g.wallet().notesForShield(r.value).firstOrNull() }
    val pick = if (priv && autoNote != null && notes.none { it.alias == pickRaw && it.value == request?.value }) autoNote.alias
        else if (notes.any { it.alias == pickRaw }) pickRaw else notes.firstOrNull()?.alias
    val picked = notes.firstOrNull { it.alias == pick }
    val check = if (priv && picked != null && target?.isSuccess == true) g.wallet().checkShield(picked, target.getOrThrow()) else null
    // HANDOFF v1.2 §11: each ask has a fresh nonce; the website echoes it in the shield-target, so the target is bound to THIS phone's request
    androidx.compose.runtime.LaunchedEffect(priv, picked?.alias, askTick) {
        ask = if (priv && picked != null) withContext(Dispatchers.IO) { runCatching { g.wallet().shieldAsk(picked.alias) }.getOrNull() } else null
    }

    Page("Cash out", nav::back) {
        val current = signed.firstOrNull { it.alias == showing }
        if (current != null) PCard(title = "Redemption signed · ${Fmt.eth(current.valueWei)} ETH",
            subtitle = if (current.kind == "redeem-shield") "Goes into your private balance. Open in the wallet to submit it on-chain." else "Pays ${current.where}. Open in the wallet to submit it on-chain.") {
            HandoffActions(current.https, current.prawl, BuildConfig.HANDOFF_SITE, current.fileName, current.fileJson)
            Secondary("Keep this until the payout arrives: the note's key is used up, this signed redemption is the money.", color = Tw.amber400)
        }
        error?.let { PCard(border = Tw.red400.copy(alpha = 0.5f)) { StatusLine(Status.ERROR, it) } }

        // The main way out: into this wallet's own private balance (nothing to type, nothing public about where it went).
        val walletNotes = allNotes.filter { Escrows.isV31(it.header.chainId, it.header.escrow) }
        val toWallet = g.cashOutToWallet
        if (toWallet != null) PCard(title = "Cash out to my wallet",
            subtitle = "Into your private balance in the Wallet tab: the most private way out. You approve here with your fingerprint, then the wallet submits it.") {
            if (walletNotes.isEmpty()) Secondary("No note can go into a private balance (only coins on escrow v3.1 can). Use another address below.")
            walletNotes.forEach { n ->
                Row(Modifier.fillMaxWidth().padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                    Mono(Fmt.eth(n.value) + " ETH", Modifier.weight(1f))
                    SecondaryButton("To my wallet", { error = null; toWallet(n.header.coinId, n.noteId) })
                }
            }
        }
        if (toWallet != null) Secondary("Or cash out another way:")
        Segmented(listOf("address" to "Another address", "private" to "A private-balance code"), mode) { mode = it; error = null }

        PCard(title = "Note to cash out") {
            if (notes.isEmpty()) Secondary(if (priv) "No notes on escrow v3.1. Only v3.1 coins can be cashed out into a private balance." else "No spendable notes.")
            notes.forEach { n ->
                Row(Modifier.fillMaxWidth().clickable { pickRaw = n.alias }.padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                    RadioButton(pick == n.alias, { pickRaw = n.alias }, colors = RadioButtonDefaults.colors(selectedColor = Tw.emerald400, unselectedColor = Tw.zinc500))
                    Mono(Fmt.eth(n.value) + " ETH", Modifier.weight(1f))
                    Secondary("expires in ${Fmt.left(n.header.expiry - now)} · hop ${n.depth}")
                }
            }
        }

        if (!priv) PCard(title = "Pay out to", subtitle = "Any Ethereum address. The address and the amount become public.") {
            Field(payout, { payout = it }, "Payout address (0x…)", mono = true, error = if (payout.isNotBlank() && !addr.ok) addr.note else null)
            if (scanning) PermissionGate(Perms.CAMERA, "Camera needed to scan", "Scan the address code shown by the Prowl website.") {
                QrScanner(onResult = { t -> scanning = false; Eth.parseEip681(t)?.let { payout = Eth.checksum(it.addr40) } ?: run { error = "Not an Ethereum address code" } })
            } else SecondaryButton("Scan wallet address", { scanning = true })
        } else PCard(title = "Private balance (RAILGUN)", subtitle = "The wallet builds a shield request for exactly the note's value. Scan or paste it here.") {
            if (picked != null) {
                Secondary("Cash out")
                Mono(Fmt.eth(picked.value) + " ETH", style = Tw.bigMono.copy(fontSize = 22.sp))
                Secondary("to a private balance. Show this code to the wallet: it builds a request for exactly this value and answers with the one-time number in the code.")
                ask?.let { a ->
                    QrImage(Handoff.httpsLink(BuildConfig.HANDOFF_SITE, "shield-ask", Handoff.encode(a)))
                    Secondary("Request number ${a.str("nonce").take(8)}… · valid for 30 minutes, works once")
                    SecondaryButton("New request code", { askTick++ })
                }
            }
            Field(shieldText, { shieldText = it; error = null }, "Shield target link from the wallet", mono = true, singleLine = false,
                error = target?.exceptionOrNull()?.let { "Not a shield target: ${it.message}" })
            if (scanningShield) PermissionGate(Perms.CAMERA, "Camera needed to scan", "Scan the shield-target code shown by the Prowl website.") {
                QrScanner(onResult = { t -> scanningShield = false; shieldText = t })
            } else SecondaryButton("Scan shield target", { scanningShield = true })
            if (request != null) {
                Secondary("Request value ${Fmt.eth(request.value)} ETH · token 0x${request.tokenAddress40.take(6)}…${request.tokenAddress40.takeLast(4)}")
                Secondary("Destination (npk), in full:")
                Mono("0x" + request.npk.toString(16).padStart(64, '0'), style = Tw.mono.copy(fontSize = 12.sp))
            }
            check?.let { CheckList(it.lines) }
            check?.warning?.let { StatusLine(Status.PENDING, it) }
            Secondary("RAILGUN keeps its 0.25 % shield fee: the private note is worth 99.75 % of the value. The whole request is bound by your signature; nobody can swap the recipient or the encrypted note data.")
            if (picked != null && target?.isSuccess == true && request != null && request.value != picked.value && autoNote == null)
                Secondary("No note is worth exactly ${Fmt.eth(request.value)} ETH. Ask the wallet for a request for ${Fmt.eth(picked.value)} ETH.", color = Tw.amber400)
        }

        PrimaryButton(if (busy) "Signing…" else if (priv) "Review & sign private cash out" else "Review & sign redemption", {
            confirming = true
        }, enabled = pick != null && !busy && (if (priv) check?.ok == true else addr.ok))

        // The confirmation shows the WHOLE destination (address, or the whole npk), never a prefix (audit F-03).
        if (confirming && picked != null) {
            val npkFull = request?.let { "0x" + it.npk.toString(16).padStart(64, '0') }
            ConfirmDialog(
                title = if (priv) "Cash out to this private balance?" else "Cash out to this address?",
                text = (if (priv) "${Fmt.eth(picked.value)} ETH goes into the RAILGUN account with this key (npk). " else "${Fmt.eth(picked.value)} ETH is paid to this address. ") +
                    "It cannot be redirected or undone after you approve. Compare every character with what your wallet shows.",
                confirm = "Approve with fingerprint / PIN",
                mono = if (priv) npkFull else addr.addr40?.let { Eth.checksum(it) },
                warning = if (priv) check?.warning else null,
                onConfirm = {
                    val alias = picked.alias
                    val act = activity
                    if (act != null) {
                        busy = true; error = null
                        scope.launch {
                            val r = withContext(Dispatchers.IO) {
                                runCatching {
                                    if (priv) g.wallet().redeemShield(alias, target!!.getOrThrow(), BiometricApprover(act))
                                    else g.wallet().redeem(alias, addr.addr40!!, BiometricApprover(act))
                                }
                            }
                            busy = false
                            r.onSuccess { o ->
                                when (o) {
                                    is OfflineWallet.RedeemOutcome.Signed -> { g.changed(); showing = alias }
                                    is OfflineWallet.RedeemOutcome.Refused -> error = o.reason
                                }
                            }.onFailure { error = it.message ?: it.toString() }
                        }
                    }
                },
                onDismiss = { confirming = false },
            )
        }

        if (signed.isNotEmpty()) PCard(title = "Signed redemptions") {
            signed.forEach { s ->
                Row(Modifier.fillMaxWidth().clickable { showing = s.alias }.padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Mono(Fmt.eth(s.valueWei) + " ETH", Modifier.weight(1f))
                    Secondary("→ " + s.where)
                }
            }
        }
    }
}
