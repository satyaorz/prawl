// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {HonkVerifier} from "../src/v1/HonkVerifierV1.sol";
import {ZkOtkGate, IHonkVerifier} from "../src/ZkOtkGate.sol";

/// Real circuit-v1 proof (OnePlus RKP chain) verified by the bb-generated Solidity verifier, evm_version osaka.
contract VerifyV1Test is Test {
    HonkVerifier v;
    bytes proof;
    bytes32[] pi;

    function setUp() public {
        v = new HonkVerifier();
        proof = vm.readFileBinary("fixtures/v1_proof");
        bytes memory raw = vm.readFileBinary("fixtures/v1_public_inputs");
        require(raw.length == 17 * 32, "pi len");
        pi = new bytes32[](17);
        for (uint256 i = 0; i < 17; i++) {
            bytes32 w;
            assembly { w := mload(add(add(raw, 32), mul(i, 32))) }
            pi[i] = w;
        }
    }

    function test_verify_gas() public {
        uint256 g = gasleft();
        bool ok = v.verify(proof, pi);
        uint256 used = g - gasleft();
        assertTrue(ok);
        console2.log("v1 verify() gas (call incl. calldata copy, excl. tx intrinsic):", used);
        assertLt(used, 2 ** 24);
    }

    function test_codesize() public view {
        console2.log("HonkVerifierV1 runtime bytes:", address(v).code.length);
    }

    function test_reject_flipped_proof_byte() public {
        bytes memory p = proof;
        p[1000] = bytes1(uint8(p[1000]) ^ 1);
        try v.verify(p, pi) returns (bool ok) {
            assertFalse(ok);
        } catch {}
    }

    function test_reject_changed_coin_key() public {
        bytes32[] memory q = pi;
        q[9] = bytes32(uint256(q[9]) ^ 1); // K.x_hi
        try v.verify(proof, q) returns (bool ok) {
            assertFalse(ok);
        } catch {}
    }

    function test_reject_changed_rev_root() public {
        bytes32[] memory q = pi;
        q[4] = bytes32(uint256(q[4]) ^ 1);
        try v.verify(proof, q) returns (bool ok) {
            assertFalse(ok);
        } catch {}
    }

    function _gate() internal returns (ZkOtkGate gate) {
        bytes32 ca3 = keccak256(abi.encodePacked(pi[0], pi[1], pi[2], pi[3]));
        gate = new ZkOtkGate(IHonkVerifier(address(v)), ca3, pi[4], pi[5], 202601);
        vm.warp(1794009600); // 2026-11-07 00:00 UTC, inside [t_from 2026-11-06, t_until 2026-11-17]
    }

    function test_gate_time_conversion() public {
        ZkOtkGate gate = _gate();
        assertEq(gate.yymmddhhmmss(1794009600), 261107000000);
        assertEq(gate.yymmddhhmmss(1709251199), 240229235959); // leap day
    }

    function test_gate_register_gas() public {
        ZkOtkGate gate = _gate();
        uint256 g = gasleft();
        bytes32 kh = gate.register(proof, pi);
        uint256 used = g - gasleft();
        console2.log("gate.register gas (verify + policy + 1 new slot):", used);
        // keyHash must equal the SPKI-DER SHA-256 of the real coin key (v3 SPEC keyHash)
        assertEq(kh, hex"d7b3393339ada487dcf310f4f9ea02a7b28cd2c4c541bf236deee2b5ac9bdf19");
        vm.expectRevert(ZkOtkGate.AlreadyAttested.selector);
        gate.register(proof, pi);
    }

    function test_gate_rejects_expired() public {
        ZkOtkGate gate = _gate();
        vm.warp(1794960000); // 2026-11-18 00:00: after t_until (2026-11-17 00:00)
        vm.expectRevert(ZkOtkGate.OutsideWindow.selector);
        gate.check(proof, pi);
    }

    function test_gate_rejects_stale_root() public {
        ZkOtkGate gate = _gate();
        gate.setRoots(bytes32(uint256(1)), pi[5]);
        vm.expectRevert(ZkOtkGate.StaleRoot.selector);
        gate.check(proof, pi);
    }
}
