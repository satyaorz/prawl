// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {ECDSA384 as SolarityECDSA384} from "solarity/libs/crypto/ECDSA384.sol";
import {ECDSA384Curve} from "nitro/ECDSA384Curve.sol";

/// @notice UNHINTED P-384 (upstream Solarity ECDSA384, inverses computed on-chain with MODEXP), only to
///  measure what EIP-7883 does to a fully on-chain P-384 verify. Run under osaka (default) and
///  FOUNDRY_PROFILE=prague. Inputs are the REAL Samsung (AK <- StrongBox intermediate) and OnePlus
///  (Droid CA3 <- Droid CA2) certificate signatures; s is normalised to low-s ((r, n-s) is equally
///  valid) because upstream rejects s > n/2.
contract P384UnhintedHarness {
    function gVerify(bytes memory h, bytes memory rs, bytes memory pub) external view returns (uint256 g, bool ok) {
        SolarityECDSA384.Parameters memory p = SolarityECDSA384.Parameters({
            a: ECDSA384Curve.CURVE_A,
            b: ECDSA384Curve.CURVE_B,
            gx: ECDSA384Curve.CURVE_GX,
            gy: ECDSA384Curve.CURVE_GY,
            p: ECDSA384Curve.CURVE_P,
            n: ECDSA384Curve.CURVE_N
        });
        g = gasleft();
        ok = SolarityECDSA384.verify(p, h, rs, pub);
        g -= gasleft();
    }
}

contract P384UnhintedTest is Test {
    string chains;
    P384UnhintedHarness h;

    function setUp() public {
        chains = vm.readFile("fixtures/chains.json");
        h = new P384UnhintedHarness();
    }

    function _run(string memory child, string memory parent, string memory hashField) internal view returns (uint256 g) {
        bytes memory hash = vm.parseJsonBytes(chains, string.concat(child, ".", hashField));
        bytes memory rs = abi.encodePacked(
            vm.parseJsonBytes(chains, string.concat(child, ".sigR")), vm.parseJsonBytes(chains, string.concat(child, ".sigSLow"))
        );
        bytes memory pub = abi.encodePacked(
            vm.parseJsonBytes(chains, string.concat(parent, ".pubX")), vm.parseJsonBytes(chains, string.concat(parent, ".pubY"))
        );
        bool ok;
        (g, ok) = h.gVerify(hash, rs, pub);
        assertTrue(ok, "unhinted P-384 verify");
    }

    function test_gas_p384_unhinted() public view {
        uint256 g1 = _run(".samsungSB_mint_c1[1]", ".samsungSB_mint_c1[2]", "tbsSha256");
        console.log("UNHINTED P-384 verify, Samsung AK <- StrongBox intermediate (SHA-256 digest):", g1);
        uint256 g2 = _run(".oneplusTEE_bob[2]", ".oneplusTEE_bob[3]", "tbsSha384");
        console.log("UNHINTED P-384 verify, OnePlus Droid CA3 <- Droid CA2 (SHA-384 digest):", g2);
        console.log("EIP-7825 per-tx cap 16777216 exceeded?", g1 > 16_777_216 || g2 > 16_777_216);
    }
}
