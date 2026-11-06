// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {PrawlRealEscrow} from "../src/PrawlRealEscrow.sol";
import {PrawlAttestedEscrow, IOtkChecker} from "../src/PrawlAttestedEscrow.sol";
import {DeviceBondRegistry, IBrokenKeys} from "../src/DeviceBondRegistry.sol";
import {P384Verifier} from "nitro/P384Verifier.sol";

/// @notice Broadcasts the key transactions with the REAL phone data to a local anvil (--hardfork osaka) so that
///  full transaction gas (21k base + calldata + execution) can be read from the receipts.
///  Run: see RESULTS.md ("How to re-run"). Receipts land in broadcast/AnvilGas.s.sol/31337/run-latest.json.
contract AnvilGas is Script {
    string pays;

    function _b(string memory j, string memory k) internal pure returns (bytes32) {
        return vm.parseJsonBytes32(j, k);
    }

    function _hops(string memory pay, uint256 n) internal view returns (PrawlRealEscrow.Hop[] memory hs) {
        hs = new PrawlRealEscrow.Hop[](n);
        for (uint256 i = 0; i < n; i++) {
            string memory b = string.concat(".payments.", pay, ".hops[", vm.toString(i), "].");
            hs[i] = PrawlRealEscrow.Hop(
                _b(pays, string.concat(b, "x")), _b(pays, string.concat(b, "y")), _b(pays, string.concat(b, "r")), _b(pays, string.concat(b, "s"))
            );
        }
    }

    function _der(string memory c, uint256 i) internal view returns (bytes memory) {
        return vm.readFileBinary(string.concat("fixtures/bin/", c, "_", vm.toString(i), ".der"));
    }

    function _hints(string memory c, uint256 i) internal view returns (bytes memory) {
        return vm.readFileBinary(string.concat("fixtures/bin/", c, "_", vm.toString(i), ".hints"));
    }

    /// sha256 of a certificate's SPKI (= issuer / AK id), read from the small payments-side constants below
    function _spkiId(string memory c, uint256 i) internal view returns (bytes32) {
        return bytes32(vm.parseBytes(vm.readFile(string.concat("fixtures/bin/", c, "_", vm.toString(i), ".spki"))));
    }

    function run() external {
        pays = vm.readFile("fixtures/payments.json");
        uint256 pk = vm.envUint("PK");
        address bob = address(0xB0B);
        address dave = address(0xDA7E);
        bytes32 k0x = _b(pays, ".payments.bob.k0x");
        bytes32 k0y = _b(pays, ".payments.bob.k0y");
        uint64 exp = uint64(block.timestamp + 30 days);

        vm.startBroadcast(pk);
        // ---- Task 1: plain escrow, REAL hop chains (v1-compat mode, 120 s window)
        PrawlRealEscrow e1 = new PrawlRealEscrow(120, false); // tx: deploy
        e1.deposit{value: 0.2 ether}("c1", "0.2", k0x, k0y, exp); // tx: deposit
        e1.redeem("c1", _hops("bob", 1), bob, 0, 0); // tx: redeem 1 hop (REAL)
        e1.redeem("c1", _hops("dave", 2), dave, 0, 0); // tx: redeem 2 hops superseding the 1-hop claim
        PrawlRealEscrow e2 = new PrawlRealEscrow(120, false);
        e2.deposit{value: 0.2 ether}("c1", "0.2", k0x, k0y, exp);
        e2.redeem("c1", _hops("dave", 2), dave, 0, 0); // tx: redeem 2 hops, first claim (REAL)
        // equivocation (SYNTHETIC software genesis key)
        e2.deposit{value: 0.05 ether}("c3", "0.05", _b(pays, ".equivocation.k0x"), _b(pays, ".equivocation.k0y"), exp);
        e2.proveEquivocation(
            "c3",
            new PrawlRealEscrow.Hop[](0),
            PrawlRealEscrow.Signed(
                vm.parseJsonBytes(pays, ".equivocation.branches.bob.messageHex"),
                _b(pays, ".equivocation.branches.bob.r"),
                _b(pays, ".equivocation.branches.bob.s")
            ),
            PrawlRealEscrow.Signed(
                vm.parseJsonBytes(pays, ".equivocation.branches.charlie.messageHex"),
                _b(pays, ".equivocation.branches.charlie.r"),
                _b(pays, ".equivocation.branches.charlie.s")
            )
        );

        // ---- Task 2: attestation on-chain, REAL certificate chains
        PrawlAttestedEscrow ae = new PrawlAttestedEscrow(120, false, false);
        bytes[] memory roots = new bytes[](2);
        roots[0] = _der("samsungSB_mint_c1", 3);
        roots[1] = _der("oneplusTEE_bob", 4);
        DeviceBondRegistry reg = new DeviceBondRegistry(
            roots,
            DeviceBondRegistry.Config(
                vm.addr(pk),
                IBrokenKeys(address(ae)),
                1 ether,
                60 days,
                keccak256("xyz.prawl.otktest"),
                bytes32(vm.parseBytes(vm.readFile("fixtures/bin/app_signer_digest.txt"))),
                new P384Verifier()
            )
        );
        ae.setRegistry(IOtkChecker(address(reg)));
        bytes32 i2 = reg.cacheIssuer(_der("samsungSB_mint_c1", 2), _spkiId("samsungSB_mint_c1", 3), ""); // RSA-4096
        bytes32 akS = reg.registerAttestationKey(_der("samsungSB_mint_c1", 1), i2, _hints("samsungSB_mint_c1", 1)); // P-384
        ae.depositAttested{value: 0.2 ether}("c1", "0.2", _der("samsungSB_mint_c1", 0), akS, exp); // REAL leaf
        bytes32 ca2 = reg.cacheIssuer(_der("oneplusTEE_bob", 3), _spkiId("oneplusTEE_bob", 4), _hints("oneplusTEE_bob", 3));
        bytes32 ca3 = reg.cacheIssuer(_der("oneplusTEE_bob", 2), ca2, _hints("oneplusTEE_bob", 2));
        reg.registerAttestationKey(_der("oneplusTEE_bob", 1), ca3, "");
        vm.stopBroadcast();
        console.log("e1", address(e1));
        console.log("e2", address(e2));
    }
}
