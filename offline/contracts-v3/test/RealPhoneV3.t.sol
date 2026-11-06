// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {V3Base} from "./V3Base.sol";
import {console} from "forge-std/Test.sol";
import {PrawlEscrowV3} from "../src/PrawlEscrowV3.sol";

/// @notice REAL phone v3 vectors: the coordinator's two-phone run (android_test/w3_split.sh, log copied to
///  vectors/phone_run3/run3_split_105852.log), bundles copied unmodified to vectors/phone_run3/ and converted
///  by tools/bundles_to_foundry.py into fixtures/v3_phone.json.
///    S1 Alice (Samsung S25 Ultra, StrongBox genesis key) mints 1.0 ETH coin "s" for chain 11155111, escrow 0x...0E5C70
///    S2 Alice -> Bob (OnePlus, TEE) 0.2 + Alice change 0.8 (StrongBox)
///    S3 Bob 0.2 -> Dave 0.1 (Samsung) + Bob change 0.1 (OnePlus TEE)
///    S7 Bob's change key signs a PRAWL-REDEEM of its 0.1 to 0x...0B0B00            <- redeemed here
///    S6 Bob edits Alice's spend to 0.9 + 0.1 (pay3_s_tamper.json)                 <- rejected here
///  The depositor is NOT in any signed message; the phone's mint file has a zero placeholder, replaced at
///  conversion by the stand-in 0x...0A11CE (--depositor).
contract RealPhoneV3Test is V3Base {
    string constant NAME = "redeem3_s_n_s_c1793942942882";
    address constant ESCROW = address(0xE5C70); // the address the phones signed for
    address constant PAYOUT = address(0xB0B00); // the payout Bob's phone signed for
    PrawlEscrowV3 e;
    PrawlEscrowV3.Header h;

    function setUp() public {
        if (!vm.exists("fixtures/v3_phone.json")) {
            vm.skip(true);
            return;
        }
        _loadFixture("fixtures/v3_phone.json");
        h = _header("s");
        vm.warp(uint256(h.expiry) - 13 days); // the phones minted with a 14-day lifetime
        vm.chainId(11155111);
        e = _deployAt(ESCROW, GRACE, MAX_LIFETIME);
        _deposit(e, h);
    }

    function test_real_phoneSignedRedeem_pays() public {
        (PrawlEscrowV3.Header memory hh, PrawlEscrowV3.Spend[] memory p, PrawlEscrowV3.Redemption memory rd) = _load(NAME);
        assertEq(rd.payout, PAYOUT);
        assertEq(p.length, 2, "genesis spend (StrongBox) + Bob's spend (TEE), then Bob's change key's REDEEM");
        // the escrow rebuilds the exact bytes the phones signed
        (bytes memory m,) = e.spendMessage(hh, 2, vm.parseJsonBytes32(fx, string.concat(".redeems.", NAME, ".redeem.noteId")), rd.outputs);
        assertEq(m, vm.parseJsonBytes(fx, string.concat(".redeems.", NAME, ".redeem.message")));
        assertTrue(e.redeem(hh, p, rd));
        console.log("REAL v3 redeem (2 path spends + phone-signed REDEEM), execution gas:", _lastGas());
        assertEq(PAYOUT.balance, 0.1 ether);
        (uint128 paid, bool frozen,) = e.coins(hh.coinId);
        assertEq(paid, 0.1 ether);
        assertFalse(frozen);
        // the same redemption again
        vm.expectPartialRevert(PrawlEscrowV3.AlreadyRedeemed.selector);
        e.redeem(hh, p, rd);
    }

    function test_real_wrongPayout_escrow_chain() public {
        (PrawlEscrowV3.Header memory hh, PrawlEscrowV3.Spend[] memory p, PrawlEscrowV3.Redemption memory rd) = _load(NAME);
        rd.payout = makeAddr("thief");
        vm.expectRevert(PrawlEscrowV3.NotRedeemOutput.selector);
        e.redeem(hh, p, rd);
        rd.payout = PAYOUT;
        // the same code and deposit at another address
        PrawlEscrowV3 other = _deployAt(address(0xE5C71), GRACE, MAX_LIFETIME);
        _deposit(other, hh);
        vm.expectRevert(PrawlEscrowV3.NotRedeemOutput.selector);
        other.redeem(hh, p, rd);
        // another chain
        vm.chainId(1);
        vm.expectRevert(PrawlEscrowV3.NotRedeemOutput.selector);
        e.redeem(hh, p, rd);
    }

    /// Phone run step S6: Bob edits Alice's real spend to give himself 0.9 (sum still 1.0).
    function test_real_tamperedGenesisSpend_badSig() public {
        (PrawlEscrowV3.Header memory hh, PrawlEscrowV3.Spend[] memory p, PrawlEscrowV3.Redemption memory rd) = _load(NAME);
        assertEq(p[0].outputs[0].value, 0.2 ether);
        p[0].outputs[0].value = 0.9 ether;
        p[0].outputs[1].value = 0.1 ether;
        vm.expectRevert(abi.encodeWithSelector(PrawlEscrowV3.BadSig.selector, 0));
        e.redeem(hh, p, rd);
    }

    /// The tip's (Bob's change key's) REDEEM signature cannot be reused for a different amount or index.
    function test_real_tipSignatureBindsOutputs() public {
        (PrawlEscrowV3.Header memory hh, PrawlEscrowV3.Spend[] memory p, PrawlEscrowV3.Redemption memory rd) = _load(NAME);
        rd.outputs[0].value = 0.05 ether;
        vm.expectRevert(abi.encodeWithSelector(PrawlEscrowV3.ConservationViolated.selector, 2, 0.05 ether, 0.1 ether));
        e.redeem(hh, p, rd);
        // Dave's sibling note (output 0 of Bob's spend) with Bob's change-key REDEEM: wrong key on the path
        (hh, p, rd) = _load(NAME);
        p[1].index = 0;
        vm.expectRevert(abi.encodeWithSelector(PrawlEscrowV3.OutputKeyMismatch.selector, 1));
        e.redeem(hh, p, rd);
    }

    function test_real_expiryReclaim() public {
        assertTrue(_redeem(e, NAME));
        vm.warp(uint256(h.expiry) + GRACE);
        uint256 before = h.depositor.balance;
        e.reclaim(h);
        assertEq(h.depositor.balance - before, 0.9 ether, "the 0.9 not redeemed on-chain returns to the depositor");
    }
}
