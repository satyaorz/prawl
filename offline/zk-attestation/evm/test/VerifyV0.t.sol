// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {HonkVerifier} from "../src/v0/HonkVerifierV0.sol";

/// Real circuit-v0 proof (OnePlus leaf link) on the bb-generated verifier.
contract VerifyV0Test is Test {
    HonkVerifier v;
    bytes proof;
    bytes32[] pi;

    function setUp() public {
        v = new HonkVerifier();
        proof = vm.readFileBinary("fixtures/v0_proof");
        bytes memory raw = vm.readFileBinary("fixtures/v0_public_inputs");
        pi = new bytes32[](raw.length / 32);
        for (uint256 i = 0; i < pi.length; i++) {
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
        console2.log("v0 verify() gas:", used);
        console2.log("HonkVerifierV0 runtime bytes:", address(v).code.length);
    }
}
