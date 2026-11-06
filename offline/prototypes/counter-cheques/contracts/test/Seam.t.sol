// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {SlackPayoutPool} from "../src/SlackPayoutPool.sol";
import {CounterChequeBook} from "../src/CounterChequeBook.sol";

contract PoolTest is Test {
    SlackPayoutPool pool;
    address constant HON1 = address(0x1001);
    address constant HON2 = address(0x1002);
    address constant SYB = address(0x5001);

    function setUp() public {
        pool = new SlackPayoutPool(address(this), 1 days);
    }

    function _settle(uint256 id, address who) internal returns (uint256 got) {
        uint256 b = who.balance;
        if (pool.claimOf(id, who) == 0) return 0;
        vm.prank(who);
        pool.withdraw(id);
        got = who.balance - b;
    }

    function testUnderBudgetPaysFull() public {
        pool.open{value: 4 ether}(1, 2500, 5000); // D = 3, Hbar = 1.5
        pool.register(1, HON1, 1 ether);
        pool.register(1, SYB, 2 ether);
        vm.warp(block.timestamp + 1 days);
        assertEq(_settle(1, HON1), 1 ether);
        assertEq(_settle(1, SYB), 2 ether);
    }

    function testFullOrBurnIsSpecialCase() public {
        pool.open{value: 4 ether}(2, 2500, 10000); // Hbar = D => FoB
        pool.register(2, HON1, 1 ether);
        pool.register(2, SYB, 2 ether + 1);
        vm.warp(block.timestamp + 1 days);
        assertEq(_settle(2, HON1), 0);
        assertEq(_settle(2, SYB), 0);
    }

    /// T1 in wei: honest load H <= Hbar  =>  any over-budget Sybil load S recovers strictly less than D - H
    /// (what it would get by filling the budget), and total payout <= D.
    function testFuzz_RationalSafety(uint96 F, uint16 burnBps, uint16 hbarBps, uint96 hRaw, uint96 sRaw) public {
        F = uint96(bound(F, 1e9, 1e24));
        burnBps = uint16(bound(burnBps, 0, 9000));
        hbarBps = uint16(bound(hbarBps, 0, 10000));
        pool.open{value: F}(7, burnBps, hbarBps);
        (uint128 D, uint128 Hbar,,,,) = pool.evs(7);
        uint256 H = bound(hRaw, 1, Hbar == 0 ? 1 : Hbar);
        if (H > Hbar) return; // Hbar == 0 case: no honest guarantee claimed
        uint256 S = bound(sRaw, 1, uint256(D) * 50 + 1);
        pool.register(7, HON1, H / 2 + 1 > H ? H : H / 2 + 1);
        if (H - (H / 2 + 1 > H ? H : H / 2 + 1) > 0) pool.register(7, HON2, H - (H / 2 + 1 > H ? H : H / 2 + 1));
        pool.register(7, SYB, S);
        vm.warp(block.timestamp + 1 days);
        uint256 hp = _settle(7, HON1) + _settle(7, HON2);
        uint256 sp = _settle(7, SYB);
        assertLe(hp + sp, D, "solvency");
        if (H + S <= D) {
            assertEq(hp, H, "full under budget");
        } else {
            assertLt(sp, uint256(D) - H, "over-budget sybil take strictly below fill-to-budget take");
        }
    }

    /// T3 spite bound: honest per-wei payout >= (1 - Hbar/D) * pro-rata  (up to rounding)
    function testFuzz_SpiteBound(uint96 F, uint16 hbarBps, uint96 hRaw, uint96 sRaw) public {
        F = uint96(bound(F, 1e12, 1e24));
        hbarBps = uint16(bound(hbarBps, 1000, 9000));
        pool.open{value: F}(9, 2500, hbarBps);
        (uint128 D, uint128 Hbar,,,,) = pool.evs(9);
        uint256 H = bound(hRaw, 1e6, Hbar);
        uint256 S = bound(sRaw, 1, uint256(D) * 1000);
        pool.register(9, HON1, H);
        pool.register(9, SYB, S);
        vm.warp(block.timestamp + 1 days);
        uint256 hp = _settle(9, HON1);
        uint256 N = H + S;
        uint256 proRata = N <= D ? H : (H * uint256(D)) / N;
        // hp >= proRata * (D - Hbar) / D - 2
        assertGe(hp + 2, (proRata * (uint256(D) - Hbar)) / D, "spite bound");
    }

    function testGas_100Claimants() public {
        pool.open{value: 10 ether}(11, 2500, 5000);
        for (uint256 i = 0; i < 100; i++) pool.register(11, address(uint160(0x9000 + i)), 0.1 ether);
        vm.warp(block.timestamp + 1 days);
        for (uint256 i = 0; i < 100; i++) {
            vm.prank(address(uint160(0x9000 + i)));
            pool.withdraw(11);
        }
        pool.burnExcess(11);
    }
}

