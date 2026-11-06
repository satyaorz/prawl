// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/DesignatedCash.sol";

contract DesignatedCashTest is Test {
    DesignatedCash dc;
    uint256 alicePk = 0xA11CE;
    address alice;
    address bob = address(0xB0B);       // designated merchant
    address carol = address(0xCA201);   // designated merchant
    address sybil = address(0x5B11);    // attacker-controlled, not designated
    address stranger = address(0x57A);  // honest, not designated

    function setUp() public {
        dc = new DesignatedCash();
        alice = vm.addr(alicePk);
        vm.deal(alice, 100 ether);
    }

    function _sign(bytes32 h) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 eh = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", h));
        (v, r, s) = vm.sign(alicePk, eh);
    }

    // ------------------------------------------------------------- tabs: prevention
    function testTabCumulativeAndNoDoubleSpend() public {
        vm.prank(alice);
        bytes32 tab = dc.openTab{value: 1 ether}(bob, bytes32("t1"));
        // offline: Alice signs cumulative 0.3 then 0.5 to Bob, and ALSO a "forked" IOU of 0.4
        (uint8 v1, bytes32 r1, bytes32 s1) = _sign(dc.tabDigest(tab, 0.3 ether));
        (uint8 v2, bytes32 r2, bytes32 s2) = _sign(dc.tabDigest(tab, 0.5 ether));
        (uint8 v3, bytes32 r3, bytes32 s3) = _sign(dc.tabDigest(tab, 0.4 ether));
        dc.redeemTab(tab, 0.3 ether, v1, r1, s1);
        assertEq(bob.balance, 0.3 ether);
        dc.redeemTab(tab, 0.5 ether, v2, r2, s2);
        assertEq(bob.balance, 0.5 ether);
        vm.expectRevert("nothing new");
        dc.redeemTab(tab, 0.4 ether, v3, r3, s3);   // the lower IOU adds nothing
        // anyone can submit, but only Bob is ever paid
        vm.prank(sybil);
        vm.expectRevert("nothing new");
        dc.redeemTab(tab, 0.5 ether, v2, r2, s2);
        assertEq(sybil.balance, 0);
    }

    function testTabCappedAndCloseDelay() public {
        vm.prank(alice);
        bytes32 tab = dc.openTab{value: 1 ether}(bob, bytes32("t2"));
        (uint8 v, bytes32 r, bytes32 s) = _sign(dc.tabDigest(tab, 5 ether));
        dc.redeemTab(tab, 5 ether, v, r, s);          // over-cap IOU pays only the cap
        assertEq(bob.balance, 1 ether);
        vm.prank(alice);
        dc.requestCloseTab(tab);
        vm.prank(alice);
        vm.expectRevert("locked");
        dc.withdrawTab(tab);
    }

    function testTabWithdrawAfterDelayOnlyUnpaid() public {
        vm.prank(alice);
        bytes32 tab = dc.openTab{value: 1 ether}(bob, bytes32("t3"));
        (uint8 v, bytes32 r, bytes32 s) = _sign(dc.tabDigest(tab, 0.2 ether));
        vm.prank(alice); dc.requestCloseTab(tab);
        dc.redeemTab(tab, 0.2 ether, v, r, s);       // merchant redeems within the delay
        vm.warp(block.timestamp + 3 days);
        uint256 before = alice.balance;
        vm.prank(alice); dc.withdrawTab(tab);
        assertEq(alice.balance - before, 0.8 ether);
        assertEq(bob.balance, 0.2 ether);
    }

    // ------------------------------------------------------------- designated cover
    function _mintAndDesignate(uint256 value) internal returns (bytes32 coin) {
        vm.startPrank(alice);
        coin = dc.mint{value: value}(bytes32("c1"), uint64(block.timestamp + 1 days));
        dc.designate{value: value}(bob);
        dc.designate{value: value}(carol);
        vm.stopPrank();
    }

    function testForkToTwoDesignatedPlusSybilAllWholeCheaterZero() public {
        uint256 val = 0.1 ether;
        uint256 a0 = alice.balance;
        bytes32 coin = _mintAndDesignate(val);
        // offline fork: Alice signs the SAME coin to Bob, Carol and her own Sybil
        (uint8 vb, bytes32 rb, bytes32 sb) = _sign(dc.spendDigest(coin, bob));
        (uint8 vc, bytes32 rc, bytes32 sc) = _sign(dc.spendDigest(coin, carol));
        (uint8 vs, bytes32 rs, bytes32 ss) = _sign(dc.spendDigest(coin, sybil));
        vm.prank(sybil); dc.redeem(coin, vs, rs, ss);               // Sybil front-runs
        vm.prank(bob); dc.claimCover(coin, vb, rb, sb);
        vm.prank(carol); dc.claimCover(coin, vc, rc, sc);
        assertEq(bob.balance, val);
        assertEq(carol.balance, val);
        // Sybil cannot ALSO claim a cover slot (not designated)
        vm.prank(sybil);
        vm.expectRevert("no fork");    // sybil is the redeemer
        dc.claimCover(coin, vs, rs, ss);
        // Cheater accounting: alice + sybil money position vs start (goods from bob & carol = 2*val)
        int256 attackerMoney = int256(alice.balance + sybil.balance) - int256(a0);
        // locked: 3*val; recovered: val (sybil) ; remaining cover slots = 0 -> money delta = -2*val
        assertEq(attackerMoney, -int256(2 * val));
        // => with goods 2*val received, attacker net = 0: the fork is just "paying from the cover slot"
    }

    function testStrangerNotCoveredAndSybilCannotDrain() public {
        uint256 val = 0.1 ether;
        bytes32 coin = _mintAndDesignate(val);
        (uint8 vb, bytes32 rb, bytes32 sb) = _sign(dc.spendDigest(coin, bob));
        (uint8 vt, bytes32 rt, bytes32 st) = _sign(dc.spendDigest(coin, stranger));
        (uint8 vs2, bytes32 rs2, bytes32 ss2) = _sign(dc.spendDigest(coin, address(0x5B12)));
        vm.prank(bob); dc.redeem(coin, vb, rb, sb);                  // honest first redeemer
        vm.prank(stranger);
        vm.expectRevert("not designated");
        dc.claimCover(coin, vt, rt, st);
        vm.prank(address(0x5B12));
        vm.expectRevert("not designated");
        dc.claimCover(coin, vs2, rs2, ss2);
        assertEq(dc.cover(alice, carol), val);                      // Carol's slot untouched
    }

    function testCoverLockedUntilClaimsClose() public {
        bytes32 coin = _mintAndDesignate(0.1 ether);
        coin;
        vm.prank(alice);
        vm.expectRevert("cover locked");
        dc.withdrawCover(bob);
        vm.warp(block.timestamp + 3 days + 1);
        vm.prank(alice);
        dc.withdrawCover(bob);
    }

    /// Fuzz: Alice forks one coin to k designated recipients (each slot >= value) and a Sybil
    /// that redeems first. Every designated recipient must be made whole.
    function testFuzzForkK(uint8 kRaw, uint96 valRaw) public {
        uint256 k = bound(kRaw, 1, 12);
        uint256 val = bound(valRaw, 1e12, 1 ether);
        vm.startPrank(alice);
        bytes32 coin = dc.mint{value: val}(bytes32("fz"), uint64(block.timestamp + 1 days));
        for (uint256 i = 0; i < k; i++) dc.designate{value: val}(address(uint160(0x1000 + i)));
        vm.stopPrank();
        (uint8 vs, bytes32 rs, bytes32 ss) = _sign(dc.spendDigest(coin, sybil));
        vm.prank(sybil); dc.redeem(coin, vs, rs, ss);
        for (uint256 i = 0; i < k; i++) {
            address rcp = address(uint160(0x1000 + i));
            (uint8 v, bytes32 r, bytes32 s) = _sign(dc.spendDigest(coin, rcp));
            vm.prank(rcp); dc.claimCover(coin, v, r, s);
            assertEq(rcp.balance, val);
        }
    }
}
