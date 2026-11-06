package xyz.prawl.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import xyz.prawl.core.certs.CertResolver
import xyz.prawl.core.certs.MemoryCertStore
import xyz.prawl.core.deposit.CommitmentSnapshotDepositVerifier
import xyz.prawl.core.deposit.CompositeDepositVerifier
import xyz.prawl.core.deposit.DepositVerifier
import xyz.prawl.core.deposit.SnapshotDepositVerifier
import xyz.prawl.core.model.Bundle
import xyz.prawl.core.model.ReceiveRequest
import xyz.prawl.core.protocol.PaymentVerifier
import xyz.prawl.core.protocol.RecipientPolicy
import xyz.prawl.core.protocol.VerificationReport
import xyz.prawl.core.util.Bytes
import xyz.prawl.core.util.Js
import xyz.prawl.core.util.arr
import xyz.prawl.core.util.obj
import xyz.prawl.core.util.objects
import xyz.prawl.core.util.with
import xyz.prawl.core.util.without
import java.io.File
import java.math.BigInteger

/**
 * Recipient-side verification of REAL phone bundles (1 and 2 hops, both phones as signer), and of tampered
 * copies, which must all fail.
 */
class PaymentVectorsTest {

    private fun verify(
        dir: File, bundle: JsonObject, reqFile: String,
        deposits: DepositVerifier = SnapshotDepositVerifier(Vectors.json(dir, "snapshot.json"), legacyUnbound = true),
        policy: RecipientPolicy = RecipientPolicy(),
        nowS: Long = Vectors.NOW_S,
        store: MemoryCertStore = Vectors.certStore(dir),
        revocationFetchedAt: Long = Vectors.anchors.revocationFetchedAt,
    ): VerificationReport {
        val req = ReceiveRequest(Vectors.json(dir, reqFile))
        val res = CertResolver(store, Vectors.anchors)
        val mine = res.leafKeyHash(req.chain, req.certs)
        val log = ArrayList<String>()
        val rep = PaymentVerifier(res, Vectors.verifier(nowS = nowS), deposits, policy, revocationFetchedAt) { log.add(it) }
            .verify(Bundle(bundle), req.name, mine, nowS)
        println(log.joinToString("\n") + "\n  -> " + (if (rep.accepted) "ACCEPTED" else "REJECTED ${rep.fails}"))
        return rep
    }

    private fun b(dir: File, f: String) = Vectors.json(dir, f)

    // ------------------------------------------------------------------ genuine bundles

    @Test fun oneHopSamsungToOneplus() {
        val r = verify(Vectors.split, b(Vectors.split, "pay3_s_bob1.json"), "req_bob1.json")
        assertTrue(r.fails.toString(), r.accepted)
        assertEquals(BigInteger("200000000000000000"), r.receivedValue)
        assertEquals(1, r.hops)
    }

    @Test fun twoHopBundleOneplusToSamsung() {
        val r = verify(Vectors.split, b(Vectors.split, "pay3_s_dave1.json"), "req_dave1.json")
        assertTrue(r.fails.toString(), r.accepted)
        assertEquals(BigInteger("100000000000000000"), r.receivedValue)
        assertEquals(2, r.hops)
        // every line of the human-readable report is green
        assertTrue(r.lines.all { it.ok })
        assertEquals(2, r.lines.count { it.title.endsWith("signature") })
    }

    @Test fun changeNoteSpend() {
        val r = verify(Vectors.split, b(Vectors.split, "pay3_s_bob2.json"), "req_bob2.json")
        assertTrue(r.fails.toString(), r.accepted)
        assertEquals(BigInteger("500000000000000000"), r.receivedValue)
    }

    @Test fun sepoliaE2eTwoHop() {
        val r = verify(Vectors.e2e, b(Vectors.e2e, "pay3_e2e_dave.json"), "req_dave.json")
        assertTrue(r.fails.toString(), r.accepted)
        assertEquals(BigInteger("1000000000000000"), r.receivedValue)
        val r1 = verify(Vectors.e2e, b(Vectors.e2e, "pay3_e2e_bob.json"), "req_bob.json")
        assertTrue(r1.fails.toString(), r1.accepted)
    }

    @Test fun handoffRunOneHop() {
        val r = verify(Vectors.ho, b(Vectors.ho, "pay3_ho_bob.json"), "req_bob.json")
        assertTrue(r.fails.toString(), r.accepted)
    }

