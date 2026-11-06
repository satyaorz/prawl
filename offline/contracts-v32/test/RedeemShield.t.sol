// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {V31Base} from "./V31Base.sol";
import {Vm} from "forge-std/Test.sol";
import {PrawlEscrowV31} from "../src/PrawlEscrowV31.sol";
import {PrawlV3Codec as V3} from "../src/PrawlV3Codec.sol";
import {RailgunTypes} from "../src/RailgunTypes.sol";

/// @notice PRAWL-REDEEM-SHIELD outputs: a phone-signed output that commits to a whole RAILGUN ShieldRequest.
///  Local suite against MockRailgun (same ABI, fee rule and Shield event); RailgunFork.t.sol runs the same
///  flow against the REAL RailgunSmartWallet on a Sepolia fork.
contract RedeemShieldTest is V31Base {
    address dep = makeAddr("depositor");
    address relayer = makeAddr("relayer");

    function setUp() public {
        _setUp31(false);
    }

    function _shieldKh(RailgunTypes.ShieldRequest memory sr) internal view returns (bytes32 kh) {
        (kh,) = e.shieldKeyHash(sr);
    }

    /// Genesis note (1 ETH) splits: 0.6 to a RAILGUN shield, 0.4 to Bob's key; Bob later redeems publicly.
    function _scenario()
        internal
        returns (
            PrawlEscrowV31.Header memory h,
            RailgunTypes.ShieldRequest memory sr,
            PrawlEscrowV31.Redemption memory rd,
            Key memory bob
        )
    {
        Key memory k0;
        (h, k0) = _directCoin(e, "sh", 1 ether, dep);
        bob = _key("bob");
        sr = _sr("alice-0zk", 0.6 ether);
        V3.Output[] memory outs = _outs2(0.6 ether, _shieldKh(sr), 0.4 ether, bob.kh);
        rd = _tip(e, h, 0, e.genesisNoteId(h.coinId), k0, outs, 0, address(0));
    }

    function test_shield_paysIntoRailgun_restRedeemsNormally() public {
        (PrawlEscrowV31.Header memory h, RailgunTypes.ShieldRequest memory sr, PrawlEscrowV31.Redemption memory rd, Key memory bob) =
            _scenario();
        vm.recordLogs();
        uint256 g = gasleft();
        vm.prank(relayer); // anyone may submit: the destination is fixed by the phone's signature
        assertTrue(e.redeemToShield(h, _noPath(), rd, sr));
        g -= gasleft();
        emit log_named_uint("redeemToShield (genesis, mock RAILGUN), gas incl. call", g);
        // RAILGUN pulled 0.6 WETH: 0.5985 into the pool, 0.0015 (25 bps) to its treasury
        assertEq(weth.balanceOf(address(rg)), 0.5985 ether);
        assertEq(weth.balanceOf(rg.treasury()), 0.0015 ether);
        assertEq(weth.balanceOf(address(e)), 0, "no WETH at rest in the escrow");
        assertEq(address(e).balance, 0.4 ether);
        assertEq(weth.allowance(address(e), address(rg)), type(uint256).max);
        // the Shield event carries the phone-committed npk
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool seen;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(rg) && logs[i].topics[0] == keccak256("Shield(uint256,uint256,(bytes32,(uint8,address,uint256),uint120)[],(bytes32[3],bytes32)[],uint256[])")) {
                (,, RailgunTypes.CommitmentPreimage[] memory cs,, uint256[] memory fees) =
                    abi.decode(logs[i].data, (uint256, uint256, RailgunTypes.CommitmentPreimage[], RailgunTypes.ShieldCiphertext[], uint256[]));
                assertEq(cs[0].npk, sr.preimage.npk);
                assertEq(cs[0].value, 0.5985 ether);
                assertEq(fees[0], 0.0015 ether);
                seen = true;
            }
        }
        assertTrue(seen, "Shield event");
        (uint128 paid,,) = e.coins(h.coinId);
        assertEq(paid, 0.6 ether);
        // Bob's 0.4 (path through the same genesis spend) redeems to a plain address
        address bobOut = makeAddr("bobOut");
        PrawlEscrowV31.Redemption memory rb =
            _tip(e, h, 1, e.childNoteId(rd.r, rd.s, 1), bob, _outs1(0.4 ether, e.redeemKeyHash(bobOut)), 0, bobOut);
        assertTrue(e.redeem(h, _path1(_step(rd, 1, bob)), rb));
        assertEq(bobOut.balance, 0.4 ether);
        assertEq(address(e).balance, 0);
        (paid,,) = e.coins(h.coinId);
        assertEq(paid, 1 ether, "everything accounted for");
    }

    function test_shield_cannotBeRedirected() public {
        (PrawlEscrowV31.Header memory h, RailgunTypes.ShieldRequest memory sr, PrawlEscrowV31.Redemption memory rd,) =
            _scenario();
        RailgunTypes.ShieldRequest memory t;
        // another recipient (npk), another ciphertext (who can find/decrypt the note), another shield key
        t = _sr("alice-0zk", 0.6 ether);
        t.preimage.npk = bytes32(uint256(t.preimage.npk) ^ 1);
        vm.expectRevert(PrawlEscrowV31.NotRedeemOutput.selector);
        e.redeemToShield(h, _noPath(), rd, t);
        t = _sr("alice-0zk", 0.6 ether);
        t.ciphertext.encryptedBundle[1] ^= bytes32(uint256(1));
        vm.expectRevert(PrawlEscrowV31.NotRedeemOutput.selector);
        e.redeemToShield(h, _noPath(), rd, t);
        t = _sr("alice-0zk", 0.6 ether);
        t.ciphertext.shieldKey ^= bytes32(uint256(1));
        vm.expectRevert(PrawlEscrowV31.NotRedeemOutput.selector);
        e.redeemToShield(h, _noPath(), rd, t);
        // more value than the output
        t = _sr("alice-0zk", 0.7 ether);
        vm.expectRevert(PrawlEscrowV31.NotRedeemOutput.selector);
        e.redeemToShield(h, _noPath(), rd, t);
        // the output cannot be taken as a plain redemption to any address
        rd.payout = relayer;
        vm.expectRevert(PrawlEscrowV31.NotRedeemOutput.selector);
        e.redeem(h, _noPath(), rd);
        // nor as a refresh
        vm.expectRevert(PrawlEscrowV31.NotRedeemOutput.selector);
        e.refresh(h, _noPath(), rd, bytes32(0), uint64(NOW + 1 days), 1, 2);
        // the genuine request still works afterwards (nothing was recorded by the failures)
        assertTrue(e.redeemToShield(h, _noPath(), rd, sr));
        vm.expectRevert(
            abi.encodeWithSelector(
                PrawlEscrowV31.AlreadyRedeemed.selector, e.redemptionId(_msgHash(e, h, 0, e.genesisNoteId(h.coinId), rd.outputs), 0)
            )
        );
        e.redeemToShield(h, _noPath(), rd, sr);
    }

    /// A plain PRAWL-REDEEM output cannot be pushed into a shield.
    function test_plainRedeemOutput_notShieldable() public {
        (PrawlEscrowV31.Header memory h, Key memory k0) = _directCoin(e, "sh2", 1 ether, dep);
        address payout = makeAddr("payout");
        PrawlEscrowV31.Redemption memory rd =
            _tip(e, h, 0, e.genesisNoteId(h.coinId), k0, _outs1(1 ether, e.redeemKeyHash(payout)), 0, payout);
        vm.expectRevert(PrawlEscrowV31.NotRedeemOutput.selector);
        e.redeemToShield(h, _noPath(), rd, _sr("x", 1 ether));
    }

    /// The phone signed a request inconsistent with its own output (value or token): refused, not paid.
    function test_signedButInconsistentRequest_refused() public {
        (PrawlEscrowV31.Header memory h, Key memory k0) = _directCoin(e, "sh3", 1 ether, dep);
        RailgunTypes.ShieldRequest memory sr = _sr("half", 0.5 ether); // claims 0.5, output is 1.0
        PrawlEscrowV31.Redemption memory rd =
            _tip(e, h, 0, e.genesisNoteId(h.coinId), k0, _outs1(1 ether, _shieldKh(sr)), 0, address(0));
        vm.expectRevert(PrawlEscrowV31.BadShieldRequest.selector);
        e.redeemToShield(h, _noPath(), rd, sr);
        RailgunTypes.ShieldRequest memory sr2 = _sr("token", 1 ether);
        sr2.preimage.token.tokenAddress = address(0xDA1);
        rd = _tip(e, h, 0, e.genesisNoteId(h.coinId), k0, _outs1(1 ether, _shieldKh(sr2)), 0, address(0));
        vm.expectRevert(PrawlEscrowV31.BadShieldRequest.selector);
        e.redeemToShield(h, _noPath(), rd, sr2);
    }

    function test_shieldDisabledWithoutRailgun() public {
        PrawlEscrowV31 plain = _deploy31(address(0xE5C3C), address(weth), address(0), false);
        (PrawlEscrowV31.Header memory h, Key memory k0) = _directCoin(plain, "sh4", 1 ether, dep);
        RailgunTypes.ShieldRequest memory sr = _sr("x", 1 ether);
        (bytes32 kh,) = plain.shieldKeyHash(sr);
        PrawlEscrowV31.Redemption memory rd = _tip(plain, h, 0, plain.genesisNoteId(h.coinId), k0, _outs1(1 ether, kh), 0, address(0));
        vm.expectRevert(PrawlEscrowV31.ShieldDisabled.selector);
        plain.redeemToShield(h, _noPath(), rd, sr);
    }

    /// Equivocation rules are unchanged: the genesis key signs a shield and, later, a different split.
    function test_shield_equivocationFreezes() public {
        (PrawlEscrowV31.Header memory h, Key memory k0) = _directCoin(e, "sh5", 1 ether, dep);
        RailgunTypes.ShieldRequest memory sr = _sr("first", 1 ether);
        PrawlEscrowV31.Redemption memory rd =
            _tip(e, h, 0, e.genesisNoteId(h.coinId), k0, _outs1(1 ether, _shieldKh(sr)), 0, address(0));
        assertTrue(e.redeemToShield(h, _noPath(), rd, sr));
        address payout = makeAddr("payout");
        PrawlEscrowV31.Redemption memory rd2 =
            _tip(e, h, 0, e.genesisNoteId(h.coinId), k0, _outs1(1 ether, e.redeemKeyHash(payout)), 0, payout);
        assertFalse(e.redeem(h, _noPath(), rd2), "second message by k0: equivocation, nothing paid");
        (uint128 paid, bool frozen,) = e.coins(h.coinId);
        assertTrue(frozen);
        assertEq(paid, 1 ether);
        assertEq(payout.balance, 0);
    }
}
