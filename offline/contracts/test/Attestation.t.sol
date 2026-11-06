// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {AndroidAttestation as AA} from "../src/attest/AndroidAttestation.sol";
import {P384Verifier} from "nitro/P384Verifier.sol";
import {IP384Verifier} from "nitro/IP384Verifier.sol";

/// @notice External wrappers so each step's gas is measurable as one call.
contract AttestHarness {
    IP384Verifier immutable v384 = new P384Verifier();

    function parse(bytes memory d) external pure returns (AA.Cert memory) {
        return AA.parse(d);
    }

    function spkiHash(bytes memory d) external view returns (bytes32) {
        return AA.spkiHash(d, AA.parse(d));
    }

    /// (a) child signed by a P-256 parent: parse both, sha256(tbs), P256VERIFY
    function linkP256(bytes memory child, bytes memory parent) external view returns (bool) {
        AA.Cert memory p = AA.parse(parent);
        (bytes32 x, bytes32 y) = AA.p256Key(parent, p);
        return AA.verifiedByP256(child, AA.parse(child), x, y);
    }

    /// (a') same, with the parent key already known (cached): only the child is parsed
    function linkP256Cached(bytes memory child, bytes32 x, bytes32 y) external view returns (bool) {
        return AA.verifiedByP256(child, AA.parse(child), x, y);
    }

    /// (b) KeyDescription extraction from the leaf
    function keyDesc(bytes memory leaf) external pure returns (AA.KeyDesc memory) {
        return AA.keyDescription(leaf, AA.parse(leaf));
    }

    /// (a)+(b): the full leaf check against a cached attestation key, with the Prowl OTK policy
    function leafCheck(bytes memory leaf, bytes32 akx, bytes32 aky, bytes32 pkgHash, bytes32 signer)
        external
        view
        returns (bool sigOk, uint256 fails, bytes32 keyHash, bytes32 x, bytes32 y)
    {
        AA.Cert memory c = AA.parse(leaf);
        sigOk = AA.verifiedByP256(leaf, c, akx, aky);
        fails = AA.otkPolicy(AA.keyDescription(leaf, c), pkgHash, signer);
        keyHash = AA.spkiHash(leaf, c);
        (x, y) = AA.p256Key(leaf, c);
    }

    /// (c) P-384 parent (SHA-256 or SHA-384 digest), hinted verification
    function linkP384(bytes memory child, bytes memory parent, bytes memory hints) external view returns (bool) {
        AA.Cert memory p = AA.parse(parent);
        return AA.verifiedByP384(v384, child, AA.parse(child), AA.p384Key(parent, p), hints);
    }

    /// (c) RSA parent, sha256WithRSAEncryption, MODEXP
    function linkRsa(bytes memory child, bytes memory parent) external view returns (bool) {
        AA.Cert memory p = AA.parse(parent);
        (bytes memory n, uint256 e) = AA.rsaKey(parent, p);
        return AA.verifiedByRsa(child, AA.parse(child), n, e);
    }

    // ---- internal gas probes: gas spent inside the call, excluding calldata decoding and call overhead
    function gParse(bytes memory d) external view returns (uint256 g) {
        g = gasleft();
        AA.parse(d);
        g -= gasleft();
    }

    function gLinkP256Cached(bytes memory child, bytes32 x, bytes32 y) external view returns (uint256 g, bool ok) {
        g = gasleft();
        ok = AA.verifiedByP256(child, AA.parse(child), x, y);
        g -= gasleft();
    }

    function gLinkP256(bytes memory child, bytes memory parent) external view returns (uint256 g, bool ok) {
        g = gasleft();
        AA.Cert memory p = AA.parse(parent);
        (bytes32 x, bytes32 y) = AA.p256Key(parent, p);
        ok = AA.verifiedByP256(child, AA.parse(child), x, y);
        g -= gasleft();
    }

    function gKeyDesc(bytes memory leaf) external view returns (uint256 g) {
        g = gasleft();
        AA.Cert memory c = AA.parse(leaf);
        uint256 g1 = gasleft();
        AA.otkPolicy(AA.keyDescription(leaf, c), bytes32(0), bytes32(0));
        g = g1 < g ? g - gasleft() : 0;
    }

    function gKeyDescOnly(bytes memory leaf) external view returns (uint256 g) {
        AA.Cert memory c = AA.parse(leaf);
        g = gasleft();
        AA.otkPolicy(AA.keyDescription(leaf, c), bytes32(0), bytes32(0));
        g -= gasleft();
    }

    function gLeafCheck(bytes memory leaf, bytes32 x, bytes32 y) external view returns (uint256 g, uint256 fails) {
        g = gasleft();
        AA.Cert memory c = AA.parse(leaf);
        require(AA.verifiedByP256(leaf, c, x, y));
        fails = AA.otkPolicy(AA.keyDescription(leaf, c), keccak256("xyz.prawl.otktest"), bytes32(0));
        AA.spkiHash(leaf, c);
        AA.p256Key(leaf, c);
        g -= gasleft();
    }

    function gLinkP384(bytes memory child, bytes memory parent, bytes memory hints) external view returns (uint256 g, uint256 gHash, bool ok) {
        g = gasleft();
        AA.Cert memory c = AA.parse(child);
        uint256 g0 = gasleft();
        if (c.sigAlg == AA.OID_ECDSA_SHA384) Sha384Probe.tbs(child, c.tbsStart, c.tbsLen);
        gHash = g0 - gasleft();
        AA.Cert memory p = AA.parse(parent);
        ok = AA.verifiedByP384(v384, child, c, AA.p384Key(parent, p), hints);
        g -= gasleft();
        g -= gHash; // the probe hash above is a duplicate of the one inside verifiedByP384
    }

    function gLinkRsa(bytes memory child, bytes memory parent) external view returns (uint256 g, bool ok) {
        g = gasleft();
        AA.Cert memory p = AA.parse(parent);
        (bytes memory n, uint256 e) = AA.rsaKey(parent, p);
        ok = AA.verifiedByRsa(child, AA.parse(child), n, e);
        g -= gasleft();
    }

    function gModexp(bytes memory b, uint256 e, bytes memory m) external view returns (uint256 g) {
        bytes memory input = abi.encodePacked(b.length, uint256(32), m.length, b, e, m);
        bytes memory out = new bytes(m.length);
        g = gasleft();
        assembly {
            if iszero(staticcall(gas(), 0x05, add(input, 32), mload(input), add(out, 32), mload(m))) { revert(0, 0) }
        }
        g -= gasleft();
    }

    function gP256Precompile(bytes32 h, bytes32 r, bytes32 s, bytes32 x, bytes32 y) external view returns (uint256 g, bool ok) {
        g = gasleft();
        ok = AA.p256(h, r, s, x, y);
        g -= gasleft();
    }

    function hasKeyDescription(bytes memory d) external pure returns (bool) {
        return AA.hasKeyDescription(d, AA.parse(d));
    }

    function modexp(bytes memory b, uint256 e, bytes memory m) external view returns (bytes memory) {
        return AA.modexp(b, e, m);
    }

    function sha384(bytes memory d) external pure returns (bytes memory) {
        AA.Cert memory c = AA.parse(d);
        return Sha384Probe.tbs(d, c.tbsStart, c.tbsLen);
    }
}