    /** The real Sepolia coin checked against its ON-CHAIN commitment (deposits[coinId] = 0xe5c62e05…57aa). */
    @Test fun sepoliaE2eAgainstOnchainCommitment() {
        val coin = b(Vectors.e2e, "mint3_e2e.json")
        val snap = Js.parse("""{"v":1,"t":"deposits","chainId":"11155111","escrow":"0x70b3B7EdCD18087C999ec80e3C3B0227c7e0D6E5",
            "commitments":{"0x${coin["coinId"]!!.let { (it as JsonPrimitive).content }}":"0xe5c62e05d8a0dfabee03c0621bd589d78d314dbab769e6e0fc30350507c757aa"}}""")
        val dv = CommitmentSnapshotDepositVerifier(snap)
        val r = verify(Vectors.e2e, b(Vectors.e2e, "pay3_e2e_dave.json"), "req_dave.json", deposits = dv,
            policy = RecipientPolicy(acceptedEscrows = setOf("11155111" to "70b3b7edcd18087c999ec80e3c3b0227c7e0d6e5")))
        assertTrue(r.fails.toString(), r.accepted)
        // a different on-chain commitment (e.g. another depositor) must fail
        val bad = CommitmentSnapshotDepositVerifier(snap.with("commitments", Js.parse("""{"0x${(coin["coinId"] as JsonPrimitive).content}":"0x${"11".repeat(32)}"}""")))
        val r2 = verify(Vectors.e2e, b(Vectors.e2e, "pay3_e2e_dave.json"), "req_dave.json", deposits = bad)
        assertTrue(r2.fails.contains("not backed by a known deposit"))
    }

    // ------------------------------------------------------------------ tampered copies

    private val dave1 get() = b(Vectors.split, "pay3_s_dave1.json")

    private fun spend(j: JsonObject, i: Int) = j.arr("path").objects()[i]
    private fun withSpend(j: JsonObject, i: Int, s: JsonObject) = j.with("path", JsonArray(j.arr("path").objects().toMutableList().also { it[i] = s }))
    private fun withOutputValue(j: JsonObject, i: Int, o: Int, v: String): JsonObject {
        val s = spend(j, i)
        val outs = s.arr("outputs").objects().toMutableList()
        outs[o] = outs[o].with("value", v)
        return withSpend(j, i, s.with("outputs", JsonArray(outs)))
    }
    private fun withHeader(j: JsonObject, k: String, v: JsonPrimitive) = j.with("header", j.obj("header").with(k, v))
    private fun rejectedWith(rep: VerificationReport, what: String) {
        assertFalse("must be rejected", rep.accepted)
        assertTrue("expected '$what' in ${rep.fails}", rep.fails.any { it.contains(what) })
    }

    @Test fun phoneTamperVectorIsRejected() =
        rejectedWith(verify(Vectors.split, b(Vectors.split, "pay3_s_tamper.json"), "req_bob1.json"), "signature invalid")

    @Test fun inflatedOutputIsRejected() =
        rejectedWith(verify(Vectors.split, withOutputValue(withOutputValue(dave1, 1, 0, "150000000000000000"), 1, 1, "50000000000000000"), "req_dave1.json"), "spend 1 signature invalid")

    @Test fun broken_conservation() =
        rejectedWith(verify(Vectors.split, withOutputValue(dave1, 1, 1, "900000000000000000"), "req_dave1.json"), "does not conserve value")

    @Test fun followingTheChangeOutputIsRejected() {
        val s = spend(dave1, 1)
        rejectedWith(verify(Vectors.split, withSpend(dave1, 1, s.with("index", 1)), "req_dave1.json"), "output not bound to the next key")
    }

    @Test fun flippedSignatureByteIsRejected() {
        val s = spend(dave1, 0)
        val sig = Bytes.unb64((s["sig"] as JsonPrimitive).content); sig[sig.size - 3] = (sig[sig.size - 3].toInt() xor 1).toByte()
        rejectedWith(verify(Vectors.split, withSpend(dave1, 0, s.with("sig", Bytes.b64(sig))), "req_dave1.json"), "spend 0 signature invalid")
    }

    @Test fun extendedExpiryIsRejected() {
        val r = verify(Vectors.split, withHeader(dave1, "expiry", JsonPrimitive(1795152533L + 86400)), "req_dave1.json")
        rejectedWith(r, "not backed by a known deposit"); rejectedWith(r, "signature invalid")
    }

