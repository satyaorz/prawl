// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {PrawlRealEscrow} from "../src/PrawlRealEscrow.sol";
import {PrawlAttestedEscrow, IOtkChecker} from "../src/PrawlAttestedEscrow.sol";
import {DeviceBondRegistry, IBrokenKeys} from "../src/DeviceBondRegistry.sol";
import {AndroidAttestation as AA} from "../src/attest/AndroidAttestation.sol";
import {P384Verifier} from "nitro/P384Verifier.sol";

/// @notice REAL phone vectors v2 (../phone_vectors_v2_onchain, converted by tools/vectors_v2_to_foundry.py):
///  r1 = Samsung StrongBox genesis -> Bob (OnePlus TEE) -> Bob's one-time key signs a REDEMPTION to
///       payout 0x...0B0B00 via escrow 0x...0E5C70 on chain 31337 (the PRAWL-REDEEM tip-auth format);
///  e1 = a Samsung StrongBox key WITHOUT setMaxUsageCount that signed hop 0 to Bob AND to Charlie: a REAL
///       equivocation, both signatures produced by phone hardware.
contract RealPhoneV2Test is Test {
    address constant ESCROW = address(0xE5C70); // the address the phone signed for
    address constant PAYOUT = address(0xB0B00); // the payout the phone signed for
    uint256 constant WINDOW = 1 days;
    uint256 constant NOW = 1_793_966_400; // 2026-11-06 12:00 UTC (inside the Samsung AK/intermediate validity)
    string j;
    address alice = makeAddr("alice");

    function setUp() public {
        vm.warp(NOW);
        j = vm.readFile("fixtures/payments_v2.json");
        vm.deal(alice, 10 ether);
        assertEq(block.chainid, 31337);
    }

    function _b(string memory k) internal view returns (bytes32) {
        return vm.parseJsonBytes32(j, k);
    }

    function _hop(string memory base) internal view returns (PrawlRealEscrow.Hop[] memory h) {
        h = new PrawlRealEscrow.Hop[](1);
        h[0] = PrawlRealEscrow.Hop(
            _b(string.concat(base, "x")), _b(string.concat(base, "y")), _b(string.concat(base, "r")), _b(string.concat(base, "s"))
        );
    }

    function _prodAtPhoneAddress() internal returns (PrawlRealEscrow e) {
        deployCodeTo("PrawlRealEscrow.sol:PrawlRealEscrow", abi.encode(WINDOW, true), ESCROW);
        e = PrawlRealEscrow(ESCROW);
        assertTrue(e.requireTipAuth());
    }

    function _depositR1(PrawlRealEscrow e) internal {
        vm.prank(alice);
        e.deposit{value: 0.3 ether}("r1", "0.3", _b(".r1.k0x"), _b(".r1.k0y"), uint64(NOW + 30 days));
    }

    // ------------------------------------------------------------------ r1: phone-signed redemption (tip auth)

    function test_v2_realTipAuthRedeem_paysThePhoneNamedPayout() public {
        PrawlRealEscrow e = _prodAtPhoneAddress();
        _depositR1(e);
        PrawlRealEscrow.Hop[] memory h = _hop(".r1.hops[0].");
        // the contract's redemption message == the bytes Bob's phone signed
        bytes32 prev = sha256(vm.parseJsonBytes(j, ".r1.hops[0].sigDer"));
        (bytes memory m, bytes32 d) = e.redeemDigest("r1", 1, prev, PAYOUT);
        assertEq(string(m), vm.parseJsonString(j, ".r1.redeem.message"), "PRAWL-REDEEM message bytes");
        assertEq(d, _b(".r1.redeem.msgSha256"));
        bytes32 tr = _b(".r1.redeem.r");
        bytes32 ts = _b(".r1.redeem.s");
        uint256 g = gasleft();
        assertTrue(e.redeem("r1", h, PAYOUT, tr, ts));
        console.log("REAL tip-auth redeem (1 hop + phone-signed redemption), execution gas:", g - gasleft());
        bytes32 bobKey = sha256(
            abi.encodePacked(hex"3059301306072a8648ce3d020106082a8648ce3d030107034200", bytes1(0x04), h[0].x, h[0].y)
        );
        assertEq(e.keyMsg(bobKey), d, "Bob's one-time key is now on record as having signed the redemption");
        vm.warp(NOW + WINDOW);
        e.finalize("r1");
        assertEq(PAYOUT.balance, 0.3 ether);
    }

    function test_v2_realTipAuth_differentPayout_fails() public {
        PrawlRealEscrow e = _prodAtPhoneAddress();
        _depositR1(e);
        vm.expectRevert(abi.encodeWithSelector(PrawlRealEscrow.BadSig.selector, 1));
        e.redeem("r1", _hop(".r1.hops[0]."), address(0xBAD), _b(".r1.redeem.r"), _b(".r1.redeem.s"));
    }

    function test_v2_realTipAuth_differentEscrowAddress_fails() public {
        PrawlRealEscrow other = new PrawlRealEscrow(WINDOW, true); // same code, any other address
        assertTrue(address(other) != ESCROW);
        _depositR1(other);
        vm.expectRevert(abi.encodeWithSelector(PrawlRealEscrow.BadSig.selector, 1));
        other.redeem("r1", _hop(".r1.hops[0]."), PAYOUT, _b(".r1.redeem.r"), _b(".r1.redeem.s"));
    }

    function test_v2_realTipAuth_differentChainId_fails() public {
        PrawlRealEscrow e = _prodAtPhoneAddress();
        _depositR1(e);
        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(PrawlRealEscrow.BadSig.selector, 1));
        e.redeem("r1", _hop(".r1.hops[0]."), PAYOUT, _b(".r1.redeem.r"), _b(".r1.redeem.s"));
    }

    /// Someone holding only pay_r1_bob.json (the payment, not Bob's redemption) cannot cash it in production mode.
    function test_v2_payFileOnly_cannotRedeemInProduction() public {
        PrawlRealEscrow e = _prodAtPhoneAddress();
        _depositR1(e);
        PrawlRealEscrow.Hop[] memory h = _hop(".r1.hops[0].");
        vm.expectRevert(PrawlRealEscrow.TipAuthRequired.selector);
        e.redeem("r1", h, PAYOUT, 0, 0);
        // re-using the hop-0 signature as a "tip" signature does not work either
        vm.expectRevert(abi.encodeWithSelector(PrawlRealEscrow.BadSig.selector, 1));
        e.redeem("r1", h, address(this), h[0].r, h[0].s);
        // nor can Alice (depositor, already paid Bob) redeem at depth 0 without her key's signature
        vm.prank(alice);
        vm.expectRevert(PrawlRealEscrow.TipAuthRequired.selector);
        e.redeem("r1", new PrawlRealEscrow.Hop[](0), alice, 0, 0);
    }

    /// The full pipeline with real data: attested deposit (REAL StrongBox genesis certificate, verified on-chain
    /// against the registered Samsung AK), REAL hop, REAL phone-signed redemption, payout.
    function test_v2_fullRealPipeline_attestedDeposit_tipAuthRedeem() public {
        deployCodeTo("PrawlAttestedEscrow.sol:PrawlAttestedEscrow", abi.encode(WINDOW, true, false), ESCROW);
        PrawlAttestedEscrow e = PrawlAttestedEscrow(ESCROW);
        (DeviceBondRegistry reg, bytes32 ak) = _registry(IBrokenKeys(ESCROW));
        vm.prank(e.deployer());
        e.setRegistry(IOtkChecker(address(reg)));
        vm.prank(alice);
        e.depositAttested{value: 0.3 ether}("r1", "0.3", vm.parseJsonBytes(j, ".leaves.r1.leafDer"), ak, uint64(NOW + 30 days));
        assertEq(e.coin("r1").k0x, _b(".r1.k0x"), "genesis key from the real certificate");
        assertTrue(e.redeem("r1", _hop(".r1.hops[0]."), PAYOUT, _b(".r1.redeem.r"), _b(".r1.redeem.s")));
        vm.warp(NOW + WINDOW);
        e.finalize("r1");
        assertEq(PAYOUT.balance, 0.3 ether);
    }

    // ------------------------------------------------------------------ e1: REAL equivocation

    function _depositE1(PrawlRealEscrow e) internal {
        vm.prank(alice);
        e.deposit{value: 0.1 ether}("e1", "0.1", _b(".e1.bobE.k0x"), _b(".e1.bobE.k0y"), uint64(NOW + 30 days));
    }

    function test_v2_realEquivocation_proveEquivocation() public {
        PrawlRealEscrow e = new PrawlRealEscrow(WINDOW, false);
        _depositE1(e);
        bytes memory mA = vm.parseJsonBytes(j, ".e1.bobE.hops[0].messageHex");
        bytes memory mB = vm.parseJsonBytes(j, ".e1.charlieE.hops[0].messageHex");
        PrawlRealEscrow.Hop[] memory a = _hop(".e1.bobE.hops[0].");
        PrawlRealEscrow.Hop[] memory b = _hop(".e1.charlieE.hops[0].");
        uint256 g = gasleft();
        bytes32 kh = e.proveEquivocation(
            "e1", new PrawlRealEscrow.Hop[](0), PrawlRealEscrow.Signed(mA, a[0].r, a[0].s), PrawlRealEscrow.Signed(mB, b[0].r, b[0].s)
        );
        console.log("proveEquivocation with two REAL phone signatures, execution gas:", g - gasleft());
        assertEq(kh, _b(".e1.bobE.k0Hash"));
        assertTrue(e.brokenKey(kh));
        assertEq(uint8(e.coin("e1").status), uint8(PrawlRealEscrow.Status.Frozen));
        (bytes32 c, bytes32 ea, bytes32 eb) = e.evidence(kh);
        assertEq(c, keccak256("e1"));
        assertEq(ea, sha256(mA));
        assertEq(eb, sha256(mB));
    }

    function test_v2_realEquivocation_detectedByRedeem() public {
        PrawlRealEscrow e = new PrawlRealEscrow(WINDOW, false);
        _depositE1(e);
        assertTrue(e.redeem("e1", _hop(".e1.bobE.hops[0]."), address(0xB0B), 0, 0));
        assertFalse(e.redeem("e1", _hop(".e1.charlieE.hops[0]."), address(0xC4A), 0, 0), "second REAL branch");
        assertTrue(e.brokenKey(_b(".e1.bobE.k0Hash")));
        assertEq(uint8(e.coin("e1").status), uint8(PrawlRealEscrow.Status.Frozen));
    }

    /// depositAttested would have refused e1 (its attestation has no usageCountLimit), and a multi-use key's
    /// equivocation must NOT slash/blacklist the (real, shared) Samsung attestation key.
    function test_v2_e1_refusedByAttestedDeposit_andCannotSlashTheRealAK() public {
        PrawlAttestedEscrow e = new PrawlAttestedEscrow(WINDOW, false, false);
        (DeviceBondRegistry reg, bytes32 ak) = _registry(IBrokenKeys(address(e)));
        e.setRegistry(IOtkChecker(address(reg)));
        bytes memory leafE1 = vm.parseJsonBytes(j, ".leaves.e1.leafDer");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PrawlAttestedEscrow.NotOneTimeKey.selector, AA.F_USAGE_HW));
        e.depositAttested{value: 0.1 ether}("e1", "0.1", leafE1, ak, uint64(NOW + 30 days));
        // a plain deposit of e1 is still possible; the real equivocation then breaks the key in this escrow ...
        _depositE1(e);
        e.proveEquivocation(
            "e1",
            new PrawlRealEscrow.Hop[](0),
            PrawlRealEscrow.Signed(
                vm.parseJsonBytes(j, ".e1.bobE.hops[0].messageHex"), _b(".e1.bobE.hops[0].r"), _b(".e1.bobE.hops[0].s")
            ),
            PrawlRealEscrow.Signed(
                vm.parseJsonBytes(j, ".e1.charlieE.hops[0].messageHex"), _b(".e1.charlieE.hops[0].r"), _b(".e1.charlieE.hops[0].s")
            )
        );
        assertTrue(e.brokenKey(_b(".e1.bobE.k0Hash")));
        // ... but the AK never vouched for e1 as one-time, so it is not slashable
        vm.expectRevert(abi.encodeWithSelector(DeviceBondRegistry.NotOneTimeAttested.selector, AA.F_USAGE_HW));
        reg.slash(leafE1, ak);
        assertFalse(reg.blacklisted(ak));
    }

    // ------------------------------------------------------------------ helpers

    /// Registry with Google roots; trustlessly caches the Samsung StrongBox intermediate (RSA) and registers the
    /// Samsung factory AK (hinted P-384) from the v1 chain files (same AK as r1/e1: SPKI 4c4b660c...).
    function _registry(IBrokenKeys esc) internal returns (DeviceBondRegistry reg, bytes32 ak) {
        bytes[] memory roots = new bytes[](1);
        roots[0] = vm.readFileBinary("fixtures/bin/samsungSB_mint_c1_3.der");
        reg = new DeviceBondRegistry(
            roots,
            DeviceBondRegistry.Config(
                address(this),
                esc,
                1 ether,
                60 days,
                keccak256("xyz.prawl.otktest"),
                bytes32(vm.parseBytes(vm.readFile("fixtures/bin/app_signer_digest.txt"))),
                new P384Verifier()
            )
        );
        bytes32 rootId = bytes32(vm.parseBytes(vm.readFile("fixtures/bin/samsungSB_mint_c1_3.spki")));
        bytes32 i2 = reg.cacheIssuer(vm.readFileBinary("fixtures/bin/samsungSB_mint_c1_2.der"), rootId, "");
        ak = reg.registerAttestationKey(
            vm.readFileBinary("fixtures/bin/samsungSB_mint_c1_1.der"), i2, vm.readFileBinary("fixtures/bin/samsungSB_mint_c1_1.hints")
        );
        assertEq(ak, _b(".leaves.r1.akSpki"));
        assertEq(ak, _b(".leaves.e1.akSpki"));
    }
}
