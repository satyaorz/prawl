// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "../src/PrawlOTKEscrow.sol";

/// Each "OTK" here is a P-256 key used ONCE by the test, standing in for an Android Keystore key
/// with setMaxUsageCount(1). The equivocation test plays a broken TEE that signs twice.
contract PrawlOTKTest is Test {
    PrawlOTKEscrow esc;
    uint256 nextSk = 0xA11CE;

    function setUp() public {
        esc = new PrawlOTKEscrow();
    }

    function newKey() internal returns (uint256 sk, bytes32 x, bytes32 y) {
        sk = uint256(keccak256(abi.encode(nextSk++))) % 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;
        (uint256 px, uint256 py) = vm.publicKeyP256(sk);
        (x, y) = (bytes32(px), bytes32(py));
    }

    function sign(uint256 sk, bytes memory m) internal pure returns (bytes32 r, bytes32 s) {
        (r, s) = vm.signP256(sk, sha256(m));
    }

    struct CoinChain {
        bytes32 coinId;
        PrawlOTKEscrow.Hop[] hops;
        uint256 tipSk;
        bytes32 tipX;
        bytes32 tipY;
    }

    /// Build a chain: deposit 1 ether, then `n` payments of 0.01 ether each, every hop splitting into
    /// [payment -> recipient OTK, change -> payer's fresh OTK]; the redemption path follows the change.
    function buildChain(uint256 n, uint256 nOuts) internal returns (CoinChain memory ch) {
        (uint256 sk, bytes32 x, bytes32 y) = newKey();
        ch.coinId = esc.deposit{value: 1 ether}(x, y);
        uint256 value = 1 ether;
        ch.hops = new PrawlOTKEscrow.Hop[](n);
        for (uint256 i = 0; i < n; i++) {
            PrawlOTKEscrow.Out[] memory outs = new PrawlOTKEscrow.Out[](nOuts);
            uint256 nextSk_;
            uint256 pay = 0.01 ether;
            for (uint256 j = 0; j < nOuts; j++) {
                (uint256 osk, bytes32 ox, bytes32 oy) = newKey();
                outs[j] = PrawlOTKEscrow.Out(j == 0 ? value - pay * (nOuts - 1) : pay, ox, oy);
                if (j == 0) nextSk_ = osk;
            }
            bytes memory m = esc.hopMessage(ch.coinId, esc.keyHash(x, y), outs);
            (bytes32 r, bytes32 s) = sign(sk, m);
            ch.hops[i].outs = outs;
            ch.hops[i].next = 0;
            ch.hops[i].r = r;
            ch.hops[i].s = s;
            (sk, x, y, value) = (nextSk_, outs[0].x, outs[0].y, outs[0].value);
        }
        (ch.tipSk, ch.tipX, ch.tipY) = (sk, x, y);
    }

    function redeemChain(CoinChain memory ch, address payout) internal returns (uint256 gasUsed) {
        bytes memory rm = esc.redeemMessage(ch.coinId, esc.keyHash(ch.tipX, ch.tipY), payout);
        (bytes32 r, bytes32 s) = sign(ch.tipSk, rm);
        uint256 g = gasleft();
        esc.redeem(ch.coinId, ch.hops, payout, r, s);
        gasUsed = g - gasleft();
    }

    function test_precompileLive() public view {
        // EIP-7951 test vector shape: a bad signature must return empty/0, not revert.
        (bool ok, bytes memory out) = address(0x100).staticcall(abi.encode(bytes32(0), bytes32(uint256(1)), bytes32(uint256(1)), bytes32(uint256(1)), bytes32(uint256(1))));
        assertTrue(ok);
        assertEq(out.length, 0);
    }

    function test_gas_table() public {
        uint256[5] memory depths = [uint256(0), 1, 2, 4, 8];
        for (uint256 k = 0; k < depths.length; k++) {
            CoinChain memory ch = buildChain(depths[k], 2);
            address payout = address(uint160(0xB0B + k));
            uint256 g = redeemChain(ch, payout);
            uint256 cd = abi.encodeCall(esc.redeem, (ch.coinId, ch.hops, payout, bytes32(0), bytes32(0))).length;
            emit log_named_uint(string.concat("hops=", vm.toString(depths[k]), " outs=2 redeem gas (excl. 21k base+calldata)"), g);
            emit log_named_uint(string.concat("hops=", vm.toString(depths[k]), " calldata bytes"), cd);
            assertEq(payout.balance, 1 ether - 0.01 ether * depths[k]);
        }
    }

    function test_honestSplit_bothBranchesRedeem() public {
        CoinChain memory ch = buildChain(1, 2);
        redeemChain(ch, address(0xB0B)); // change branch
        // payment branch: same hop message, different `next`
        PrawlOTKEscrow.Hop[] memory hops = ch.hops;
        hops[0].next = 1;
        // recipient key of output 1 was created by newKey() with sk = nextSk-? ; rebuild deterministically
        // (output 1 is the 3rd key generated: root=0, out0=1, out1=2)
        uint256 sk1 = uint256(keccak256(abi.encode(uint256(0xA11CE) + 2))) % 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;
        bytes32 kh1 = esc.keyHash(hops[0].outs[1].x, hops[0].outs[1].y);
        (bytes32 r, bytes32 s) = sign(sk1, esc.redeemMessage(ch.coinId, kh1, address(0xC4A)));
        esc.redeem(ch.coinId, hops, address(0xC4A), r, s);
        assertEq(address(0xB0B).balance + address(0xC4A).balance, 1 ether);
    }

    function test_replayRedeemSameLeaf_isNoop_notDoublePay() public {
        CoinChain memory ch = buildChain(2, 2);
        redeemChain(ch, address(0xB0B));
        uint256 before = address(0xB0B).balance;
        // Re-submitting the identical transcript: every key use matches its recorded message ->
        // it would pay again unless the leaf is tracked. Escrow cap is the second guard.
        bytes memory rm = esc.redeemMessage(ch.coinId, esc.keyHash(ch.tipX, ch.tipY), address(0xB0B));
        (bytes32 r, bytes32 s) = sign(ch.tipSk, rm);
        vm.expectRevert(bytes("already redeemed"));
        esc.redeem(ch.coinId, ch.hops, address(0xB0B), r, s);
        assertEq(address(0xB0B).balance, before);
    }

    function test_brokenTEE_equivocationDetected() public {
        CoinChain memory ch = buildChain(1, 2);
        // A broken TEE lets the tip key sign a SECOND redeem to a different payout.
        redeemChain(ch, address(0xB0B));
        bytes memory rm2 = esc.redeemMessage(ch.coinId, esc.keyHash(ch.tipX, ch.tipY), address(0xEE1));
        (bytes32 r, bytes32 s) = sign(ch.tipSk, rm2);
        vm.expectEmit(true, true, false, false);
        emit PrawlOTKEscrow.HardwareBreak(ch.coinId, esc.keyHash(ch.tipX, ch.tipY), 0, 0);
        esc.redeem(ch.coinId, ch.hops, address(0xEE1), r, s);
        assertEq(address(0xEE1).balance, 0);
        assertTrue(esc.brokenKey(esc.keyHash(ch.tipX, ch.tipY)));
    }

    function test_forgedSignatureRejected() public {
        CoinChain memory ch = buildChain(1, 2);
        ch.hops[0].s = bytes32(uint256(ch.hops[0].s) ^ 1);
        bytes memory rm = esc.redeemMessage(ch.coinId, esc.keyHash(ch.tipX, ch.tipY), address(0xB0B));
        (bytes32 r, bytes32 s) = sign(ch.tipSk, rm);
        vm.expectRevert(abi.encodeWithSelector(PrawlOTKEscrow.BadSig.selector, 0));
        esc.redeem(ch.coinId, ch.hops, address(0xB0B), r, s);
    }
}