import {Sha2Ext} from "nitro/Sha2Ext.sol";

library Sha384Probe {
    function tbs(bytes memory d, uint256 s, uint256 l) internal pure returns (bytes memory) {
        return Sha2Ext.sha384(d, s, l);
    }
}

/// @notice All certificates are the REAL attestation chains in ../phone_vectors_v1:
///  Samsung S25 Ultra StrongBox (factory-provisioned, 4 certs to the Google RSA-4096 root) and
///  OnePlus CPH2487 TEE (RKP, 5 certs to Google's P-384 "Key Attestation CA1" root).
contract AttestationTest is Test {
    uint256 constant TX_CAP = 16_777_216; // EIP-7825 per-transaction gas cap (Fusaka)
    string chains;
    AttestHarness h;

    function setUp() public {
        chains = vm.readFile("fixtures/chains.json");
        h = new AttestHarness();
    }

    function _der(string memory chain, uint256 i) internal view returns (bytes memory) {
        return vm.parseJsonBytes(chains, string.concat(".", chain, "[", vm.toString(i), "].der"));
    }

    function _j(string memory chain, uint256 i, string memory f) internal pure returns (string memory) {
        return string.concat(".", chain, "[", vm.toString(i), "].", f);
    }

    function _b32(string memory k) internal view returns (bytes32) {
        return vm.parseJsonBytes32(chains, k);
    }

    // ------------------------------------------------------------------ parser == Python on every real cert

    function test_parser_matchesPython_allRealCerts() public view {
        string[5] memory names =
            ["samsungSB_mint_c1", "samsungSB_mint_c2_cheat", "samsungSB_dave", "oneplusTEE_bob", "oneplusTEE_charlie"];
        uint8[5] memory lens = [4, 4, 4, 5, 5];
        for (uint256 n = 0; n < 5; n++) {
            for (uint256 i = 0; i < lens[n]; i++) {
                bytes memory d = _der(names[n], i);
                AA.Cert memory c = h.parse(d);
                assertEq(sha256(_slice(d, c.tbsStart, c.tbsLen)), _b32(_j(names[n], i, "tbsSha256")), "tbs");
                assertEq(h.spkiHash(d), _b32(_j(names[n], i, "spkiSha256")), "spki");
                assertEq(uint256(c.notBefore), vm.parseJsonUint(chains, _j(names[n], i, "notBefore")), "notBefore");
                assertEq(uint256(c.notAfter), vm.parseJsonUint(chains, _j(names[n], i, "notAfter")), "notAfter");
                assertEq(h.hasKeyDescription(d), vm.parseJsonBool(chains, _j(names[n], i, "hasKeyDescription")));
            }
            _checkKeyDesc(names[n]);
        }
    }

    function _checkKeyDesc(string memory n) internal view {
        AA.KeyDesc memory k = h.keyDesc(_der(n, 0));
        string memory b = _j(n, 0, "keyDescription.");
        assertEq(k.attestationVersion, vm.parseJsonUint(chains, string.concat(b, "attestationVersion")));
        assertEq(k.attestationSecurityLevel, vm.parseJsonUint(chains, string.concat(b, "attestationSecurityLevel")));
        assertEq(k.keyMintSecurityLevel, vm.parseJsonUint(chains, string.concat(b, "keyMintSecurityLevel")));
        assertEq(k.challengeHash, keccak256(vm.parseJsonBytes(chains, string.concat(b, "attestationChallenge"))));
        assertEq(k.usageCountLimitHw, vm.parseJsonUint(chains, string.concat(b, "usageCountLimitHw")));
        assertEq(k.usageCountLimitInSw, vm.parseJsonUint(chains, string.concat(b, "usageCountLimitSw")) != 0);
        assertEq(k.deviceLocked, vm.parseJsonBool(chains, string.concat(b, "deviceLocked")));
        assertEq(k.verifiedBootState, vm.parseJsonUint(chains, string.concat(b, "verifiedBootState")));
        assertEq(k.verifiedBootKey, _b32(string.concat(b, "verifiedBootKey")));
        assertEq(k.origin, vm.parseJsonUint(chains, string.concat(b, "origin")));
        assertEq(k.algorithm, vm.parseJsonUint(chains, string.concat(b, "algorithm")));
        assertEq(k.ecCurve, vm.parseJsonUint(chains, string.concat(b, "ecCurve")));
        assertEq(k.purposeSign, vm.parseJsonBool(chains, string.concat(b, "purposeSign")));
        assertEq(k.packageNameHash, keccak256(bytes(vm.parseJsonString(chains, string.concat(b, "packageName")))));
        assertEq(k.packageVersion, vm.parseJsonUint(chains, string.concat(b, "packageVersion")));
        assertEq(k.signatureDigest, _b32(string.concat(b, "signatureDigest")));
    }

    function _slice(bytes memory d, uint256 s, uint256 l) internal pure returns (bytes memory o) {
        o = new bytes(l);
        for (uint256 i = 0; i < l; i++) o[i] = d[s + i];
    }

    // ------------------------------------------------------------------ OTK policy on real leaves

    bytes32 constant PKG = keccak256("xyz.prawl.otktest");

    function test_policy_realOtkLeaves_pass_cheatKey_fails() public view {
        bytes32 signer = _b32(".samsungSB_mint_c1[0].keyDescription.signatureDigest");
        (bool ok, uint256 fails, bytes32 kh,,) = _leaf("samsungSB_mint_c1", signer);
        assertTrue(ok);
        assertEq(fails, 0, "Samsung StrongBox genesis key c1: acceptable OTK");
        assertEq(kh, _b32(".samsungSB_mint_c1[0].spkiSha256"));
        (ok, fails,,,) = _leaf("oneplusTEE_bob", signer);
        assertTrue(ok);
        assertEq(fails, 0, "OnePlus TEE key bob: acceptable OTK");
        (ok, fails,,,) = _leaf("samsungSB_dave", signer);
        assertEq(fails, 0);
        (ok, fails,,,) = _leaf("samsungSB_mint_c2_cheat", signer);
        assertTrue(ok, "the cheat key IS a genuine hardware key ...");
        assertEq(fails, AA.F_USAGE_HW, "... but without usageCountLimit=1: rejected by exactly that rule");
        // wrong app identity (package name)
        (bool ok2, uint256 f2,,,) = h.leafCheck(
            _der("oneplusTEE_bob", 0),
            _b32(".oneplusTEE_bob[1].pubX"),
            _b32(".oneplusTEE_bob[1].pubY"),
            keccak256("com.evil.app"),
            signer
        );
        assertTrue(ok2);
        assertEq(f2, AA.F_PACKAGE);
    }

    function _leaf(string memory n, bytes32 signer)
        internal
        view
        returns (bool ok, uint256 fails, bytes32 kh, bytes32 x, bytes32 y)
    {
        return h.leafCheck(_der(n, 0), _b32(_j(n, 1, "pubX")), _b32(_j(n, 1, "pubY")), PKG, signer);
    }

    function test_tamperedLeaf_rejected() public view {
        bytes memory d = _der("oneplusTEE_bob", 0);
        // flip one byte inside the KeyDescription (usageCountLimit would be the attacker's target)
        AA.Cert memory c = h.parse(d);
        d[c.extStart + 40] = bytes1(uint8(d[c.extStart + 40]) ^ 0x01);
        assertFalse(h.linkP256Cached(d, _b32(".oneplusTEE_bob[1].pubX"), _b32(".oneplusTEE_bob[1].pubY")));
    }

    // ------------------------------------------------------------------ gas: (a) leaf signature, (b) fields
    // All gas figures are measured INSIDE the harness call (gasleft deltas around the library code), so they
    // exclude the 21k base cost, calldata and ABI decoding. Per-transaction totals come from anvil receipts
    // (script/AnvilGas.s.sol).

    function test_gas_a_b_leaf() public view {
        string[2] memory ns = ["samsungSB_mint_c1", "oneplusTEE_bob"];
        for (uint256 n = 0; n < 2; n++) {
            bytes memory leaf = _der(ns[n], 0);
            bytes memory ak = _der(ns[n], 1);
            bytes32 x = _b32(_j(ns[n], 1, "pubX"));
            bytes32 y = _b32(_j(ns[n], 1, "pubY"));
            console.log(ns[n], "leaf bytes:", leaf.length);
            console.log("  parse leaf structure (X.509 skeleton):", h.gParse(leaf));
            (uint256 g, bool ok) = h.gLinkP256Cached(leaf, x, y);
            assertTrue(ok);
            console.log("  (a) leaf sig by cached AK key: parse + sha256(tbs) + DER sig + P256VERIFY:", g);
            (g, ok) = h.gLinkP256(leaf, ak);
            assertTrue(ok);
            console.log("  (a) same, AK cert parsed too for its key:", g);
            console.log("  (b) KeyDescription fields + OTK policy (leaf already parsed):", h.gKeyDescOnly(leaf));
            uint256 fails;
            (g, fails) = h.gLeafCheck(leaf, x, y);
            assertEq(fails, 0);
            console.log("  (a)+(b) complete leaf check vs cached AK (sig, policy, key hash, x/y):", g);
        }
        (uint256 gp, bool okp) = h.gP256Precompile(
            sha256("x"), bytes32(uint256(1)), bytes32(uint256(1)), _b32(".oneplusTEE_bob[1].pubX"), _b32(".oneplusTEE_bob[1].pubY")
        );
        assertFalse(okp);
        console.log("P256VERIFY staticcall alone (incl. call overhead):", gp);
    }

    // ------------------------------------------------------------------ gas: (c) walk to the Google roots

    function test_gas_c_oneplusRKP_toGoogleP384Root() public view {
        string memory n = "oneplusTEE_bob";
        bytes[] memory c = new bytes[](5);
        for (uint256 i = 0; i < 5; i++) c[i] = _der(n, i);
        uint256[] memory d = new uint256[](5);
        uint256[] memory sh = new uint256[](5);
        bool ok;
        (d[0], ok) = h.gLinkP256(c[0], c[1]);
        assertTrue(ok);
        (d[1], ok) = h.gLinkP256(c[1], c[2]);
        assertTrue(ok);
        for (uint256 i = 2; i < 5; i++) {
            bytes memory hints = vm.parseJsonBytes(chains, _j(n, i, "p384Hints"));
            (d[i], sh[i], ok) = h.gLinkP384(c[i], c[i < 4 ? i + 1 : 4], hints);
            assertTrue(ok);
            assertLt(d[i], TX_CAP);
        }
        console.log("OnePlus RKP chain, gas per link (inside call):");
        console.log("  leaf   <- RKP AK    P-256 / SHA-256 (P256VERIFY):", d[0]);
        console.log("  RKP AK <- Droid CA3 P-256 / SHA-256 (P256VERIFY):", d[1]);
        console.log("  CA3    <- Droid CA2 P-384 / SHA-384 total:", d[2]);
        console.log("     of which SHA-384 in Solidity:", sh[2]);
        console.log("  CA2    <- CA1 root  P-384 / SHA-384 total:", d[3]);
        console.log("     of which SHA-384 in Solidity:", sh[3]);
        console.log("  (CA1 self-signature; skipped when CA1 is pinned):", d[4]);
        console.log("  total leaf..CA1 (CA1 pinned by SPKI):", d[0] + d[1] + d[2] + d[3]);
        console.log("  total leaf..cached CA3 (governance/trustless cache):", d[0] + d[1]);
    }

    function test_gas_c_samsungFactory_toGoogleRsaRoot() public view {
        string memory n = "samsungSB_mint_c1";
        bytes memory c0 = _der(n, 0);
        bytes memory c1 = _der(n, 1);
        bytes memory c2 = _der(n, 2);
        bytes memory c3 = _der(n, 3);
        bytes memory h1 = vm.parseJsonBytes(chains, _j(n, 1, "p384Hints"));
        (uint256 d0, bool ok) = h.gLinkP256(c0, c1);
        assertTrue(ok);
        (uint256 d1,, bool ok1) = h.gLinkP384(c1, c2, h1);
        assertTrue(ok1);
        uint256 d2;
        (d2, ok) = h.gLinkRsa(c2, c3);
        assertTrue(ok);
        uint256 d3;
        (d3, ok) = h.gLinkRsa(c3, c3);
        assertTrue(ok);
        console.log("Samsung factory StrongBox chain, gas per link (inside call):");
        console.log("  leaf <- batch AK       P-256 / SHA-256 (P256VERIFY):", d0);
        console.log("  AK   <- SB intermediate P-384 key, ecdsa-with-SHA256 (hinted P-384):", d1);
        console.log("  int. <- Google root    RSA-4096 sha256WithRSA (MODEXP):", d2);
        console.log("  (root self-signature; skipped when pinned):", d3);
        console.log("  total leaf..root (root pinned):", d0 + d1 + d2);
        console.log("  hint calldata bytes AK:", h1.length);
    }

    /// MODEXP alone with the real RSA-4096 key; run under osaka (default) and FOUNDRY_PROFILE=prague.
    function test_gas_modexp_rsa4096_alone() public view {
        bytes memory n = vm.parseJsonBytes(chains, ".samsungSB_mint_c1[3].rsaN");
        bytes memory sig = vm.parseJsonBytes(chains, ".samsungSB_mint_c1[2].rsaSig");
        console.log("MODEXP 512-byte base/mod, 32-byte exp field (e=65537), precompile call only:", h.gModexp(sig, 65537, n));
    }

    function test_gas_sha384_inSolidity() public view {
        bytes memory ca3 = _der("oneplusTEE_bob", 2);
        bytes memory out = h.sha384(ca3);
        assertEq(keccak256(out), keccak256(vm.parseJsonBytes(chains, ".oneplusTEE_bob[2].tbsSha384")));
    }

    function test_negative_wrongHints_or_wrongParent_fail() public {
        string memory n = "oneplusTEE_bob";
        bytes memory hints = vm.parseJsonBytes(chains, _j(n, 2, "p384Hints"));
        hints[100] = bytes1(uint8(hints[100]) ^ 1);
        vm.expectRevert(bytes("bad inverse hint"));
        h.linkP384(_der(n, 2), _der(n, 3), hints);
        // RSA: an intermediate is not signed by a different (self-made) key
        assertFalse(h.linkP256(_der(n, 0), _der("samsungSB_mint_c1", 1)), "Bob's leaf is not signed by Samsung's AK");
        bytes memory i2 = _der("samsungSB_mint_c1", 2);
        AA.Cert memory c = h.parse(i2);
        i2[c.tbsStart + 30] = bytes1(uint8(i2[c.tbsStart + 30]) ^ 1);
        assertFalse(h.linkRsa(i2, _der("samsungSB_mint_c1", 3)), "tampered intermediate fails RSA check");
    }
}
