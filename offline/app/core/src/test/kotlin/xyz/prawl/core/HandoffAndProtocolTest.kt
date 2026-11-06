package xyz.prawl.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import xyz.prawl.core.attest.TrustAnchors
import xyz.prawl.core.certs.CertResolver
import xyz.prawl.core.deposit.DepositCommitment
import xyz.prawl.core.handoff.Handoff
import xyz.prawl.core.model.Bundle
import xyz.prawl.core.model.Output
import xyz.prawl.core.protocol.Protocol
import xyz.prawl.core.util.Bytes
import xyz.prawl.core.util.Js
import xyz.prawl.core.util.Keccak256
import xyz.prawl.core.util.obj
import xyz.prawl.core.util.str
import xyz.prawl.core.util.with
import java.io.File
import java.math.BigInteger
import java.security.Signature

class HandoffAndProtocolTest {

    private fun vec(name: String) = Vectors.json(Vectors.handoff, name)

    /** Kotlin `load` encoder vs raw/v3/handoff.py output (byte-identical JSON and d). */
    @Test fun loadMatchesPythonVector() {
        val v = vec("load_ho_deposited.json")
        val p = Handoff.load(Vectors.json(Vectors.ho, "mint3_ho.json"))
        val pyJson = String(Bytes.unb64url(v.str("d")), Charsets.UTF_8)
        assertEquals(pyJson, p.toString())
        assertEquals(v.str("d"), Handoff.encode(p))
        assertEquals(v.str("prawl"), Handoff.prawlLink("load", Handoff.encode(p)))
        assertEquals(v.str("https"), Handoff.httpsLink("https://<site>", "load", Handoff.encode(p)))
    }

    /** The redeem payload from the real phone bundle must be byte-identical to the agreed vector. */
    @Test fun redeemMatchesPythonVector() {
        val v = vec("redeem_ho_0.003_unsubmitted.json")
        val bundle = Vectors.json(Vectors.ho, "redeem3_ho_n_ho_c1793948361543.json")
        val p = Handoff.redeem(bundle, null)
        assertEquals(String(Bytes.unb64url(v.str("d")), Charsets.UTF_8), p.toString())
        assertEquals(v.obj("payload"), p)
        assertEquals(v.str("d"), Handoff.encode(p))
        assertEquals(v.str("https"), Handoff.httpsLink("https://<site>", "redeem", Handoff.encode(p)))
    }

    /** redeem_already_paid.json was made from one of the Sepolia e2e redemptions. */
    @Test fun redeemAlreadyPaidMatchesOneE2eBundle() {
        val v = vec("redeem_already_paid.json")
        val hits = Vectors.e2e.listFiles()!!.filter { it.name.startsWith("redeem3_") }
            .map { Handoff.encode(Handoff.redeem(Vectors.json(it), null)) }
        assertTrue(hits.contains(v.str("d")))
    }

    @Test fun linkParsingRoundTripAndVersionCheck() {
        val v = vec("load_ho_deposited.json")
        val p = Handoff.parseLink(v.str("https"))
        assertEquals("load", p.kind)
        assertEquals(v.obj("payload"), p.payload)
        assertEquals(p.payload, Handoff.parseLink(v.str("prawl")).payload)
        val bad = Handoff.encode(p.payload.with("v", 2))
        assertThrows { Handoff.parseLink("prawl://offline/load?d=$bad") }
        assertThrows { Handoff.parseLink("prawl://offline/redeem?d=" + v.str("d")) } // type mismatch
    }

    /** Phone-signed redemptions verify under our message format (proves spend message, note ids, redeem key). */
    @Test fun phoneRedemptionSignaturesVerify() {
        for (dir in listOf(Vectors.split, Vectors.e2e, Vectors.ho)) {
            val res = CertResolver(Vectors.certStore(dir), Vectors.anchors)
            for (f in dir.listFiles()!!.filter { it.name.startsWith("redeem3_") }) {
                val b = Bundle(Vectors.json(f))
                val h = b.header
                var noteId = Protocol.genesisNoteId(h.coinId)
                var key = res.leafKey(h.k0, b.certs)
                for ((d, s) in b.path.withIndex()) {
                    assertTrue("${f.name} spend $d", verify(key, Protocol.spendMessage(h, d, noteId, s.outputs), s.sig))
                    noteId = Protocol.childNoteId(s.sig, s.index)
                    key = res.leafKey(s.next, b.certs)
                }
                val rd = b.redeem!!
                val outs = Output.list(rd["outputs"] as kotlinx.serialization.json.JsonArray)
                assertEquals(Protocol.redeemKey(h.chainId, h.escrow, rd.str("payout")), outs[0].key)
                assertTrue(f.name, verify(key, Protocol.spendMessage(h, b.path.size, noteId, outs), rd.str("sig")))
            }
        }
    }

