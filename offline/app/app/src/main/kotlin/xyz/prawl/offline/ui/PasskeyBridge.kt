package xyz.prawl.offline.ui

import android.app.Activity
import android.util.Log
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.CreateCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.NoCredentialException
import androidx.credentials.exceptions.publickeycredential.CreatePublicKeyCredentialDomException
import androidx.credentials.exceptions.publickeycredential.GetPublicKeyCredentialDomException
import androidx.webkit.JavaScriptReplyProxy
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import xyz.prawl.core.util.Js
import xyz.prawl.core.util.obj
import xyz.prawl.core.util.optStr
import xyz.prawl.core.util.str

/**
 * Passkeys for the Wallet tab through Android's Credential Manager, the same system Chrome uses: it sees every passkey provider and every
 * Google account on the phone. The WebView's built-in WebAuthn goes through an older Play services path that, on some phones (seen on a
 * OnePlus), finds no passkey that Chrome finds, and only offers "use another device".
 *
 * The page's own `navigator.credentials.create/get` are routed here by [JS] (document-start, our origin only). The request is the standard
 * WebAuthn JSON; nothing about the passkey changes, so a wallet made in a browser or the old way opens the same. The answer goes back as
 * the standard response JSON (with the PRF result the wallet needs). If Credential Manager cannot serve a request (no passkey found, no
 * provider), the page falls back to the WebView's own WebAuthn, so nothing works worse than before.
 *
 * Only passkeys for [rpId] (the wallet site's host) can be asked for: the page cannot use the app to reach another site's passkeys.
 */
class PasskeyBridge(private val activity: Activity, private val rpId: String, private val debug: Boolean) {
    private val cm = CredentialManager.create(activity)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    fun handle(text: String, reply: JavaScriptReplyProxy) {
        scope.launch { reply.postMessage(answer(text)) }
    }

    fun destroy() = scope.cancel()

    private suspend fun answer(text: String): String {
        var id = "-1"
        return try {
            val m = Js.parse(text)
            id = m.str("id")
            val op = m.str("op")
            val opts = m.obj("options")
            val json = when (op) {
                "create" -> {
                    val rp = opts["rp"]?.jsonObject ?: throw Refused("SecurityError", "no relying party")
                    if (rp["id"]?.jsonPrimitive?.content != rpId) throw Refused("SecurityError", "passkeys are only for $rpId here")
                    val r = cm.createCredential(activity, CreatePublicKeyCredentialRequest(opts.toString())) as CreatePublicKeyCredentialResponse
                    r.registrationResponseJson
                }
                "get" -> {
                    val asked = opts.optStr("rpId")
                    if (asked != null && asked != rpId) throw Refused("SecurityError", "passkeys are only for $rpId here")
                    val full = JsonObject(opts + ("rpId" to JsonPrimitive(rpId)))
                    val r = cm.getCredential(activity, GetCredentialRequest(listOf(GetPublicKeyCredentialOption(full.toString()))))
                    (r.credential as? PublicKeyCredential)?.authenticationResponseJson ?: throw Fallback("not a passkey answer")
                }
                else -> throw Refused("NotSupportedError", "unknown passkey operation")
            }
            if (debug) Log.i(TAG, "passkey $op via Credential Manager: ok")
            buildJsonObject { put("id", id); put("ok", true); put("json", json) }.toString()
        } catch (e: Refused) {
            fail(id, e.name, e.message ?: e.name, fallback = false)
        } catch (e: GetCredentialCancellationException) {
            fail(id, "NotAllowedError", "Passkey request was cancelled", fallback = false)
        } catch (e: CreateCredentialCancellationException) {
            fail(id, "NotAllowedError", "Passkey request was cancelled", fallback = false)
        } catch (e: GetPublicKeyCredentialDomException) {
            fail(id, domName(e.domError.type), e.errorMessage?.toString() ?: "passkey error", fallback = false)
        } catch (e: CreatePublicKeyCredentialDomException) {
            fail(id, domName(e.domError.type), e.errorMessage?.toString() ?: "passkey error", fallback = false)
        } catch (e: NoCredentialException) {
            // No passkey for this site in any provider or account on this phone: the WebView's own flow can still offer another device.
            if (debug) Log.i(TAG, "passkey: Credential Manager found none; WebView fallback")
            fail(id, "NotAllowedError", "No passkey for this wallet on this phone", fallback = true)
        } catch (e: Exception) {
            Log.w(TAG, "passkey via Credential Manager failed (${e.javaClass.simpleName}: ${e.message}); WebView fallback")
            fail(id, "NotAllowedError", e.message ?: "passkey request failed", fallback = true)
        }
    }

