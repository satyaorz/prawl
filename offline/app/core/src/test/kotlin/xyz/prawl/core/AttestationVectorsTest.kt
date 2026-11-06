package xyz.prawl.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import xyz.prawl.core.attest.AppIdentity
import xyz.prawl.core.attest.AttestationPolicy
import xyz.prawl.core.attest.AttestationVerifier
import xyz.prawl.core.attest.TrustAnchors
import xyz.prawl.core.certs.CertResolver
import xyz.prawl.core.model.ReceiveRequest
import xyz.prawl.core.util.arr
import xyz.prawl.core.util.strings

/** The attestation policy on the REAL chains made by the Samsung (StrongBox) and OnePlus (TEE, RKP). */
class AttestationVectorsTest {
    private val store = Vectors.certStore(Vectors.split)
    private val res = CertResolver(store, Vectors.anchors)
    private val samsungK0 = Vectors.json(Vectors.split, "mint3_s.json").arr("k0").strings()
    private val oneplusRecv = ReceiveRequest(Vectors.json(Vectors.split, "req_bob1.json")).chain

    @Test fun samsungStrongBoxGenesisKeyPasses() {
        val r = Vectors.verifier().verify(res.chain(samsungK0))
        assertTrue(r.summary(), r.ok)
        assertEquals("StrongBox", r.level)
        assertFalse("factory chain", r.rkp)
        assertTrue(r.usageLimitInHardware)
        assertTrue(r.patch >= 202601)
        assertTrue(r.pkgs.contains("xyz.prawl.otktest"))
    }

    @Test fun oneplusTeeRkpKeyPasses() {
        val r = Vectors.verifier().verify(res.chain(oneplusRecv))
        assertTrue(r.summary(), r.ok)
        assertEquals("TEE", r.level)
        assertTrue("RKP chain", r.rkp)
        assertEquals(5, r.chainLength)
    }

    @Test fun wrongAppIsRejected() {
        val p = AttestationPolicy(listOf(AppIdentity("xyz.evil.otk", AttestationPolicy.DEBUG_CERT_SHA256)))
        val r = Vectors.verifier(p).verify(res.chain(samsungK0))
        assertFalse(r.ok)
        assertTrue(r.fails.toString(), r.fails.any { it.startsWith("key created by app") })
    }

    @Test fun wrongSigningCertIsRejected() {
        val p = AttestationPolicy(listOf(AppIdentity(AttestationPolicy.HARNESS_PACKAGE, "00".repeat(32))))
        val r = Vectors.verifier(p).verify(res.chain(samsungK0))
        assertFalse(r.ok)
        assertTrue(r.fails.contains("app signing cert matches"))
    }

    @Test fun pairedAllowlistAcceptsEitherApp() {
        val p = AttestationPolicy(listOf(
            AppIdentity(AttestationPolicy.APP_PACKAGE, AttestationPolicy.DEBUG_CERT_SHA256),
            AppIdentity(AttestationPolicy.HARNESS_PACKAGE, AttestationPolicy.DEBUG_CERT_SHA256)))
        assertTrue(Vectors.verifier(p).verify(res.chain(samsungK0)).ok)
    }

    @Test fun expiredRkpIntermediateIsRejected() {
        // 2026-12-01: after the OnePlus RKP certificates' 14-day validity
        val r = Vectors.verifier(nowS = 1796083200L).verify(res.chain(oneplusRecv))
        assertFalse(r.ok)
        assertTrue(r.fails.toString(), r.fails.any { it.startsWith("RKP cert") })
    }

    @Test fun revokedSerialIsRejected() {
        val chain = res.chain(oneplusRecv)
        val serial = TrustAnchors.parseCert(chain[1]).serialNumber.toString(16)
        val anchors = TrustAnchors(Vectors.anchors.rootsDer, Vectors.anchors.revokedSerials + serial, Vectors.anchors.revocationFetchedAt)
        val r = AttestationVerifier(anchors, Vectors.harnessPolicy) { Vectors.NOW_S * 1000 }.verify(chain)
        assertFalse(r.ok)
        assertTrue(r.fails.toString(), r.fails.any { it.contains(serial) })
    }

    @Test fun unpinnedRootIsRejected() {
        val anchors = TrustAnchors(emptyList(), emptySet(), Vectors.anchors.revocationFetchedAt)
        val r = AttestationVerifier(anchors, Vectors.harnessPolicy) { Vectors.NOW_S * 1000 }.verify(res.chain(samsungK0))
        assertFalse(r.ok)
        assertTrue(r.fails.contains("root is a pinned Google attestation root"))
    }

    @Test fun truncatedChainIsRejected() {
        val r = Vectors.verifier().verify(res.chain(samsungK0).dropLast(1))
        assertFalse(r.ok)
    }

    @Test fun swappedIntermediateIsRejected() {
        val c = res.chain(samsungK0).toMutableList()
        c[1] = res.chain(oneplusRecv)[1]
        assertFalse(Vectors.verifier().verify(c).ok)
    }

    @Test fun policyCannotBeWeakened() {
        assertThrows { AttestationPolicy(listOf(AppIdentity("a", "b")), minPatch = 202512) }
        assertThrows { AttestationPolicy(emptyList()) }
    }
}

fun assertThrows(block: () -> Unit) {
    try { block() } catch (e: Exception) { return }
    throw AssertionError("expected an exception")
}
