package xyz.prawl.offline.ui

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.util.Log
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import xyz.prawl.core.bridge.BridgeDispatcher
import xyz.prawl.core.bridge.BridgeException
import xyz.prawl.core.bridge.NavDecision
import xyz.prawl.core.bridge.NavigationPolicy
import xyz.prawl.core.bridge.Origin
import xyz.prawl.core.bridge.SiteConfig
import xyz.prawl.core.util.Js
import xyz.prawl.core.util.obj
import xyz.prawl.core.util.str
import xyz.prawl.offline.ui.components.PCard
import xyz.prawl.offline.ui.components.Secondary
import xyz.prawl.offline.ui.components.PrimaryButton
import java.util.concurrent.Executors

/**
 * The Wallet tab: the real wallet website in a WebView (nothing redrawn). Only the allowed origin stays inside; any other page opens in the
 * system browser; `prawl://offline/...` links go to the native screens.
 *
 * `window.prawlOffline` (the bridge) exists ONLY when the browser engine can inject it for exactly the allowed origin (document-start script
 * plus an origin-scoped message listener). Without those features the page simply finds no bridge and keeps its QR/paste path.
 */
class WalletWebView(
    private val activity: Activity,
    private val dispatcher: BridgeDispatcher,
    val site: SiteConfig.Resolved,
    private val debug: Boolean,
    private val onNative: (String?) -> Unit,
) {
    var bridgeActive = false; private set
    var bridgeNote = ""; private set
    private val exec = Executors.newSingleThreadExecutor()

    @SuppressLint("SetJavaScriptEnabled")
    val view: WebView = WebView(activity).also { wv ->
        WebView.setWebContentsDebuggingEnabled(debug)
        wv.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
            mediaPlaybackRequiresUserGesture = true
            safeBrowsingEnabled = true
        }
        // Passkeys (WebAuthn) inside the WebView, where this WebView version supports it.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_AUTHENTICATION)) {
            @Suppress("OPT_IN_USAGE")
            WebSettingsCompat.setWebAuthenticationSupport(wv.settings, WebSettingsCompat.WEB_AUTHENTICATION_SUPPORT_FOR_APP)
        } else Log.i(TAG, "WebView has no WebAuthn support feature")

        wv.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(v: WebView, r: WebResourceRequest): Boolean =
                when (val d = NavigationPolicy.decide(r.url.toString(), site.origin, r.isForMainFrame)) {
                    NavDecision.Stay -> false
                    NavDecision.External -> { runCatching { activity.startActivity(Intent(Intent.ACTION_VIEW, r.url)) }; true }
                    is NavDecision.Native -> { onNative(d.screen); true }
                    NavDecision.Block -> true
                }

            override fun onPageFinished(v: WebView, url: String?) {
                if (debug) v.evaluateJavascript(DIAG_JS, null)
            }

            override fun onRenderProcessGone(v: WebView, detail: RenderProcessGoneDetail): Boolean {
                Log.w(TAG, "render process gone (crashed=${detail.didCrash()}); reloading")
                v.post { v.loadUrl(site.startUrl) }; return true
            }
        }
        wv.webChromeClient = object : WebChromeClient() {
            // The page never gets camera, microphone, location or file access from the app (scanning is done by the native tab).
            override fun onPermissionRequest(request: PermissionRequest) { request.deny() }
            override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                if (debug && (m.message().startsWith("PRAWL_DIAG") || m.messageLevel() == ConsoleMessage.MessageLevel.ERROR))
                    Log.i(TAG, m.message().take(1500) + "  [" + m.sourceId().substringAfterLast('/') + ":" + m.lineNumber() + "]")
                return true
            }
        }
        installBridge(wv)
        wv.loadUrl(site.startUrl)
    }

    private fun installBridge(wv: WebView) {
        val needed = listOf(WebViewFeature.WEB_MESSAGE_LISTENER, WebViewFeature.DOCUMENT_START_SCRIPT)
        val missing = needed.filterNot { WebViewFeature.isFeatureSupported(it) }
        if (missing.isNotEmpty()) { bridgeNote = "bridge off: WebView lacks $missing"; Log.w(TAG, bridgeNote); return }
        val origins = setOf(site.origin.toString())
        try {
            WebViewCompat.addWebMessageListener(wv, "prawlNative", origins, object : WebViewCompat.WebMessageListener {
                override fun onPostMessage(view: WebView, message: WebMessageCompat, sourceOrigin: Uri, isMainFrame: Boolean, replyProxy: JavaScriptReplyProxy) {
                    // Only the allowed origin, only its top frame; anything else is dropped without an answer.
                    if (!isMainFrame || Origin.parseStrict(sourceOrigin.toString()) != site.origin) return
                    val data = message.data ?: return
                    if (data.length > BridgeDispatcher.MAX_ARGS_CHARS + 512) return
                    exec.execute { replyProxy.postMessage(answer(data)) }
                }
            })
            WebViewCompat.addDocumentStartJavaScript(wv, BRIDGE_JS, origins)
            bridgeActive = true; bridgeNote = "bridge on for ${site.origin}"
        } catch (e: Exception) { bridgeNote = "bridge off: ${e.message}"; Log.w(TAG, bridgeNote) }
    }

    /** One request envelope `{id, method, args}` in, one reply `{id, ok, result|error}` out. Never throws, never leaks internals. */
    private fun answer(text: String): String {
        var id: Long = -1
        return try {
            val env = Js.parse(text)
            id = env.str("id").toLong()
            // A result may be an object or an array (coins() is a bare array), so not Js.parse (objects only).
            val result: JsonElement = Json.parseToJsonElement(dispatcher.dispatch(env.str("method"), env.obj("args").toString()))
            buildJsonObject { put("id", id); put("ok", true); put("result", result) }.toString()
        } catch (e: BridgeException) {
            buildJsonObject { put("id", id); put("ok", false); put("error", buildJsonObject { put("code", e.code); put("message", e.message ?: e.code) }) }.toString()
        } catch (e: Exception) {
            Log.w(TAG, "bridge call failed: ${e.javaClass.simpleName}")
            buildJsonObject { put("id", id); put("ok", false); put("error", buildJsonObject { put("code", "internal"); put("message", "the phone could not complete the request") }) }.toString()
        }
    }

    fun destroy() { exec.shutdownNow(); view.destroy() }

    companion object {
        const val TAG = "PRAWL_WV"

        /** `window.prawlOffline`: eight promise-returning methods over the origin-scoped message channel. Frozen, not enumerable. */
        const val BRIDGE_JS = """
(function () {
  if (window.prawlOffline || typeof prawlNative === 'undefined') return;
  var pending = {}, seq = 0;
  prawlNative.onmessage = function (ev) {
    var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    var p = pending[m.id]; if (!p) return; delete pending[m.id];
    if (m.ok) p.resolve(m.result);
    else { var err = new Error((m.error && m.error.message) || 'failed'); err.code = m.error && m.error.code; p.reject(err); }
  };
  function call(method, args) {
    return new Promise(function (resolve, reject) {
      var id = ++seq; pending[id] = { resolve: resolve, reject: reject };
      try { prawlNative.postMessage(JSON.stringify({ id: String(id), method: method, args: args || {} })); }
      catch (e) { delete pending[id]; reject(new Error('bridge unavailable')); }
    });
  }
  var api = {};
  ['mint', 'coins', 'cashOut', 'refresh', 'shieldAsk', 'acceptShieldTarget', 'markDeposited', 'markRefreshed'].forEach(function (n) {
    api[n] = function (a) { return call(n, a); };
  });
  Object.freeze(api);
  Object.defineProperty(window, 'prawlOffline', { value: api, enumerable: false, writable: false, configurable: false });
})();
"""

        /** Debug builds: what this WebView can do, logged as `PRAWL_DIAG {...}` (adb logcat -s PRAWL_WV). */
        const val DIAG_JS = """
(function () {
  var r = { origin: location.origin, secureContext: window.isSecureContext, wasm: typeof WebAssembly, worker: typeof Worker,
            serviceWorker: 'serviceWorker' in navigator, indexedDB: typeof indexedDB, credentials: !!navigator.credentials,
            publicKeyCredential: typeof PublicKeyCredential, bridge: !!window.prawlOffline, ua: navigator.userAgent };
  try { var w = new Worker(URL.createObjectURL(new Blob(['self.onmessage=function(){}'])), { type: 'module' }); r.moduleWorker = 'ok'; w.terminate(); }
  catch (e) { r.moduleWorker = 'ERR ' + e.message; }
  var caps = (window.PublicKeyCredential && PublicKeyCredential.getClientCapabilities) ? PublicKeyCredential.getClientCapabilities() : Promise.resolve('getClientCapabilities n/a');
  Promise.resolve(caps).then(function (c) { r.capabilities = c; }, function (e) { r.capabilities = 'ERR ' + e; })
    .then(function () { console.log('PRAWL_DIAG ' + JSON.stringify(r)); });
})();
"""
    }
}

/** The tab itself. The WebView stays alive while the other tab is shown (wallet state is not lost). */
@Composable
fun WalletTab(web: WalletWebView?, problem: String?, visible: Boolean, onOpenOffline: () -> Unit, activity: Activity) {
    if (web == null) {
        Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp), horizontalAlignment = Alignment.Start) {
            PCard(title = "Wallet website not configured") {
                Secondary(problem ?: "The wallet website address is not set.")
                Secondary("Offline cash works without it. Load and cash out then use links you open in the browser.")
                PrimaryButton("Open Offline cash", onOpenOffline)
            }
        }
        return
    }
    BackHandler(enabled = visible) { if (web.view.canGoBack()) web.view.goBack() else activity.moveTaskToBack(true) }
    AndroidView(
        factory = { web.view },
        modifier = Modifier.fillMaxSize(),
        update = { it.visibility = if (visible) View.VISIBLE else View.GONE },
    )
}