    private fun fail(id: String, name: String, message: String, fallback: Boolean) = buildJsonObject {
        put("id", id); put("ok", false); put("name", name); put("message", message); put("fallback", fallback)
    }.toString()

    /** androidx.credentials DOM error types look like "androidx.credentials.TYPE_NOT_ALLOWED_ERROR"; the page wants "NotAllowedError". */
    private fun domName(type: String): String = when {
        type.contains("INVALID_STATE") -> "InvalidStateError"
        type.contains("NOT_SUPPORTED") -> "NotSupportedError"
        type.contains("SECURITY") -> "SecurityError"
        type.contains("ABORT") -> "AbortError"
        else -> "NotAllowedError"
    }

    private class Refused(val name: String, message: String) : Exception(message)
    private class Fallback(message: String) : Exception(message)

    companion object {
        const val TAG = "PRAWL_WV"

        /**
         * Routes `navigator.credentials.create/get({publicKey})` to the app. Binary fields go over as base64url (the WebAuthn JSON form) and
         * come back as ArrayBuffers on an object shaped like a PublicKeyCredential. A request the app cannot serve runs the original call.
         */
        const val JS = """
(function () {
  if (typeof prowlPasskey === 'undefined' || !navigator.credentials) return;
  var c = navigator.credentials, origCreate = c.create.bind(c), origGet = c.get.bind(c), pending = {}, seq = 0;
  prowlPasskey.onmessage = function (ev) {
    var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    var p = pending[m.id]; if (!p) return; delete pending[m.id]; p(m);
  };
  function b64(v) {
    var u = v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength), s = '';
    for (var i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function buf(s) {
    if (s == null) return null;
    var bin = atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4)), u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u.buffer;
  }
  function enc(v) {
    if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return b64(v);
    if (Array.isArray(v)) return v.map(enc);
    if (v && typeof v === 'object') { var o = {}; for (var k in v) if (v[k] !== undefined && k !== 'signal') o[k] = enc(v[k]); return o; }
    return v;
  }
  function cred(j, create) {
    var r = j.response || {}, x = j.clientExtensionResults || {}, ext = {};
    if (x.prf) {
      ext.prf = {};
      if (x.prf.enabled !== undefined) ext.prf.enabled = x.prf.enabled;
      if (x.prf.results) { ext.prf.results = {}; if (x.prf.results.first) ext.prf.results.first = buf(x.prf.results.first); if (x.prf.results.second) ext.prf.results.second = buf(x.prf.results.second); }
    }
    var resp = { clientDataJSON: buf(r.clientDataJSON) };
    if (create) {
      resp.attestationObject = buf(r.attestationObject);
      resp.getTransports = function () { return r.transports || []; };
      resp.getAuthenticatorData = function () { return buf(r.authenticatorData); };
      resp.getPublicKey = function () { return buf(r.publicKey); };
      resp.getPublicKeyAlgorithm = function () { return r.publicKeyAlgorithm; };
    } else {
      resp.authenticatorData = buf(r.authenticatorData); resp.signature = buf(r.signature); resp.userHandle = buf(r.userHandle);
    }
    return { id: j.id, rawId: buf(j.rawId || j.id), type: 'public-key', authenticatorAttachment: j.authenticatorAttachment || null, response: resp,
             getClientExtensionResults: function () { return ext; }, toJSON: function () { return j; } };
  }
  function err(name, msg) { try { return new DOMException(msg, name); } catch (e) { var x = new Error(msg); x.name = name; return x; } }
  function route(op, orig) {
    return function (opts) {
      if (!opts || !opts.publicKey) return orig(opts);
      return new Promise(function (res) {
        var id = String(++seq); pending[id] = res;
        try { prowlPasskey.postMessage(JSON.stringify({ id: id, op: op, options: enc(opts.publicKey) })); }
        catch (e) { delete pending[id]; res({ ok: false, fallback: true }); }
      }).then(function (m) {
        if (m.ok) return cred(JSON.parse(m.json), op === 'create');
        if (m.fallback) return orig(opts);
        throw err(m.name || 'NotAllowedError', m.message || 'passkey request failed');
      });
    };
  }
  c.create = route('create', origCreate);
  c.get = route('get', origGet);
})();
"""
    }
}
