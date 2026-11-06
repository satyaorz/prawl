// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {V3Base} from "./V3Base.sol";
import {PrawlEscrowV3} from "../src/PrawlEscrowV3.sol";
import {PrawlV3Codec as V3} from "../src/PrawlV3Codec.sol";

/// @notice The SYNTHETIC split tree (tools/gen_vectors.py, software keys):
///   Alice 1.0 -> Bob 0.2 + Alice change 0.8
///   Bob 0.2   -> Charlie 0.1 + Bob change 0.1                  Charlie, Bob: REDEEM (depth 2)
///   Alice 0.8 -> Dave 0.5 + Alice change 0.3                    Alice: REDEEM (depth 2)
///   Dave 0.5  -> Erin 0.2 + Frank 0.1 + Gina 0.1 + Dave 0.1     Erin, Frank, Dave: REDEEM (depth 3)
///   Gina 0.1  -> REDEEM 0.05 + Gina change 0.05                 partial redemption (depth 3)
///   Gina 0.05 -> REDEEM 0.03 + REDEEM 0.02 (gina_savings)       two REDEEM outputs in one spend (depth 4)
contract SplitTreeTest is V3Base {
    address constant ESCROW = address(0xE5C70);
    address constant ESCROW_B = address(0xE5C71);
    PrawlEscrowV3 e;
    PrawlEscrowV3.Header h;

    string[9] LEAVES = [
        "tree_charlie",
        "tree_bob",
        "tree_alice",
        "tree_erin",
        "tree_frank",
        "tree_dave",
        "tree_gina",
        "tree_gina2a",
        "tree_gina2b"
    ];

    function setUp() public {
        vm.warp(NOW);
        _loadFixture("fixtures/v3_synthetic.json");
        e = _deployAt(ESCROW, GRACE, MAX_LIFETIME);
        h = _depositCoin(e, "tree");
    }

    // ------------------------------------------------------------------ every path

    function test_tree_everyLeafRedeems_totalEqualsDeposit() public {
        uint256 sum;
        for (uint256 i = 0; i < LEAVES.length; i++) {
            (PrawlEscrowV3.Header memory hh, PrawlEscrowV3.Spend[] memory p, PrawlEscrowV3.Redemption memory rd) =
                _load(LEAVES[i]);
            uint256 before = rd.payout.balance;
            uint256 amt = _amount(LEAVES[i]);
            vm.expectEmit(true, true, true, false, address(e));
            emit PrawlEscrowV3.Redeemed(hh.coinId, rd.payout, vm.parseJsonBytes32(fx, string.concat(".redeems.", LEAVES[i], ".redeem.noteId")), rd.index, amt, 0, 0);
            assertTrue(e.redeem(hh, p, rd), LEAVES[i]);
            assertEq(rd.payout.balance - before, amt, LEAVES[i]);
            sum += amt;
        }
        assertEq(sum, 1 ether, "the tree's REDEEM outputs sum to the deposit");
        (uint128 paid, bool frozen,) = e.coins(h.coinId);
        assertEq(paid, 1 ether);
        assertFalse(frozen);
        assertEq(address(e).balance, 0, "escrow empty");
        // gina received 0.05 + 0.03 to the same payout address
        assertEq(vm.parseJsonAddress(fx, ".redeems.tree_gina.payout").balance, 0.08 ether);
    }

    // ------------------------------------------------------------------ cap and double redeem

    function test_doubleRedeem_sameOutput_reverts() public {
        assertTrue(_redeem(e, "tree_charlie"));
        (PrawlEscrowV3.Header memory hh, PrawlEscrowV3.Spend[] memory p, PrawlEscrowV3.Redemption memory rd) =
            _load("tree_charlie");
        vm.expectPartialRevert(PrawlEscrowV3.AlreadyRedeemed.selector);
        e.redeem(hh, p, rd);
    }

    /// (r, n - s) is a second valid signature of the SAME redeem message: it must not pay twice. (This is
    /// why redemptions are keyed by (sha256(message), index) and not by the malleable child note id.)
    function test_doubleRedeem_malleatedTipSignature_reverts() public {
        assertTrue(_redeem(e, "tree_charlie"));
        (PrawlEscrowV3.Header memory hh, PrawlEscrowV3.Spend[] memory p, PrawlEscrowV3.Redemption memory rd) =
            _load("tree_charlie");
        rd.s = bytes32(P256_N - uint256(rd.s));
        vm.expectPartialRevert(PrawlEscrowV3.AlreadyRedeemed.selector);
        e.redeem(hh, p, rd);
    }

    /// Malleating an intermediate signature changes the child note id, so the child's signature fails.
    function test_malleatedPathSignature_breaksChild() public {
        (PrawlEscrowV3.Header memory hh, PrawlEscrowV3.Spend[] memory p, PrawlEscrowV3.Redemption memory rd) =
            _load("tree_charlie");
        p[0].s = bytes32(P256_N - uint256(p[0].s));
        vm.expectRevert(abi.encodeWithSelector(PrawlEscrowV3.BadSig.selector, 1));
        e.redeem(hh, p, rd);
    }

    /// The explicit counter: with `paid` pushed (by storage write) to within 0.05 ETH of the deposit, a valid
    /// 0.1 ETH redemption is refused. In normal operation the counter cannot be reached (see RESULTS.md:
    /// payouts are leaves of the first-seen, value-conserving spend tree); this test exercises the guard itself.
    function test_totalCap_counterEnforced() public {
        bytes32 slot = keccak256(abi.encode(h.coinId, uint256(1)));
        vm.store(address(e), slot, bytes32(uint256(0.95 ether)));
        (PrawlEscrowV3.Header memory hh, PrawlEscrowV3.Spend[] memory p, PrawlEscrowV3.Redemption memory rd) =
            _load("tree_charlie");
        vm.expectRevert(abi.encodeWithSelector(PrawlEscrowV3.CapExceeded.selector, 0.95 ether, 0.1 ether, 1 ether));
        e.redeem(hh, p, rd);
        // a 0.05 output still fits exactly
        assertTrue(_redeem(e, "tree_gina"));
        (uint128 paid,,) = e.coins(h.coinId);
        assertEq(paid, 1 ether);
    }

    /// After the whole tree is paid, the counter equals the deposit and nothing else can be paid.
    function test_totalCap_tightAfterFullRedemption() public {
        for (uint256 i = 0; i < LEAVES.length; i++) assertTrue(_redeem(e, LEAVES[i]));
        for (uint256 i = 0; i < LEAVES.length; i++) {
            (PrawlEscrowV3.Header memory hh, PrawlEscrowV3.Spend[] memory p, PrawlEscrowV3.Redemption memory rd) =
                _load(LEAVES[i]);
            vm.expectPartialRevert(PrawlEscrowV3.AlreadyRedeemed.selector);
            e.redeem(hh, p, rd);
        }
    }

    // ------------------------------------------------------------------ conservation (validly signed bad spends)

    function test_conservation_violations() public {
        PrawlEscrowV3.Header memory hb = _depositCoin(e, "bad");
        // genesis spend outputs 0.15 + 0.1 of a 0.2 note (sum >)
        _expectRedeemRevert("bad_over", abi.encodeWithSelector(PrawlEscrowV3.ConservationViolated.selector, 0, 0.25 ether, 0.2 ether));
        // 0.1 + 0.05 of 0.2 (sum <)
        _expectRedeemRevert("bad_under", abi.encodeWithSelector(PrawlEscrowV3.ConservationViolated.selector, 0, 0.15 ether, 0.2 ether));
        // 0.2 + 0
        _expectRedeemRevert("bad_zero", abi.encodeWithSelector(PrawlEscrowV3.ZeroOutput.selector, 0));
        // REDEEM spend claims 0.15 from a 0.1 note / 0.05 from a 0.1 note
        _expectRedeemRevert("bad_tipOver", abi.encodeWithSelector(PrawlEscrowV3.ConservationViolated.selector, 1, 0.15 ether, 0.1 ether));
        _expectRedeemRevert("bad_tipUnder", abi.encodeWithSelector(PrawlEscrowV3.ConservationViolated.selector, 1, 0.05 ether, 0.1 ether));
        // nothing was recorded by the failures: the valid redemption in the same coin pays
        assertTrue(_redeem(e, "bad_valid"));
        (uint128 paid, bool frozen,) = e.coins(hb.coinId);
        assertEq(paid, 0.1 ether);
        assertFalse(frozen);
    }

    /// Outputs whose sum overflows uint256 are a conservation failure (checked before any signature).
    function test_conservation_overflow() public {
        (PrawlEscrowV3.Header memory hh, PrawlEscrowV3.Spend[] memory p, PrawlEscrowV3.Redemption memory rd) =
            _load("tree_charlie");
        V3.Output[] memory o = new V3.Output[](2);
        o[0] = V3.Output(type(uint256).max, p[0].outputs[0].keyHash);
        o[1] = V3.Output(2, p[0].outputs[1].keyHash);
        p[0].outputs = o;
        vm.expectRevert(abi.encodeWithSelector(PrawlEscrowV3.ConservationViolated.selector, 0, type(uint256).max, 1 ether));
        e.redeem(hh, p, rd);
    }

    /// Editing a value in an honestly signed spend (Bob gives himself 0.9 instead of 0.2; phone run S6) keeps
    /// the sum but changes the outputs hash: the genesis signature fails.
    function test_tamperedValues_badSig() public {
        (PrawlEscrowV3.Header memory hh, PrawlEscrowV3.Spend[] memory p, PrawlEscrowV3.Redemption memory rd) =
            _load("tree_charlie");
        p[0].outputs[0].value = 0.9 ether;
        p[0].outputs[1].value = 0.1 ether;
        vm.expectRevert(abi.encodeWithSelector(PrawlEscrowV3.BadSig.selector, 0));
        e.redeem(hh, p, rd);
    }

    // ------------------------------------------------------------------ binding: payout, escrow, chain, coin

    function test_wrongPayout_reverts() public {
        (PrawlEscrowV3.Header memory hh, PrawlEscrowV3.Spend[] memory p, PrawlEscrowV3.Redemption memory rd) =
            _load("tree_charlie");
        rd.payout = makeAddr("thief");
        vm.expectRevert(PrawlEscrowV3.NotRedeemOutput.selector);
        e.redeem(hh, p, rd);
        rd.payout = address(0);
        vm.expectRevert(PrawlEscrowV3.ZeroPayout.selector);
        e.redeem(hh, p, rd);
    }

    function test_wrongEscrow_reverts() public {
        PrawlEscrowV3 b = _deployAt(ESCROW_B, GRACE, MAX_LIFETIME);
        _deposit(b, h); // the same coin header deposited at a second escrow
        // a redemption signed for escrow A names escrow A in its REDEEM output
        _expectRedeemRevertAt(b, "tree_charlie", abi.encodeWithSelector(PrawlEscrowV3.NotRedeemOutput.selector));
        // a REDEEM output naming escrow B, on a path signed for escrow A: the path signatures fail at B ...
        _expectRedeemRevertAt(b, "tree_charlie_targetEscrowB", abi.encodeWithSelector(PrawlEscrowV3.BadSig.selector, 0));
        // ... and at A the REDEEM output is not A's
        _expectRedeemRevert("tree_charlie_targetEscrowB", abi.encodeWithSelector(PrawlEscrowV3.NotRedeemOutput.selector));
    }

    function test_wrongChainId_reverts() public {
        _expectRedeemRevert("tree_charlie_targetChain1", abi.encodeWithSelector(PrawlEscrowV3.NotRedeemOutput.selector));
        vm.chainId(1);
        _expectRedeemRevert("tree_charlie", abi.encodeWithSelector(PrawlEscrowV3.NotRedeemOutput.selector));
        // REDEEM output names chain 1, but every message on the path was signed with chainId 31337
        _expectRedeemRevert("tree_charlie_targetChain1", abi.encodeWithSelector(PrawlEscrowV3.BadSig.selector, 0));
        vm.chainId(31337);
        assertTrue(_redeem(e, "tree_charlie"));
    }

    function test_wrongCoin_or_header_reverts() public {
        (PrawlEscrowV3.Header memory hh, PrawlEscrowV3.Spend[] memory p, PrawlEscrowV3.Redemption memory rd) =
            _load("tree_charlie");
        PrawlEscrowV3.Header memory t = _copy(hh);
        t.value = 2 ether; // claim a bigger deposit
        vm.expectRevert(PrawlEscrowV3.BadHeader.selector);
        e.redeem(t, p, rd);
        t = _copy(hh);
        t.depositor = makeAddr("mallory");
        vm.expectRevert(PrawlEscrowV3.BadHeader.selector);
        e.redeem(t, p, rd);
        t = _copy(hh);
        t.coinId = bytes32(uint256(hh.coinId) ^ 1); // undeposited coin
        vm.expectRevert(PrawlEscrowV3.BadHeader.selector);
        e.redeem(t, p, rd);
        // a real deposit with the same value, expiry, k0 and depositor but another coinId: every message
        // commits to the coinId, so the tree's signatures do not carry over
        t = _copy(hh);
        t.coinId = keccak256("another coin, same k0");
        _deposit(e, t);
        vm.expectRevert(abi.encodeWithSelector(PrawlEscrowV3.BadSig.selector, 0));
        e.redeem(t, p, rd);
    }

    // ------------------------------------------------------------------ tip auth

    /// Bob paid Charlie, so Bob has Charlie's whole path; signing the REDEEM with his own key does not work.
    function test_noTipAuth_payerSignsRecipientsRedeem() public {
        _expectRedeemRevert("tree_bobSignsCharliesRedeem", abi.encodeWithSelector(PrawlEscrowV3.BadSig.selector, 2));
    }

    /// A path without any REDEEM spend: the last spend's chosen output is a key output, not PRAWL-REDEEM.
    function test_noTipAuth_pathOnly() public {
        (PrawlEscrowV3.Header memory hh, PrawlEscrowV3.Spend[] memory p,) = _load("tree_charlie");
        PrawlEscrowV3.Spend[] memory prefix = new PrawlEscrowV3.Spend[](1);
        prefix[0] = p[0];
        PrawlEscrowV3.Redemption memory rd = PrawlEscrowV3.Redemption(p[1].outputs, 0, makeAddr("bob"), p[1].r, p[1].s);
        vm.expectRevert(PrawlEscrowV3.NotRedeemOutput.selector);
        e.redeem(hh, prefix, rd);
        // even naming the output's key hash as if it were an address-derived target does not help
        rd.index = 7;
        vm.expectRevert(abi.encodeWithSelector(PrawlEscrowV3.BadIndex.selector, 1));
        e.redeem(hh, prefix, rd);
    }

    /// The tip signed depth 1 where it holds a depth-2 note.
    function test_wrongDepth_badSig() public {
        _expectRedeemRevert("tree_charlie_wrongDepth", abi.encodeWithSelector(PrawlEscrowV3.BadSig.selector, 2));
    }

    /// A path whose taken output does not pay the key presented as the next signer.
    function test_outputKeyMismatch() public {
        (PrawlEscrowV3.Header memory hh, PrawlEscrowV3.Spend[] memory p, PrawlEscrowV3.Redemption memory rd) =
            _load("tree_charlie");
        p[0].index = 1; // Alice's change output, but Bob's key is presented
        vm.expectRevert(abi.encodeWithSelector(PrawlEscrowV3.OutputKeyMismatch.selector, 0));
        e.redeem(hh, p, rd);
    }

    // ------------------------------------------------------------------ expiry and reclaim

    function test_expiry_redeemInGrace_thenReclaim() public {
        assertTrue(_redeem(e, "tree_charlie"));
        assertTrue(_redeem(e, "tree_erin"));
        // after expiry, inside the grace period: still redeemable
        vm.warp(uint256(h.expiry) + GRACE - 1);
        assertTrue(_redeem(e, "tree_bob"));
        vm.expectRevert(PrawlEscrowV3.TooEarly.selector);
        e.reclaim(h);
        // at expiry + grace: redemption is closed, the depositor reclaims the rest (anyone may trigger)
        vm.warp(uint256(h.expiry) + GRACE);
        (PrawlEscrowV3.Header memory hh, PrawlEscrowV3.Spend[] memory p, PrawlEscrowV3.Redemption memory rd) =
            _load("tree_alice");
        vm.expectRevert(PrawlEscrowV3.RedeemWindowClosed.selector);
        e.redeem(hh, p, rd);
        uint256 before = h.depositor.balance;
        vm.expectEmit(true, true, false, true, address(e));
        emit PrawlEscrowV3.Reclaimed(h.coinId, h.depositor, 0.6 ether);
        vm.prank(makeAddr("anyone"));
        e.reclaim(h);
        assertEq(h.depositor.balance - before, 0.6 ether);
        (, , bool closed) = e.coins(h.coinId);
        assertTrue(closed);
        vm.expectRevert(PrawlEscrowV3.AlreadyClosed.selector);
        e.reclaim(h);
        assertEq(address(e).balance, 0);
    }

    function test_deposit_validation() public {
        address d = h.depositor;
        vm.deal(d, 10 ether);
        vm.startPrank(d);
        vm.expectRevert(PrawlEscrowV3.CoinExists.selector);
        e.deposit{value: 1 ether}(h.coinId, h.expiry, h.k0x, h.k0y);
        vm.expectRevert(PrawlEscrowV3.BadValue.selector);
        e.deposit{value: 0}(bytes32("x"), h.expiry, h.k0x, h.k0y);
        vm.expectRevert(PrawlEscrowV3.BadExpiry.selector);
        e.deposit{value: 1}(bytes32("x"), uint64(NOW), h.k0x, h.k0y);
        vm.expectRevert(PrawlEscrowV3.BadExpiry.selector);
        e.deposit{value: 1}(bytes32("x"), uint64(NOW + MAX_LIFETIME + 1), h.k0x, h.k0y);
        // the same k0 on another coin is allowed (no front-running grief); spending both would be equivocation
        vm.expectEmit(true, true, false, false, address(e));
        emit PrawlEscrowV3.Deposited(bytes32("x"), d, 1, 0, 0, 0, 0, 0);
        e.deposit{value: 1}(bytes32("x"), uint64(NOW + MAX_LIFETIME), h.k0x, h.k0y);
        vm.stopPrank();
    }

    /// A payout contract that rejects ETH does not lose the redemption: it becomes `owed`.
    function test_rejectingPayout_owed() public {
        (PrawlEscrowV3.Header memory hh, PrawlEscrowV3.Spend[] memory p, PrawlEscrowV3.Redemption memory rd) =
            _load("tree_charlie");
        vm.etch(rd.payout, hex"5f5ffd"); // PUSH0 PUSH0 REVERT
        assertTrue(e.redeem(hh, p, rd));
        assertEq(e.owed(rd.payout), 0.1 ether);
        vm.etch(rd.payout, hex"00"); // now accepts
        vm.prank(rd.payout);
        e.withdrawOwed();
        assertEq(rd.payout.balance, 0.1 ether);
    }

    // ------------------------------------------------------------------ helpers

    function _copy(PrawlEscrowV3.Header memory a) internal pure returns (PrawlEscrowV3.Header memory) {
        return PrawlEscrowV3.Header(a.coinId, a.value, a.expiry, a.k0x, a.k0y, a.depositor);
    }

    function _expectRedeemRevert(string memory name, bytes memory err) internal {
        _expectRedeemRevertAt(e, name, err);
    }

    function _expectRedeemRevertAt(PrawlEscrowV3 at, string memory name, bytes memory err) internal {
        (PrawlEscrowV3.Header memory hh, PrawlEscrowV3.Spend[] memory p, PrawlEscrowV3.Redemption memory rd) = _load(name);
        vm.expectRevert(err);
        at.redeem(hh, p, rd);
    }
}

