// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {V31Base} from "./V31Base.sol";
import {PrawlEscrowV31} from "../src/PrawlEscrowV31.sol";
import {PrawlV3Codec as V3} from "../src/PrawlV3Codec.sol";

/// @notice PRAWL-REFRESH outputs: a note's value moves into a fresh coin (new expiry, new genesis key, new
///  depositor) with no payout and no new funds. The new coin's id is derived from the signed message.
contract RefreshTest is V31Base {
    address dep = makeAddr("depositor"); // Alice, who funded the old coin
    address bobDep = makeAddr("bobReclaim"); // Bob's reclaim address for the refreshed coin
    address mallory = makeAddr("mallory");

    function setUp() public {
        _setUp31(false);
    }

    struct R {
        PrawlEscrowV31.Header h; // old coin
        PrawlEscrowV31.Redemption rd; // Bob's REFRESH spend (index 0)
        PrawlEscrowV31.Spend[] path;
        Key nk; // new genesis key
        uint64 newExpiry;
        bytes32 newId;
        address payout; // where the 0.3 change of Bob's spend goes
    }

    /// Alice's 1 ETH coin: genesis -> Bob 0.7 + Alice 0.3 (REDEEM). Bob's note (depth 1) signs
    /// [0.5 REFRESH(newExpiry, newK0, bobDep), 0.2 REDEEM(bobOut)].
    function _scenario() internal returns (R memory s) {
        Key memory k0;
        (s.h, k0) = _directCoin(e, "rf", 1 ether, dep);
        Key memory bob = _key("bob-rf");
        s.payout = makeAddr("aliceOut");
        PrawlEscrowV31.Redemption memory g = _tip(
            e, s.h, 0, e.genesisNoteId(s.h.coinId), k0, _outs2(0.7 ether, bob.kh, 0.3 ether, e.redeemKeyHash(s.payout)), 1, s.payout
        );
        assertTrue(e.redeem(s.h, _noPath(), g)); // Alice redeems her 0.3 change
        s.path = _path1(_step(g, 0, bob));
        s.nk = _key("bob-new-k0");
        s.newExpiry = uint64(NOW + 50 days); // beyond the old coin's expiry (NOW + 30 days)
        bytes32 kh = e.refreshKeyHash(s.newExpiry, uint256(s.nk.x), uint256(s.nk.y), bobDep);
        address bobOut = makeAddr("bobOut");
        V3.Output[] memory outs = _outs2(0.5 ether, kh, 0.2 ether, e.redeemKeyHash(bobOut));
        s.rd = _tip(e, s.h, 1, e.childNoteId(g.r, g.s, 0), bob, outs, 0, bobDep);
        s.newId = e.refreshCoinId(_msgHash(e, s.h, 1, e.childNoteId(g.r, g.s, 0), outs), 0);
    }

    function _refresh(R memory s) internal returns (bool) {
        return e.refresh(s.h, s.path, s.rd, s.newId, s.newExpiry, uint256(s.nk.x), uint256(s.nk.y));
    }

    function test_refresh_newCoin_conservesValue() public {
        R memory s = _scenario();
        assertEq(bytes4(s.newId), bytes4("RFSH"));
        uint256 bal = address(e).balance;
        uint256 g = gasleft();
        vm.prank(mallory); // anyone may submit it: nothing in it can be changed
        assertTrue(_refresh(s));
        emit log_named_uint("refresh (depth 1, path key already recorded), gas incl. call", g - gasleft());
        assertEq(address(e).balance, bal, "no ETH moved");
        // the new coin is committed at slot 0 like any deposit (provable offline by the new holder)
        PrawlEscrowV31.Header memory nh = PrawlEscrowV31.Header(s.newId, 0.5 ether, s.newExpiry, uint256(s.nk.x), uint256(s.nk.y), bobDep);
        bytes32 c = e.commitment(nh.value, nh.expiry, nh.k0x, nh.k0y, nh.depositor);
        assertEq(e.deposits(s.newId), c);
        assertEq(vm.load(address(e), keccak256(abi.encode(s.newId, uint256(0)))), c);
        (uint128 paid,,) = e.coins(s.h.coinId);
        assertEq(paid, 0.8 ether, "old coin: 0.3 redeemed + 0.5 refreshed");
        // Bob's 0.2 sibling output is still redeemable (same signed spend, other output)
        address bobOut = makeAddr("bobOut");
        s.rd.index = 1;
        s.rd.payout = bobOut;
        assertTrue(e.redeem(s.h, s.path, s.rd));
        // the new coin spends and redeems like any other: new genesis key -> payee
        address carol = makeAddr("carol");
        PrawlEscrowV31.Redemption memory r2 =
            _tip(e, nh, 0, e.genesisNoteId(s.newId), s.nk, _outs1(0.5 ether, e.redeemKeyHash(carol)), 0, carol);
        assertTrue(e.redeem(nh, _noPath(), r2));
        assertEq(carol.balance, 0.5 ether);
        assertEq(s.payout.balance + bobOut.balance + carol.balance, 1 ether, "everything paid == the one deposit");
        assertEq(address(e).balance, 0);
        // the old coin expires with nothing left; the depositor's reclaim returns 0
        vm.warp(uint256(s.h.expiry) + GRACE);
        e.reclaim(s.h);
        assertEq(dep.balance, 0);
    }

    function test_refresh_cannotBeRedirected() public {
        R memory s = _scenario();
        uint256 x = uint256(s.nk.x);
        uint256 y = uint256(s.nk.y);
        Key memory m = _key("mallory-k0");
        // another genesis key, expiry or reclaim address: not the output the phone signed
        vm.expectRevert(PrawlEscrowV31.NotRedeemOutput.selector);
        e.refresh(s.h, s.path, s.rd, s.newId, s.newExpiry, uint256(m.x), uint256(m.y));
        vm.expectRevert(PrawlEscrowV31.NotRedeemOutput.selector);
        e.refresh(s.h, s.path, s.rd, s.newId, s.newExpiry + 1, x, y);
        s.rd.payout = mallory;
        vm.expectRevert(PrawlEscrowV31.NotRedeemOutput.selector);
        e.refresh(s.h, s.path, s.rd, s.newId, s.newExpiry, x, y);
        s.rd.payout = bobDep;
        // another coinId: it is derived from the signed message, not chosen
        vm.expectRevert(abi.encodeWithSelector(PrawlEscrowV31.BadRefreshCoinId.selector, s.newId));
        e.refresh(s.h, s.path, s.rd, keccak256("mine"), s.newExpiry, x, y);
        // nor can the REFRESH output be paid out
        s.rd.payout = mallory;
        vm.expectRevert(PrawlEscrowV31.NotRedeemOutput.selector);
        e.redeem(s.h, s.path, s.rd);
        s.rd.payout = bobDep;
        // and the new coin's id cannot be occupied in advance (front-running from the mempool)
        vm.deal(mallory, 1);
        vm.prank(mallory);
        vm.expectRevert(PrawlEscrowV31.ReservedCoinId.selector);
        e.deposit{value: 1}(s.newId, s.newExpiry, uint256(m.x), uint256(m.y));
        assertTrue(_refresh(s));
        bytes32 rid = e.redemptionId(_msgHash(e, s.h, 1, s.path[0].outputs.length > 0 ? e.childNoteId(s.path[0].r, s.path[0].s, 0) : bytes32(0), s.rd.outputs), 0);
        vm.expectRevert(abi.encodeWithSelector(PrawlEscrowV31.AlreadyRedeemed.selector, rid));
        _refresh(s);
    }

    /// A new expiry beyond now + maxLifetime is refused now but becomes valid later (the holder can wait while
    /// the old coin is still redeemable); one in the past is refused.
    function test_refresh_expiryWindow() public {
        R memory s = _scenario();
        uint64 far = uint64(NOW + MAX_LIFETIME + 1 days);
        bytes32 kh = e.refreshKeyHash(far, uint256(s.nk.x), uint256(s.nk.y), bobDep);
        Key memory bob = _key("bob-rf");
        V3.Output[] memory outs = _outs1(0.7 ether, kh);
        bytes32 noteId = e.childNoteId(s.path[0].r, s.path[0].s, 0);
        s.rd = _tip(e, s.h, 1, noteId, bob, outs, 0, bobDep);
        s.newExpiry = far;
        s.newId = e.refreshCoinId(_msgHash(e, s.h, 1, noteId, outs), 0);
        vm.expectRevert(PrawlEscrowV31.BadExpiry.selector);
        _refresh(s);
        vm.warp(NOW + 2 days);
        assertTrue(_refresh(s));
    }

    /// The holder of note (h, genesis, key k) refreshes `amount` of it into a new coin (key `seed`, expiry x);
    /// `rest` (if any) goes to a key output nobody redeems.
    function _refreshGenesis(PrawlEscrowV31.Header memory h, Key memory k, string memory seed, uint64 x, uint256 rest)
        internal
        returns (PrawlEscrowV31.Header memory nh, Key memory nk)
    {
        nk = _key(bytes(seed));
        nh = PrawlEscrowV31.Header(0, h.value - rest, x, uint256(nk.x), uint256(nk.y), bobDep);
        V3.Output[] memory o = _refreshOuts(nh, rest);
        PrawlEscrowV31.Redemption memory r = _tip(e, h, 0, e.genesisNoteId(h.coinId), k, o, 0, bobDep);
        nh.coinId = _genesisRefreshId(h, o);
        assertTrue(e.refresh(h, _noPath(), r, nh.coinId, x, nh.k0x, nh.k0y));
        assertEq(e.deposits(nh.coinId), e.commitment(nh.value, x, nh.k0x, nh.k0y, bobDep));
    }

    function _genesisRefreshId(PrawlEscrowV31.Header memory h, V3.Output[] memory o) internal view returns (bytes32) {
        bytes32 m = _msgHash(e, h, 0, e.genesisNoteId(h.coinId), o);
        return e.refreshCoinId(m, 0);
    }

    function _refreshOuts(PrawlEscrowV31.Header memory nh, uint256 rest) internal view returns (V3.Output[] memory) {
        bytes32 kh = e.refreshKeyHash(nh.expiry, nh.k0x, nh.k0y, nh.depositor);
        return rest == 0 ? _outs1(nh.value, kh) : _outs2(nh.value, kh, rest, _key("lost").kh);
    }

    /// Refresh after refresh, then the original depositor's reclaim and the new depositor's reclaim.
    function test_refresh_chain_and_reclaims() public {
        (PrawlEscrowV31.Header memory h, Key memory k0) = _directCoin(e, "chain", 1 ether, dep);
        (PrawlEscrowV31.Header memory h1, Key memory a) = _refreshGenesis(h, k0, "chain-a", uint64(NOW + 40 days), 0);
        // second refresh, at day 35, of 0.6; 0.4 stays in coin 1 unredeemed
        vm.warp(NOW + 35 days);
        _refreshGenesis(h1, a, "chain-b", uint64(NOW + 70 days), 0.4 ether);
        // coin 0 is fully refreshed; coin 1's unredeemed 0.4 goes to ITS depositor (bobDep), not to Alice
        vm.warp(uint256(h1.expiry) + GRACE);
        e.reclaim(h);
        e.reclaim(h1);
        assertEq(dep.balance, 0);
        assertEq(bobDep.balance, 0.4 ether);
        assertEq(address(e).balance, 0.6 ether, "coin 2 still holds its value");
    }

    // state of the frozen-coin scenario (storage: keeps the legacy code generator's stack small)
    PrawlEscrowV31.Header fz;
    bytes32 fzR;
    bytes32 fzS;
    V3.Output[] fzOuts;

    function _fzStep(uint256 idx, Key memory next) internal view returns (PrawlEscrowV31.Spend[] memory) {
        return _path1(PrawlEscrowV31.Spend(fzOuts, idx, fzR, fzS, next.x, next.y));
    }

    /// Ben's key signs a spend of his note whose single output is `kh`; returns the Redemption.
    function _fzTip(Key memory k, uint256 idx, bytes32 kh, uint256 v, address payout)
        internal
        view
        returns (PrawlEscrowV31.Redemption memory)
    {
        return _tip(e, fz, 1, e.childNoteId(fzR, fzS, idx), k, _outs1(v, kh), 0, payout);
    }

    function _fzRefresh(Key memory k, uint256 idx, uint256 v, bytes memory expectErr) internal returns (bool) {
        Key memory nk = _key("frz-new");
        uint64 nx = uint64(NOW + 40 days);
        PrawlEscrowV31.Redemption memory r =
            _fzTip(k, idx, e.refreshKeyHash(nx, uint256(nk.x), uint256(nk.y), bobDep), v, bobDep);
        bytes32 id = _fzId(idx, r.outputs);
        PrawlEscrowV31.Spend[] memory p = _fzStep(idx, k);
        if (expectErr.length != 0) vm.expectRevert(expectErr);
        return e.refresh(fz, p, r, id, nx, uint256(nk.x), uint256(nk.y));
    }

    function _fzId(uint256 idx, V3.Output[] memory outs) internal view returns (bytes32) {
        bytes32 m = _msgHash(e, fz, 1, e.childNoteId(fzR, fzS, idx), outs);
        return e.refreshCoinId(m, 0);
    }

    /// Subtree freeze applies to refresh exactly as to redeem: genesis -> Ann 0.6 + Ben 0.4; Ben's key signs two
    /// different spends (equivocation, coin frozen); Ann can still refresh, Ben's subtree cannot.
    function test_refresh_frozenCoin_subtreeRule() public {
        Key memory k0;
        (fz, k0) = _directCoin(e, "frz", 1 ether, dep);
        Key memory ann = _key("frz-ann");
        Key memory ben = _key("frz-ben");
        V3.Output[] memory o = _outs2(0.6 ether, ann.kh, 0.4 ether, ben.kh);
        for (uint256 i = 0; i < o.length; i++) fzOuts.push(o[i]);
        (fzR, fzS) = _signSpend(e, fz, 0, e.genesisNoteId(fz.coinId), o, k0.sk);
        address o1 = makeAddr("o1");
        address o2 = makeAddr("o2");
        assertTrue(e.redeem(fz, _fzStep(1, ben), _fzTip(ben, 1, e.redeemKeyHash(o1), 0.4 ether, o1)));
        assertFalse(e.redeem(fz, _fzStep(1, ben), _fzTip(ben, 1, e.redeemKeyHash(o2), 0.4 ether, o2)), "equivocation");
        (, bool frozen,) = e.coins(fz.coinId);
        assertTrue(frozen);
        assertTrue(_fzRefresh(ann, 0, 0.6 ether, ""), "Ann's branch avoids Ben's key: refresh still allowed");
        _fzRefresh(ben, 1, 0.4 ether, abi.encodeWithSelector(PrawlEscrowV31.KeyBroken.selector, 1, ben.kh));
    }

    /// Property: random splits of a coin into REDEEM / SHIELD / REFRESH outputs, then the refreshed coin
    /// redeemed: payouts + shielded WETH == the deposit, the escrow ends empty.
    struct F {
        PrawlEscrowV31.Header h;
        Key k0;
        Key nk;
        uint64 nx;
        address out;
        address out2;
        V3.Output[] outs;
        PrawlEscrowV31.Redemption rd;
        bytes32 g0;
        uint256 c;
    }

    function testFuzz_mixedOutputs_conservation(uint96 v, uint96 a, uint96 b) public {
        v = uint96(bound(v, 3, 1000 ether));
        a = uint96(bound(a, 1, v - 2));
        b = uint96(bound(b, 1, v - a - 1));
        F memory f;
        f.c = uint256(v) - a - b;
        (f.h, f.k0) = _directCoin(e, "fz", v, dep);
        f.nk = _key("fz-new");
        f.nx = uint64(NOW + 45 days);
        f.out = makeAddr("out");
        f.out2 = makeAddr("out2");
        f.outs = _outs3(
            a, e.redeemKeyHash(f.out), b, _shieldKhFor(b), f.c, e.refreshKeyHash(f.nx, uint256(f.nk.x), uint256(f.nk.y), bobDep)
        );
        f.g0 = e.genesisNoteId(f.h.coinId);
        f.rd = _tip(e, f.h, 0, f.g0, f.k0, f.outs, 0, f.out);
        assertTrue(e.redeem(f.h, _noPath(), f.rd));
        f.rd.index = 1;
        assertTrue(e.redeemToShield(f.h, _noPath(), f.rd, _sr("fz-0zk", b)));
        f.rd.index = 2;
        f.rd.payout = bobDep;
        bytes32 id = e.refreshCoinId(_msgHash(e, f.h, 0, f.g0, f.outs), 2);
        assertTrue(e.refresh(f.h, _noPath(), f.rd, id, f.nx, uint256(f.nk.x), uint256(f.nk.y)));
        _redeemNewCoin(f, id);
        assertEq(f.out.balance + f.out2.balance + weth.balanceOf(address(rg)) + weth.balanceOf(rg.treasury()), v);
        assertEq(address(e).balance, 0);
        assertEq(weth.balanceOf(address(e)), 0);
    }

    function _redeemNewCoin(F memory f, bytes32 id) internal {
        PrawlEscrowV31.Header memory nh = PrawlEscrowV31.Header(id, f.c, f.nx, uint256(f.nk.x), uint256(f.nk.y), bobDep);
        V3.Output[] memory o = _outs1(f.c, e.redeemKeyHash(f.out2));
        PrawlEscrowV31.Redemption memory r = _tip(e, nh, 0, e.genesisNoteId(id), f.nk, o, 0, f.out2);
        assertTrue(e.redeem(nh, _noPath(), r));
    }

    function _shieldKhFor(uint256 b) internal view returns (bytes32 kh) {
        (kh,) = e.shieldKeyHash(_sr("fz-0zk", b));
    }
}