    @Test fun otherCoinIdIsRejected() =
        rejectedWith(verify(Vectors.split, withHeader(dave1, "coinId", JsonPrimitive("ab".repeat(32))), "req_dave1.json"), "not backed")

    @Test fun inflatedDepositValueIsRejected() =
        rejectedWith(verify(Vectors.split, withHeader(dave1, "value", JsonPrimitive("2000000000000000000")), "req_dave1.json"), "not backed")

    @Test fun swappedHeaderKeyIsRejected() =
        rejectedWith(verify(Vectors.split, withHeader(dave1, "k0x", JsonPrimitive("1234")), "req_dave1.json"), "header k0x/k0y are not the attested genesis key")

    @Test fun replayToAnotherPayeeIsRejected() =
        rejectedWith(verify(Vectors.split, dave1, "req_bob1.json"), "not addressed to me")

    @Test fun substitutedNextKeyIsRejected() {
        // Bob's key replaced by Dave's own receive key in spend 0
        val daveChain = ReceiveRequest(b(Vectors.split, "req_dave1.json")).json.arr("chain")
        val s = spend(dave1, 0)
        rejectedWith(verify(Vectors.split, withSpend(dave1, 0, s.with("next", daveChain)), "req_dave1.json"), "output not bound to the next key")
    }

    @Test fun missingCertificateIsRejectedNotCrashing() {
        // empty recipient cache: the bundle carries only 3 of 13 certificate refs
        val r = verify(Vectors.split, dave1, "req_dave1.json", store = MemoryCertStore().also { s ->
            ReceiveRequest(b(Vectors.split, "req_dave1.json")).certs.forEach { (_, v) -> s.put(Bytes.unb64((v as JsonPrimitive).content)) }
        })
        assertFalse(r.accepted)
    }

    @Test fun corruptedCarriedCertIsRejected() {
        val certs = dave1.obj("certs")
        val id = certs.keys.first()
        val r = verify(Vectors.split, dave1.with("certs", certs.with(id, Bytes.b64(ByteArray(100)))), "req_dave1.json", store = MemoryCertStore())
        assertFalse(r.accepted)
    }

    @Test fun unknownDepositIsRejected() =
        rejectedWith(verify(Vectors.split, dave1, "req_dave1.json", deposits = CompositeDepositVerifier(emptyList())), "not backed by a known deposit")

    @Test fun hopLimitIsEnforced() =
        rejectedWith(verify(Vectors.split, dave1, "req_dave1.json", policy = RecipientPolicy(maxHops = 1)), "too many offline hops")

    @Test fun expiredCoinIsRejected() =
        rejectedWith(verify(Vectors.split, dave1, "req_dave1.json", nowS = 1795152533L - 600), "coin expired or about to expire")

    @Test fun capIsEnforced() =
        rejectedWith(verify(Vectors.split, dave1, "req_dave1.json", policy = RecipientPolicy(capWei = BigInteger("50000000000000000"))), "above offline cap")

    @Test fun staleRevocationListLowersCap() {
        // list fetched 3 days before: cap drops to 0.05 ETH, so the 0.1 ETH note is refused
        rejectedWith(verify(Vectors.split, dave1, "req_dave1.json", revocationFetchedAt = Vectors.NOW_S - 3 * 86400), "above offline cap 0.05")
    }

    @Test fun otherEscrowIsRejectedWhenAllowlisted() =
        rejectedWith(verify(Vectors.split, dave1, "req_dave1.json",
            policy = RecipientPolicy(acceptedEscrows = setOf("11155111" to "70b3b7edcd18087c999ec80e3c3b0227c7e0d6e5"))), "escrow this wallet does not accept")

    @Test fun droppedSpendIsRejected() {
        val j = dave1.with("path", JsonArray(dave1.arr("path").drop(1)))
        assertFalse(verify(Vectors.split, j, "req_dave1.json").accepted)
    }

    @Test fun malformedBundleIsRejected() {
        assertFalse(verify(Vectors.split, dave1.without("header"), "req_dave1.json").accepted)
    }

    @Test fun policyCannotBeWeakened() {
        assertThrows { RecipientPolicy(maxHops = 4) }
        assertThrows { RecipientPolicy(capWei = BigInteger("2000000000000000000")) }
        assertThrows { RecipientPolicy(minRemainingS = 60) }
        assertThrows { RecipientPolicy(staleCapWei = BigInteger("60000000000000000")) }
    }
}
