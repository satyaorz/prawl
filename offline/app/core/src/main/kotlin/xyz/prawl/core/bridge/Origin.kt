package xyz.prawl.core.bridge

import java.net.URI

/**
 * A web origin: scheme, host and port, compared exactly. The wallet website's origin is the only one the bridge serves and the only one
 * the WebView stays on.
 */
data class Origin(val scheme: String, val host: String, val port: Int) {
    /** `https://host` (default port omitted) or `https://host:port`: the form WebView match rules and `Origin` headers use. */
    override fun toString(): String = "$scheme://$host" + if (port == defaultPort(scheme)) "" else ":$port"

    companion object {
        fun defaultPort(scheme: String) = if (scheme == "https") 443 else 80

        private val ORIGIN = Regex("^(https?)://([a-z0-9]([a-z0-9.-]*[a-z0-9])?|\\[[0-9a-f:]+\\])(:([0-9]{1,5}))?$")

        /**
         * Parses a STRICT origin string, exactly as Chromium reports `sourceOrigin`: `scheme://host[:port]`, nothing else (no path, query,
         * fragment, user info or whitespace). Returns null for anything else, including uppercase hosts, backslashes and look-alikes.
         */
        fun parseStrict(s: String?): Origin? {
            if (s == null || s.length > 300) return null
            val m = ORIGIN.matchEntire(s) ?: return null
            val scheme = m.groupValues[1]; val host = m.groupValues[2]
            val port = m.groupValues[5].ifEmpty { null }?.toIntOrNull() ?: defaultPort(scheme)
            if (port !in 1..65535) return null
            return Origin(scheme, host, port)
        }

        /**
         * The origin of an arbitrary URL, or null if it is not a plain http(s) URL we can interpret with certainty. Anything java.net.URI
         * rejects (spaces, backslashes, stray characters) is null: a URL a browser might read differently is never treated as ours.
         */
        fun ofUrl(url: String): Origin? {
            val u = try { URI(url) } catch (e: Exception) { return null }
            val scheme = u.scheme?.lowercase() ?: return null
            if (scheme != "http" && scheme != "https") return null
            if (u.rawUserInfo != null) return null
            val host = (u.host ?: return null).lowercase()
            val port = if (u.port == -1) defaultPort(scheme) else u.port
            if (port !in 1..65535 || host.isEmpty()) return null
            return Origin(scheme, host, port)
        }
    }
}

/** The website the Wallet tab shows, as configured at build time (`prawl.site`) and, in debug builds only, overridden. */
object SiteConfig {
    class Resolved(val startUrl: String, val origin: Origin)
    class Result(val resolved: Resolved?, val problem: String?)

    /** Hosts a DEBUG build may reach over plain http (adb reverse / emulator host loopback). */
    private val LOCAL_HOSTS = setOf("localhost", "127.0.0.1", "10.0.2.2", "[::1]")

    /**
     * [buildSite] is `BuildConfig.HANDOFF_SITE`. [debugOverride] (an intent extra or the settings field) is honoured only when [debug].
     * The result must be `https://host[:port]/…`; http is accepted only for [LOCAL_HOSTS] and only in debug. The placeholder `https://<site>`
     * and any URL with user info are refused.
     */
    fun resolve(buildSite: String, debug: Boolean, debugOverride: String?): Result {
        val candidate = (if (debug && !debugOverride.isNullOrBlank()) debugOverride else buildSite).trim()
        if (candidate.isEmpty() || candidate.contains('<') || candidate.contains('>')) return Result(null, "The wallet website address is not configured (build property prawl.site).")
        val u = try { URI(candidate) } catch (e: Exception) { return Result(null, "Not a valid URL: $candidate") }
        val scheme = u.scheme?.lowercase()
        val host = u.host?.lowercase()
        if (scheme == null || host == null) return Result(null, "Not a valid URL: $candidate")
        if (u.rawUserInfo != null) return Result(null, "A URL with a user name or password is not accepted.")
        val local = host in LOCAL_HOSTS
        when {
            scheme == "https" -> {}
            scheme == "http" && debug && local -> {}
            scheme == "http" -> return Result(null, "Plain http is only allowed for localhost in debug builds.")
            else -> return Result(null, "Only https is allowed.")
        }
        val origin = Origin.ofUrl(candidate) ?: return Result(null, "Not a valid URL: $candidate")
        return Result(Resolved(candidate, origin), null)
    }
}

/** What the WebView does with a navigation. */
sealed interface NavDecision {
    /** Load it in the WebView (it is on the allowed origin). */
    data object Stay : NavDecision
    /** Hand it to the system browser. */
    data object External : NavDecision
    /** A `prawl://offline/<screen>` link: show a native screen (navigate only, never pre-filled). [screen] is the first path segment. */
    data class Native(val screen: String?) : NavDecision
    /** Do nothing (a scheme the wallet never needs, or a foreign frame). */
    data object Block : NavDecision
}

object NavigationPolicy {
    /**
     * - the allowed origin (exact scheme, host and port) stays in the WebView;
     * - any other http(s) page opens in the system browser (never inside the wallet), but a foreign IFRAME is blocked outright;
     * - `prawl://offline/…` goes to the native screens;
     * - everything else (`javascript:`, `file:`, `content:`, `intent:`, `data:`, `blob:`, custom schemes) is blocked.
     */
    fun decide(url: String, allowed: Origin, isMainFrame: Boolean): NavDecision {
        val lower = url.trim().lowercase()
        if (lower == "about:blank") return NavDecision.Stay
        if (lower.startsWith("prawl://")) {
            if (!isMainFrame) return NavDecision.Block
            val u = try { URI(url.trim()) } catch (e: Exception) { return NavDecision.Block }
            if (u.host?.lowercase() != "offline") return NavDecision.Block
            return NavDecision.Native(u.path?.trim('/')?.substringBefore('/')?.ifEmpty { null })
        }
        val o = Origin.ofUrl(url.trim()) ?: return NavDecision.Block
        return when {
            o == allowed -> NavDecision.Stay
            isMainFrame -> NavDecision.External
            else -> NavDecision.Block
        }
    }
}
