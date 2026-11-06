package xyz.prawl.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import xyz.prawl.core.attest.AttestationProblems
import xyz.prawl.core.attest.AttestationProblems.Whose

class AttestationProblemsTest {
    @Test fun theTwoChecksSeenOnARealPhoneGiveTwoPlainReasons() {
        val r = AttestationProblems.explain(listOf("usageCountLimit==1 hardware-enforced", "app signing cert matches"))
        assertEquals(2, r.size)
        assertTrue(r[0], r[0].contains("single signature"))
        assertTrue(r[1], r[1].contains("different build of Prowl"))
    }

    @Test fun checksWithOneCauseGiveOneSentence() {
        val r = AttestationProblems.explain(listOf("key created by app xyz.prawl.offline", "app signing cert matches", "bootloader locked", "verified boot"))
        assertEquals(2, r.size)
    }

    @Test fun aPhoneTalksAboutItselfAndAnUnknownCheckIsShownAsIs() {
        val r = AttestationProblems.explain(listOf("security patch >= 202601", "something new"), Whose.THIS)
        assertTrue(r[0], r[0].startsWith("This phone's security update") && r[0].contains("2026-01"))
        assertEquals("Check failed: something new", r[1])
    }
}
