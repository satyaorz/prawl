// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {HonkVerifier as HonkV1} from "../src/v1/HonkVerifierV1.sol";
import {HonkVerifier as HonkV2} from "../src/v2/HonkVerifierV2.sol";
import {ZkOtkGate, IHonkVerifier} from "../src/ZkOtkGate.sol";

/// Real circuit-v2 proof (Samsung S25 Ultra StrongBox factory chain, allow-list design A) verified by the
/// bb-generated Solidity verifier (evm_version osaka), and the unified gate that takes v1 AND v2 proofs.
contract VerifyV2Test is Test {
    HonkV1 v1;
    HonkV2 v2;
    bytes proof2;
    bytes32[] pi2;
    bytes proof1;
    bytes32[] pi1;

    function _load(string memory pf, string memory pif) internal view returns (bytes memory p, bytes32[] memory pi) {
        p = vm.readFileBinary(pf);
        bytes memory raw = vm.readFileBinary(pif);
        require(raw.length == 17 * 32, "pi len");
        pi = new bytes32[](17);
        for (uint256 i = 0; i < 17; i++) {
            bytes32 w;
            assembly { w := mload(add(add(raw, 32), mul(i, 32))) }
            pi[i] = w;
        }
    }

    function setUp() public {
        v1 = new HonkV1();
        v2 = new HonkV2();
        (proof2, pi2) = _load("fixtures/v2_proof", "fixtures/v2_public_inputs");
        (proof1, pi1) = _load("fixtures/v1_proof", "fixtures/v1_public_inputs");
    }

    function test_v2_public_shape_equals_v1() public view {
        assertEq(pi2.length, pi1.length);
        assertEq(uint256(pi2[0]), 2, "kind");
        assertEq(uint256(pi2[2]), 0);
        assertEq(uint256(pi2[3]), 0);
        assertEq(proof2.length, proof1.length, "same proof size");
        // identical policy fields (same trees/window) so one gate can hold both
        assertEq(pi2[4], pi1[4], "rev_root");
        assertEq(pi2[5], pi1[5], "ban_root");
        assertEq(pi2[6], pi1[6]);
        assertEq(pi2[7], pi1[7]);
    }

    function test_v2_verify_gas() public {
        uint256 g = gasleft();
        bool ok = v2.verify(proof2, pi2);
        uint256 used = g - gasleft();
        assertTrue(ok);
        console2.log("v2 verify() gas (call incl. calldata copy, excl. tx intrinsic):", used);
        assertLt(used, 2 ** 24);
    }

    function test_v2_codesize() public view {
        console2.log("HonkVerifierV2 runtime bytes:", address(v2).code.length);
    }

    function test_v2_reject_flipped_proof_byte() public {
        bytes memory p = proof2;
        p[1000] = bytes1(uint8(p[1000]) ^ 1);
        try v2.verify(p, pi2) returns (bool ok) {
            assertFalse(ok);
        } catch {}
    }

    function test_v2_reject_changed_coin_key() public {
        bytes32[] memory q = pi2;
        q[9] = bytes32(uint256(q[9]) ^ 1);
        try v2.verify(proof2, q) returns (bool ok) {
            assertFalse(ok);
        } catch {}
    }

    function test_v2_reject_changed_allow_root() public {
        bytes32[] memory q = pi2;
        q[1] = bytes32(uint256(q[1]) ^ 1);
        try v2.verify(proof2, q) returns (bool ok) {
            assertFalse(ok);
        } catch {}
    }

    function test_v1_proof_does_not_verify_under_v2_vk() public {
        try v2.verify(proof1, pi1) returns (bool ok) {
            assertFalse(ok);
        } catch {}
        try v1.verify(proof2, pi2) returns (bool ok) {
            assertFalse(ok);
        } catch {}
    }

    function _gate() internal returns (ZkOtkGate gate) {
        bytes32 ca3 = keccak256(abi.encodePacked(pi1[0], pi1[1], pi1[2], pi1[3]));
        gate = new ZkOtkGate(IHonkVerifier(address(v1)), ca3, pi1[4], pi1[5], 202601);
        gate.setFactoryVerifier(IHonkVerifier(address(v2)));
        gate.setAnchor(keccak256(abi.encodePacked(pi2[0], pi2[1], pi2[2], pi2[3])), true); // the vetted allow-list root
        vm.warp(1794009600); // 2026-11-07 00:00 UTC, inside [t_from 2026-11-06, t_until 2026-11-17]
    }

    function test_gate_register_both_kinds_gas() public {
        ZkOtkGate gate = _gate();
        uint256 g = gasleft();
        bytes32 k1 = gate.registerKind(1, proof1, pi1);
        uint256 used1 = g - gasleft();
        g = gasleft();
        bytes32 k2 = gate.registerKind(2, proof2, pi2);
        uint256 used2 = g - gasleft();
        console2.log("gate.registerKind(1, v1 proof) gas:", used1);
        console2.log("gate.registerKind(2, v2 proof) gas:", used2);
        assertTrue(k1 != k2);
        // the old entry point still means kind 1
        vm.expectRevert(ZkOtkGate.AlreadyAttested.selector);
        gate.register(proof1, pi1);
        // keyHash = SPKI-DER SHA-256 of the Samsung coin key (recomputed independently by tools/ytag_demo_v2.py)
        assertEq(k2, vm.parseBytes32(vm.readFile("fixtures/v2_keyhash.txt")));
    }

    function test_gate_rejects_wrong_kind() public {
        ZkOtkGate gate = _gate();
        vm.expectRevert(ZkOtkGate.BadKind.selector);
        gate.checkKind(2, proof1, pi1); // a v1 public-input vector is not a factory proof
        vm.expectRevert(); // v2 proof under the v1 verifier: anchor is trusted, proof does not verify
        gate.checkKind(1, proof2, pi2);
        vm.expectRevert(ZkOtkGate.BadKind.selector);
        gate.checkKind(3, proof2, pi2);
    }

    function test_gate_rejects_attacker_allowlist() public {
        ZkOtkGate gate = _gate();
        // A valid proof (software-signed or real leaf) under an allow-list the attacker built himself.
        (bytes memory pa, bytes32[] memory pia) = _load("fixtures/v2_attacker_proof", "fixtures/v2_attacker_public_inputs");
        assertTrue(v2.verify(pa, pia), "mathematically valid: the circuit cannot know the list is fake");
        assertTrue(pia[1] != pi2[1], "different allow_root");
        vm.expectRevert(ZkOtkGate.UntrustedCa3.selector); // anchor not approved
        gate.checkKind(2, pa, pia);
    }

    function test_gate_rejects_stale_allow_root_after_governance_removes_it() public {
        ZkOtkGate gate = _gate();
        gate.setAnchor(keccak256(abi.encodePacked(pi2[0], pi2[1], pi2[2], pi2[3])), false);
        vm.expectRevert(ZkOtkGate.UntrustedCa3.selector);
        gate.checkKind(2, proof2, pi2);
    }

    function test_gate_rejects_expired_v2() public {
        ZkOtkGate gate = _gate();
        vm.warp(1794960000); // 2026-11-18
        vm.expectRevert(ZkOtkGate.OutsideWindow.selector);
        gate.checkKind(2, proof2, pi2);
    }
}