    private fun verify(k: java.security.PublicKey, msg: ByteArray, sigB64: String): Boolean {
        val s = Signature.getInstance("SHA256withECDSA"); s.initVerify(k); s.update(msg); return s.verify(Bytes.unb64(sigB64))
    }

    @Test fun keccakVectors() {
        val arr = Js.parseArray(File(Vectors.raw, "v3/deposit_proofs/data/vectors/keccak_vectors.json").readText())
        var n = 0
        for (e in arr) {
            val o = e as JsonObject
            assertEquals(o.str("out"), Keccak256.hex(Bytes.unhex(o.str("in")))); n++
        }
        assertTrue(n > 300)
    }

    /** The commitment the escrow stored for the real Sepolia e2e deposit. */
    @Test fun depositCommitmentMatchesSepolia() {
        val m = Vectors.json(Vectors.e2e, "mint3_e2e.json")
        val h = xyz.prawl.core.model.CoinHeader(m)
        assertEquals("e5c62e05d8a0dfabee03c0621bd589d78d314dbab769e6e0fc30350507c757aa", Bytes.hex(DepositCommitment.commitment(h)))
        // header k0x/k0y is the attested genesis key
        val res = CertResolver(Vectors.certStore(Vectors.e2e), Vectors.anchors)
        assertTrue(DepositCommitment.headerKeyMatches(h, res.leafKey(h.k0, m.obj("certs"))))
    }

    /** escrow_v3/logs/sepolia_dryrun.txt: storage key of deposits[0x8dfb…6692]. */
    @Test fun storageKeyMatchesSepoliaDryrun() {
        assertEquals("3a16d39b763a466814c8bffad997f09594604d850d1c9a8607a565fd8b921355",
            Bytes.hex(DepositCommitment.storageKey("8dfb327667f9771c86996055eaa3ff9efe95cd0b903db0486d77561cbadb6692")))
    }

    @Test fun eip55AndEip681() {
        val a = "5aaeb6053f3e94c9b9a09f33669435e7ef1beaed"
        assertEquals("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", xyz.prawl.core.util.Eth.checksum(a))
        assertTrue(xyz.prawl.core.util.Eth.validateAddress("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed").ok)
        assertTrue(!xyz.prawl.core.util.Eth.validateAddress("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD").ok)
        val e = xyz.prawl.core.util.Eth.parseEip681("ethereum:" + xyz.prawl.core.util.Eth.checksum("03a62b04abe69f382bd7582f492be735b1ddb47b") + "@11155111")
        assertNotNull(e)
        assertEquals("03a62b04abe69f382bd7582f492be735b1ddb47b", e!!.addr40)
        assertEquals(11155111L, e.chainId)
        assertEquals(null, xyz.prawl.core.util.Eth.parseEip681("ethereum:0x1234@1"))
        assertEquals(null, xyz.prawl.core.util.Eth.parseEip681("ethereum:0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD@1"))
        assertEquals("5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", xyz.prawl.core.util.Eth.parseEip681("ethereum:pay-0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed@11155111/transfer?x=1")!!.addr40)
    }

    @Test fun weiFormatting() {
        assertEquals(BigInteger("1000000000000000"), xyz.prawl.core.util.Eth.wei("0.001"))
        assertEquals("0.001", xyz.prawl.core.util.Eth.eth(BigInteger("1000000000000000")))
        assertThrows { xyz.prawl.core.util.Eth.wei("0.0000000000000000001") }
    }

    @Test fun certIdsAreHarnessIds() {
        // every k0 id in a mint file is the 128-bit SHA-256 prefix of the certificate it names
        val m = Vectors.json(Vectors.split, "mint3_s.json")
        for ((id, v) in m.obj("certs")) assertEquals(id, xyz.prawl.core.certs.CertStore.certId(Bytes.unb64((v as JsonPrimitive).content)))
        assertTrue(TrustAnchors.parsePem(File(Vectors.assets, "roots.pem").readText()).size == 2)
    }
}
