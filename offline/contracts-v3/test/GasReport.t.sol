// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SoftKeys} from "./SoftKeys.sol";
import {PrawlEscrowV3} from "../src/PrawlEscrowV3.sol";
import {PrawlV3Codec as V3} from "../src/PrawlV3Codec.sol";

/// @notice Feeds `forge test --gas-report`: forge attributes calls only to contracts deployed with `new`, not
///  to code placed with deployCodeTo (which the fixture-based suites need, since the Python vectors are
///  signed for 0x...0E5C70). Here the escrow is created with `new` and the depth x fan-out chains are signed
///  in Solidity for its address (vm.signP256): deposit, redeem at D = 0..3 / F = 2,4 (cold and warm sibling),
///  proveEquivocation, reclaim.
contract GasReportTest is SoftKeys {
    PrawlEscrowV3 e;

    function setUp() public {
        vm.warp(NOW);
        e = new PrawlEscrowV3(GRACE, MAX_LIFETIME, SINK, false);
    }

    function test_gasReport_redeemMatrix() public {
        for (uint256 d = 0; d <= 3; d++) {
            for (uint256 f = 2; f <= 4; f += 2) {
                if (d == 0 && f == 4) continue;
                _chainAndRedeem(d, f);
            }
        }
    }

    function test_gasReport_equivocationAndReclaim() public {
        Key memory k = _key("gr-eq-k0");
        PrawlEscrowV3.Header memory h = _coin("gr-eq", k);
        address p1 = makeAddr("gr-p1");
        address p2 = makeAddr("gr-p2");
        PrawlEscrowV3.Signed memory a = _signedRedeem(h, k, p1);
        PrawlEscrowV3.Signed memory b = _signedRedeem(h, k, p2);
        e.proveEquivocation(h, new PrawlEscrowV3.Spend[](0), a, b);
        vm.warp(uint256(h.expiry) + GRACE);
        e.reclaim(h);
        assertEq(SINK.balance, h.value);
    }

    // ------------------------------------------------------------------ helpers

    function _coin(bytes memory salt, Key memory k) internal returns (PrawlEscrowV3.Header memory h) {
        h.coinId = keccak256(salt);
        h.value = 1 ether;
        h.expiry = uint64(NOW + 30 days);
        h.k0x = uint256(k.x);
        h.k0y = uint256(k.y);
        h.depositor = address(0xA11CE);
        _deposit(e, h);
    }

    function _signedRedeem(PrawlEscrowV3.Header memory h, Key memory k, address payout)
        internal
        view
        returns (PrawlEscrowV3.Signed memory sg)
    {
        V3.Output[] memory o = _outs1(h.value, e.redeemKeyHash(payout));
        bytes32 d;
        (sg.message, d) = e.spendMessage(h, 0, e.genesisNoteId(h.coinId), o);
        (sg.r, sg.s) = vm.signP256(k.sk, d);
    }

    struct Cur {
        PrawlEscrowV3.Header h;
        bytes salt;
        Key k;
        Key sib;
        bytes32 noteId;
        uint256 value;
    }

    function _chainAndRedeem(uint256 depth, uint256 fan) internal {
        Cur memory c;
        c.salt = abi.encode("gr", depth, fan);
        c.k = _key(abi.encode(c.salt, "k0"));
        c.h = _coin(c.salt, c.k);
        c.noteId = e.genesisNoteId(c.h.coinId);
        c.value = c.h.value;
        PrawlEscrowV3.Spend[] memory p = new PrawlEscrowV3.Spend[](depth);
        for (uint256 lvl = 0; lvl < depth; lvl++) p[lvl] = _level(c, lvl, fan);
        assertTrue(e.redeem(c.h, p, _rd(c.h, depth, c, makeAddr(string(abi.encode(c.salt, "payout"))))));
        if (depth == 0) return;
        // warm sibling: output 1 of the last spend; every key on the path is already recorded
        PrawlEscrowV3.Spend memory ls = p[depth - 1];
        ls.index = 1;
        ls.nextX = c.sib.x;
        ls.nextY = c.sib.y;
        c.noteId = e.childNoteId(ls.r, ls.s, 1);
        c.value = ls.outputs[1].value;
        c.k = c.sib;
        assertTrue(e.redeem(c.h, p, _rd(c.h, depth, c, makeAddr(string(abi.encode(c.salt, "sib"))))));
    }

    /// One spend of fan-out `fan` by the current note; the walk continues on output 0.
    function _level(Cur memory c, uint256 lvl, uint256 fan) internal view returns (PrawlEscrowV3.Spend memory sp) {
        Key[] memory ks = new Key[](fan);
        sp.outputs = new V3.Output[](fan);
        uint256 part = c.value / (2 * fan);
        for (uint256 j = 0; j < fan; j++) {
            ks[j] = _key(abi.encode(c.salt, lvl, j));
            sp.outputs[j] = V3.Output(j == 0 ? c.value - part * (fan - 1) : part, ks[j].kh);
        }
        (sp.r, sp.s) = _signSpend(e, c.h, lvl, c.noteId, sp.outputs, c.k.sk);
        sp.nextX = ks[0].x;
        sp.nextY = ks[0].y;
        c.noteId = e.childNoteId(sp.r, sp.s, 0);
        c.value = sp.outputs[0].value;
        c.k = ks[0];
        c.sib = ks[1];
    }

    function _rd(PrawlEscrowV3.Header memory h, uint256 depth, Cur memory c, address payout)
        internal
        view
        returns (PrawlEscrowV3.Redemption memory rd)
    {
        rd.outputs = _outs1(c.value, e.redeemKeyHash(payout));
        rd.payout = payout;
        (rd.r, rd.s) = _signSpend(e, h, depth, c.noteId, rd.outputs, c.k.sk);
    }
}
