package xyz.prawl.offline

import android.content.Intent
import android.net.Uri
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import xyz.prawl.core.attest.AttestationPolicy
import xyz.prawl.offline.ui.Fmt
import java.math.BigInteger

/** App audit fixes that live in the app module: F-03 (routing), F-10 (display), F-11 (release allow-list). */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [34])
class AuditAppTest {
    private val attacker = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa"
    private fun link(u: String) = OfflineCashActivity.routeFor(Intent(Intent.ACTION_VIEW, Uri.parse(u)))

    /**
     * F-03 [was PROVED]: the activity is exported and BROWSABLE, and a link or any app's intent pre-filled the payout address and the
     * shield target. Now every link and intent only NAVIGATES, to an EMPTY form.
     */
    @Test fun f03_linksAndIntentsNavigateToEmptyFormsOnly() {
        assertEquals(Route.CashOut(), link("prawl://offline/cashout?payout=$attacker"))
        assertEquals(Route.CashOut(), link("prawl://offline/redeem?payout=$attacker"))
        assertEquals(Route.CashOut(), link("prawl://offline/shield-target?d=eyJ2IjoxLCJ0Ijoic2hpZWxkLXRhcmdldCJ9"))
        assertEquals(Route.Load(), link("prawl://offline/load?depositor=$attacker"))
        assertEquals(Route.Load(), link("prawl://offline/deposited?coinId=0x00&tx=0x01"))
        assertEquals(Route.Pay(), link("prawl://offline/pay?d=eyJ2IjoxLCJ0IjoicGF5In0"))
        assertEquals(Route.Refresh(), link("prawl://offline/refreshed?coinId=0x00"))
        assertEquals(Route.Receive, link("prawl://offline/receive"))
        assertEquals(Route.Balance, link("prawl://offline/whatever"))
        val i = Intent(OfflineCashActivity.ACTION_OPEN).putExtra("screen", "cashout").putExtra("payout", attacker).putExtra("depositor", attacker).putExtra("shield", "{}")
        assertEquals(Route.CashOut(), OfflineCashActivity.routeFor(i))
        assertEquals(Route.Load(), OfflineCashActivity.routeFor(Intent(OfflineCashActivity.ACTION_OPEN).putExtra("screen", "load").putExtra("depositor", attacker)))
        // other schemes and hosts are not ours
        assertNull(link("https://evil.example/offline/cashout?payout=$attacker"))
        assertNull(link("prawl://elsewhere/cashout"))
        // and a route built from a link carries no value at all
        val r = link("prawl://offline/cashout?payout=$attacker") as Route.CashOut
        assertNull(r.payout); assertNull(r.shield)
    }

    /** F-10 [was PROVED]: 1 wei displayed as "0" on the green screen. */
    @Test fun f10_tinyAmountsAreNeverShownAsZero() {
        assertEquals("<0.000001", Fmt.eth(BigInteger.ONE))
        assertEquals("<0.000001", Fmt.eth(BigInteger.TEN.pow(12) - BigInteger.ONE))
        assertEquals("0.000001", Fmt.eth(BigInteger.TEN.pow(12)))
        assertEquals("0", Fmt.eth(BigInteger.ZERO))
        assertEquals("0.5", Fmt.eth(BigInteger("500000000000000000")))
    }

    /**
     * F-11 [was PROVED]: ALLOWED_APPS held the repo's public debug certificate in every build type. Debug keeps it (app + harness);
     * a release build must not contain it, and carries a 64-hex production digest (a placeholder that matches nothing until set).
     */
    @Test fun f11_aReleaseBuildNeverTrustsTheDebugCertificate() {
        val entries = BuildConfig.ALLOWED_APPS.split(',').map { it.substringBefore(':') to it.substringAfter(':') }
        if (BuildConfig.DEBUG) {
            assertTrue(BuildConfig.ALLOWED_APPS.contains(AttestationPolicy.DEBUG_CERT_SHA256))
            assertTrue(entries.any { it.first == "xyz.prawl.offline" }); assertTrue(entries.any { it.first == "xyz.prawl.otktest" })
        } else {
            assertFalse("release must not trust the debug certificate", BuildConfig.ALLOWED_APPS.contains(AttestationPolicy.DEBUG_CERT_SHA256, ignoreCase = true))
            assertEquals(listOf("xyz.prawl.offline"), entries.map { it.first })
            assertTrue("a 64-hex digest", Regex("^[0-9a-f]{64}$").matches(entries.single().second))
            assertFalse("the harness package is not trusted in release", BuildConfig.ALLOWED_APPS.contains("otktest"))
        }
    }
}