contract ChequeTest is Test {
    CounterChequeBook book;
    uint256 constant PK = 0xA11CE;
    address key;
    address alice = address(0xA);

    function setUp() public {
        book = new CounterChequeBook(1 days);
        key = vm.addr(PK);
        vm.deal(alice, 10 ether);
        vm.prank(alice);
        book.register{value: 2 ether}(key, 1, 20, 0.1 ether, uint64(block.timestamp + 1 days));
    }

    function _cheque(uint32 j, uint256 value, address payee) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        (v, r, s) = vm.sign(PK, book.digest(alice, 1, j, value, payee));
    }

    function testRegisterRequiresBalanceCoversBudget() public {
        address bob = address(0xB);
        vm.deal(bob, 1 ether);
        vm.prank(bob);
        vm.expectRevert(bytes("W < L*vmax"));
        book.register{value: 1 ether}(key, 1, 20, 0.1 ether, uint64(block.timestamp + 1 days));
    }

    function testAllTwentyChequesPayable() public {
        for (uint32 j = 1; j <= 20; j++) {
            address payee = address(uint160(0x7000 + j));
            (uint8 v, bytes32 r, bytes32 s) = _cheque(j, 0.1 ether, payee);
            book.redeem(alice, 1, j, 0.1 ether, payee, v, r, s);
            assertEq(payee.balance, 0.1 ether);
        }
        (uint8 v2, bytes32 r2, bytes32 s2) = _cheque(21, 0.1 ether, address(0x77));
        vm.expectRevert(bytes("out of budget"));
        book.redeem(alice, 1, 21, 0.1 ether, address(0x77), v2, r2, s2);
    }

    function testEquivocationFallsBackToSlackPool() public {
        address bob = address(0xB0B);
        address carol = address(0xCA201);
        address dave = address(0xDA7E);
        (uint8 v, bytes32 r, bytes32 s) = _cheque(5, 0.1 ether, bob);
        book.redeem(alice, 1, 5, 0.1 ether, bob, v, r, s);
        // hardware broken: second cheque with the same counter value
        (v, r, s) = _cheque(5, 0.1 ether, carol);
        book.redeem(alice, 1, 5, 0.1 ether, carol, v, r, s);
        // later honest cheque on a fresh counter becomes a pool claim too
        (v, r, s) = _cheque(6, 0.1 ether, dave);
        book.redeem(alice, 1, 6, 0.1 ether, dave, v, r, s);
        SlackPayoutPool pool = book.pool();
        vm.warp(block.timestamp + 1 days);
        vm.prank(carol); pool.withdraw(uint256(uint160(alice)));
        vm.prank(dave); pool.withdraw(uint256(uint160(alice)));
        assertEq(bob.balance, 0.1 ether);
        assertEq(carol.balance, 0.1 ether); // D = 0.75*1.9 = 1.425 >= claims 0.2: paid in full
        assertEq(dave.balance, 0.1 ether);
    }
}