/// @notice Order independence of the split tree, as a fuzz test over permutations (separate contract so the
///  encoded calls are built once in setUp; fuzz runs start from the post-setUp state).
contract SplitTreeOrderTest is V3Base {
    PrawlEscrowV3 e;
    PrawlEscrowV3.Header h;
    bytes[9] calls;
    string[9] LEAVES = ["tree_charlie", "tree_bob", "tree_alice", "tree_erin", "tree_frank", "tree_dave", "tree_gina",
        "tree_gina2a", "tree_gina2b"];

    function setUp() public {
        vm.warp(NOW);
        _loadFixture("fixtures/v3_synthetic.json");
        e = _deployAt(address(0xE5C70), GRACE, MAX_LIFETIME);
        h = _depositCoin(e, "tree");
        for (uint256 i = 0; i < 9; i++) {
            (PrawlEscrowV3.Header memory hh, PrawlEscrowV3.Spend[] memory p, PrawlEscrowV3.Redemption memory rd) =
                _load(LEAVES[i]);
            calls[i] = abi.encodeCall(PrawlEscrowV3.redeem, (hh, p, rd));
        }
    }

    /// Order independence: any permutation of the leaves redeems completely.
    /// (Calls are ABI-encoded once and cached: re-parsing the fixture JSON in every fuzz run is too slow.)
    /// forge-config: default.fuzz.runs = 128
    function testFuzz_tree_anyOrder(uint256 seed) public {
        uint256[9] memory ord = [uint256(0), 1, 2, 3, 4, 5, 6, 7, 8];
        for (uint256 i = 8; i > 0; i--) {
            uint256 j = uint256(keccak256(abi.encode(seed, i))) % (i + 1);
            (ord[i], ord[j]) = (ord[j], ord[i]);
        }
        for (uint256 i = 0; i < 9; i++) {
            (bool ok, bytes memory ret) = address(e).call(calls[ord[i]]);
            assertTrue(ok && abi.decode(ret, (bool)), LEAVES[ord[i]]);
        }
        (uint128 paid,,) = e.coins(h.coinId);
        assertEq(paid, 1 ether);
        assertEq(address(e).balance, 0);
    }

}
