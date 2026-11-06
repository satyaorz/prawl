// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {V31Base} from "./V31Base.sol";
import {console} from "forge-std/Test.sol";
import {PrawlEscrowV31, IOtkChecker} from "../src/PrawlEscrowV31.sol";
import {PrawlV3Codec as V3} from "../src/PrawlV3Codec.sol";
import {StipendSender} from "./Mocks.sol";
import {TestRegistry} from "./Equivocation.t.sol";
import {DeviceBondRegistry, IBrokenKeys} from "../src/DeviceBondRegistry.sol";

/// @notice v3.1 COMMIT-THEN-FUND deposits (the RAILGUN-unshield path). The funder is never the depositor:
///  funds arrive at the coin's CREATE2 deposit address (WETH via transfer, or plain ETH) from anyone, and
///  `activate` (anyone, e.g. a relayer earning the tip) turns them into the coin committed to at slot 0.
contract CommitFundTest is V31Base {
    address dep = makeAddr("depositor"); // reclaim address chosen by the wallet (not the funder)
    address wallet = makeAddr("walletPublicAccount");
    address relayer = makeAddr("relayer");
    address mallory = makeAddr("mallory");

    function setUp() public {
        _setUp31(false);
    }

    function _commitment(PrawlEscrowV31.DepositParams memory p, uint256 value) internal view returns (bytes32) {
        return e.commitment(value, p.expiry, p.k0x, p.k0y, p.depositor);
    }

    // ------------------------------------------------------------------ happy paths

    function test_commit_fundWeth_activateByRelayer_redeem() public {
        (PrawlEscrowV31.DepositParams memory p, Key memory k0) = _params("cf1", dep, 1 ether, 1 ether, 0.001 ether);
        vm.prank(wallet);
        address a = e.commitDeposit(p);
        assertEq(a, e.depositAddress(p));
        assertEq(e.pendingDeposits(p.coinId), e.depositParamsHash(p));
        assertEq(a.code.length, 0, "counterfactual until activation");
        // the RAILGUN unshield: WETH.transfer(depositAddress, 1.0015) (0.0005 more than needed)
        _fundWeth(a, 1.0015 ether);
        uint256 g = gasleft();
        vm.prank(relayer);
        uint256 v = e.activate(p);
        console.log("activate (deploy forwarder, unwrap WETH, create coin), gas incl. call:", g - gasleft());
        assertEq(v, 1 ether);
        assertEq(e.deposits(p.coinId), _commitment(p, 1 ether), "slot-0 commitment: value, expiry, k0, depositor");
        assertEq(relayer.balance, 0.001 ether, "tip");
        assertEq(dep.balance, 0.0005 ether, "excess back to the depositor");
        assertEq(address(e).balance, 1 ether);
        assertEq(weth.balanceOf(a), 0);
        assertEq(weth.balanceOf(address(e)), 0, "the escrow holds ETH only");
        assertEq(a.balance, 0);
        assertEq(a.code.length, 56, "forwarder deployed");
        assertEq(e.pendingDeposits(p.coinId), 0, "reservation consumed");
        // slot 0 is still the light-client-provable mapping
        assertEq(vm.load(address(e), keccak256(abi.encode(p.coinId, uint256(0)))), _commitment(p, 1 ether));
        // the coin is an ordinary v3 coin: the genesis key redeems it
        PrawlEscrowV31.Header memory h = _headerOf(p, 1 ether);
        address payout = makeAddr("payout");
        PrawlEscrowV31.Redemption memory rd =
            _tip(e, h, 0, e.genesisNoteId(h.coinId), k0, _outs1(1 ether, e.redeemKeyHash(payout)), 0, payout);
        assertTrue(e.redeem(h, _noPath(), rd));
        assertEq(payout.balance, 1 ether);
        assertEq(address(e).balance, 0);
    }

    function test_fundNativeEth_noCommit() public {
        (PrawlEscrowV31.DepositParams memory p,) = _params("cf2", dep, 0.5 ether, 0.5 ether, 0);
        address a = e.depositAddress(p);
        _fundEth(a, 0.5 ether); // e.g. unshield with unwrapNative, then a tail-call ETH transfer
        vm.expectEmit(true, true, false, true, address(e));
        emit PrawlEscrowV31.DepositActivated(p.coinId, a, 0.5 ether, 0, 0);
        e.activate(p);
        assertEq(e.deposits(p.coinId), _commitment(p, 0.5 ether));
        assertEq(address(e).balance, 0.5 ether);
    }

    function test_fundMixedWethAndEth() public {
        (PrawlEscrowV31.DepositParams memory p,) = _params("cf3", dep, 1 ether, 1 ether, 0);
        address a = e.depositAddress(p);
        _fundWeth(a, 0.7 ether);
        _fundEth(a, 0.3 ether);
        assertEq(e.activate(p), 1 ether);
        assertEq(address(e).balance, 1 ether);
    }

    /// RAILGUN keeps 0.25% (and gas comes out of the private balance): a funded amount below the request.
    function test_feeShortfall_exactModeWaits_rangeModeActivates() public {
        uint256 net = 1 ether - (1 ether * 25) / 10000; // 0.9975
        (PrawlEscrowV31.DepositParams memory p,) = _params("cf4", dep, 1 ether, 1 ether, 0);
        address a = e.depositAddress(p);
        _fundWeth(a, net);
        vm.expectRevert(abi.encodeWithSelector(PrawlEscrowV31.Underfunded.selector, net, 1 ether));
        e.activate(p);
        _fundWeth(a, 1 ether - net); // a top-up (second unshield) completes it
        assertEq(e.activate(p), 1 ether);
        // range mode: accept anything in [0.99, 1.0]; the coin's value is what actually arrived
        (PrawlEscrowV31.DepositParams memory q,) = _params("cf4r", dep, 0.99 ether, 1 ether, 0);
        _fundWeth(e.depositAddress(q), net);
        assertEq(e.activate(q), net);
        assertEq(e.deposits(q.coinId), _commitment(q, net));
    }

    // ------------------------------------------------------------------ front-running and griefing

    /// Somebody copies the coinId from the mempool and commits other parameters first.
    function test_frontRunCommit_victimRefundsNothingLost() public {
        (PrawlEscrowV31.DepositParams memory p,) = _params("victim", dep, 1 ether, 1 ether, 0);
        (PrawlEscrowV31.DepositParams memory q,) = _params("mallory", mallory, 1, 1 ether, 0);
        q.coinId = p.coinId;
        vm.prank(mallory);
        e.commitDeposit(q);
        // committing first is safe: the victim's commit fails BEFORE any funds are sent
        vm.expectRevert(PrawlEscrowV31.CoinExists.selector);
        e.commitDeposit(p);
        // a victim who funded without committing: activation is blocked, but the funds can only go back to her
        address a = e.depositAddress(p);
        _fundWeth(a, 1 ether);
        vm.expectRevert(PrawlEscrowV31.CoinExists.selector);
        e.activate(p);
        assertEq(q.coinId, p.coinId);
        assertTrue(e.depositAddress(q) != a, "other parameters, other deposit address");
        vm.expectRevert(abi.encodeWithSelector(PrawlEscrowV31.Underfunded.selector, 0, 1));
        e.activate(q); // mallory's parameters see none of the victim's funds
        vm.prank(mallory); // anyone may trigger the refund; it pays the victim's depositor only
        assertEq(e.refundDeposit(p), 1 ether);
        assertEq(dep.balance, 1 ether);
        assertEq(mallory.balance, 0);
    }

    /// The same with a direct deposit() of the copied coinId.
    function test_frontRunDeposit_blockedOnceCommitted() public {
        (PrawlEscrowV31.DepositParams memory p,) = _params("cf5", dep, 1 ether, 1 ether, 0);
        e.commitDeposit(p);
        vm.deal(mallory, 1);
        vm.prank(mallory);
        vm.expectRevert(PrawlEscrowV31.CoinExists.selector);
        e.deposit{value: 1}(p.coinId, p.expiry, 1, 2);
        // uncommitted: a direct deposit can take the coinId first; the victim gets a refund (griefing only)
        (PrawlEscrowV31.DepositParams memory r,) = _params("cf5b", dep, 1 ether, 1 ether, 0);
        _fundWeth(e.depositAddress(r), 1 ether);
        vm.prank(mallory);
        e.deposit{value: 1}(r.coinId, r.expiry, 1, 2);
        vm.expectRevert(PrawlEscrowV31.CoinExists.selector);
        e.activate(r);
        assertEq(e.refundDeposit(r), 1 ether);
        assertEq(dep.balance, 1 ether);
    }

    /// An attacker who activates someone else's parameters only creates THAT coin and only earns the tip.
    function test_activateByAnyone_createsExactlyTheCommittedCoin() public {
        (PrawlEscrowV31.DepositParams memory p,) = _params("cf6", dep, 1 ether, 1 ether, 0.01 ether);
        _fundWeth(e.depositAddress(p), 1.01 ether);
        vm.prank(mallory);
        e.activate(p);
        assertEq(mallory.balance, 0.01 ether);
        assertEq(e.deposits(p.coinId), _commitment(p, 1 ether));
        // the same coinId with mallory's key/depositor cannot be activated from these funds
        (PrawlEscrowV31.DepositParams memory q,) = _params("cf6-mallory", mallory, 1, 2 ether, 0);
        q.coinId = p.coinId;
        vm.expectRevert(PrawlEscrowV31.CoinExists.selector);
        e.activate(q);
    }

    function test_refreshNamespace_reserved() public {
        bytes32 id = e.refreshCoinId(keccak256("m"), 0);
        assertEq(bytes4(id), bytes4("RFSH"));
        vm.deal(mallory, 1);
        vm.prank(mallory);
        vm.expectRevert(PrawlEscrowV31.ReservedCoinId.selector);
        e.deposit{value: 1}(id, uint64(NOW + 1 days), 1, 2);
        (PrawlEscrowV31.DepositParams memory p,) = _params("cf7", dep, 1, 1, 0);
        p.coinId = id;
        vm.expectRevert(PrawlEscrowV31.ReservedCoinId.selector);
        e.commitDeposit(p);
        // nor by funding 1 wei and activating without a commit (regression: activate checks the namespace too)
        _fundEth(e.depositAddress(p), 1);
        vm.prank(mallory);
        vm.expectRevert(PrawlEscrowV31.ReservedCoinId.selector);
        e.activate(p);
    }

    // ------------------------------------------------------------------ late funds, refunds, expiry

    function test_lateFunds_refundedToDepositor() public {
        (PrawlEscrowV31.DepositParams memory p,) = _params("cf8", dep, 1 ether, 1 ether, 0);
        address a = e.depositAddress(p);
        _fundWeth(a, 1 ether);
        e.activate(p);
        _fundWeth(a, 0.2 ether); // a duplicate unshield
        _fundEth(a, 0.1 ether); // ETH into the now-deployed forwarder
        StipendSender ss = new StipendSender();
        vm.deal(address(this), 0.05 ether);
        ss.send{value: 0.05 ether}(payable(a)); // a 2300-gas transfer into the deployed forwarder works
        vm.prank(mallory);
        assertEq(e.refundDeposit(p), 0.35 ether);
        assertEq(dep.balance, 0.35 ether);
        assertEq(e.deposits(p.coinId), _commitment(p, 1 ether), "coin unchanged");
        vm.expectRevert(PrawlEscrowV31.NothingToRefund.selector);
        e.refundDeposit(p);
    }

    function test_refundRules() public {
        (PrawlEscrowV31.DepositParams memory p,) = _params("cf9", dep, 1 ether, 1 ether, 0);
        e.commitDeposit(p);
        _fundWeth(e.depositAddress(p), 0.4 ether);
        // still activatable (it may be topped up): a stranger cannot bounce it
        vm.prank(mallory);
        vm.expectRevert(PrawlEscrowV31.NotRefundable.selector);
        e.refundDeposit(p);
        // the depositor can take it back at any time; that also frees the coinId
        vm.prank(dep);
        assertEq(e.refundDeposit(p), 0.4 ether);
        assertEq(e.pendingDeposits(p.coinId), 0);
        // after the expiry anyone may return funds
        _fundEth(e.depositAddress(p), 0.3 ether);
        vm.warp(p.expiry);
        vm.expectRevert(PrawlEscrowV31.BadExpiry.selector);
        e.activate(p);
        vm.prank(mallory);
        assertEq(e.refundDeposit(p), 0.3 ether);
        assertEq(dep.balance, 0.7 ether);
    }

    function test_badParams() public {
        (PrawlEscrowV31.DepositParams memory p,) = _params("cfa", dep, 0, 1 ether, 0);
        vm.expectRevert(PrawlEscrowV31.BadValue.selector);
        e.commitDeposit(p);
        p.minValue = 2 ether;
        vm.expectRevert(PrawlEscrowV31.BadValue.selector);
        e.activate(p);
        p.minValue = 1;
        p.maxValue = uint256(type(uint128).max) + 1;
        vm.expectRevert(PrawlEscrowV31.BadValue.selector);
        e.commitDeposit(p);
        p.maxValue = 1 ether;
        p.expiry = uint64(NOW);
        vm.expectRevert(PrawlEscrowV31.BadExpiry.selector);
        e.commitDeposit(p);
        p.expiry = uint64(NOW + MAX_LIFETIME + 1);
        _fundEth(e.depositAddress(p), 1 ether);
        vm.expectRevert(PrawlEscrowV31.BadExpiry.selector);
        e.activate(p); // beyond maxLifetime now ...
        vm.warp(NOW + 2);
        e.activate(p); // ... but fine once inside it
    }

    // ------------------------------------------------------------------ the forwarder and the escrow's ETH door

    function test_forwarder_onlyEscrowCanMoveFunds() public {
        (PrawlEscrowV31.DepositParams memory p,) = _params("cfb", dep, 1 ether, 1 ether, 0);
        address a = e.depositAddress(p);
        _fundWeth(a, 1 ether);
        e.activate(p); // deploys the forwarder
        _fundWeth(a, 0.5 ether);
        _fundEth(a, 0.5 ether);
        // mallory drives the forwarder with the escrow's command format: STOP, nothing moves
        vm.prank(mallory);
        (bool ok,) = a.call(abi.encodePacked(uint256(uint160(mallory)), uint256(0.5 ether), ""));
        assertTrue(ok);
        vm.prank(mallory);
        (ok,) = a.call(
            abi.encodePacked(uint256(uint160(address(weth))), uint256(0), abi.encodeCall(weth.transfer, (mallory, 0.5 ether)))
        );
        assertTrue(ok);
        assertEq(a.balance, 0.5 ether);
        assertEq(weth.balanceOf(a), 0.5 ether);
        assertEq(mallory.balance, 0);
        assertEq(e.refundDeposit(p), 1 ether);
    }

    function test_escrowRejectsStrayEth() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(e).call{value: 1}("");
        assertFalse(ok, "plain ETH to the escrow reverts (it would be unattributable)");
        StipendSender ss = new StipendSender();
        vm.expectRevert();
        ss.send{value: 1}(payable(address(e)));
    }

    // ------------------------------------------------------------------ attested commit (device bonds)

    function test_commitDepositAttested_requireBond() public {
        string memory leaked = vm.readFile("fixtures/leaked_keybox.json");
        string memory ap = vm.readFile("fixtures/attest_params.json");
        PrawlEscrowV31 eb = _deploy31(address(0xE5C3B), address(weth), address(rg), true);
        TestRegistry reg = new TestRegistry(IBrokenKeys(address(eb)), keccak256("xyz.prawl.otktest"), vm.parseJsonBytes32(ap, ".appSignerDigest"));
        eb.setRegistry(IOtkChecker(address(reg)));
        bytes32 ak = reg.registerAttestationKey(
            vm.parseJsonBytes(leaked, ".ak"), reg.governanceRegisterIssuer(vm.parseJsonBytes(leaked, ".ca"), 1), ""
        );
        bytes memory leaf0 = vm.parseJsonBytes(leaked, ".leaves[0].der");
        (PrawlEscrowV31.DepositParams memory p,) = _params("att", dep, 1 ether, 1 ether, 0);
        p.k0x = vm.parseJsonUint(leaked, ".leaves[0].x");
        p.k0y = vm.parseJsonUint(leaked, ".leaves[0].y");
        vm.expectRevert(abi.encodeWithSelector(PrawlEscrowV31.DeviceNotBonded.selector, ak));
        eb.commitDepositAttested(p, leaf0, ak);
        reg.setChallengeOverride(mallory, vm.parseJsonBytes32(ap, ".attestationChallenge"));
        vm.deal(mallory, 1 ether);
        vm.prank(mallory);
        reg.bond{value: 1 ether}(ak, vm.parseJsonBytes(leaked, ".leaves[1].der"));
        p.k0y ^= 1; // a different key than the certificate's
        vm.expectRevert(PrawlEscrowV31.KeyMismatch.selector);
        eb.commitDepositAttested(p, leaf0, ak);
        p.k0y ^= 1;
        vm.expectEmit(true, true, false, false, address(eb));
        emit PrawlEscrowV31.DepositAttested(p.coinId, ak, bytes32(0));
        address a = eb.commitDepositAttested(p, leaf0, ak);
        _fundWeth(a, 1 ether);
        eb.activate(p);
        assertEq(eb.deposits(p.coinId), eb.commitment(1 ether, p.expiry, p.k0x, p.k0y, dep));
    }

    // ------------------------------------------------------------------ property: conservation

    function testFuzz_activate_conservation(uint96 w, uint96 x, uint64 tip, uint96 minV, uint96 extra) public {
        minV = uint96(bound(minV, 1, 100 ether));
        uint256 maxV = uint256(minV) + bound(extra, 0, 10 ether);
        (PrawlEscrowV31.DepositParams memory p,) = _params("fz", dep, minV, maxV, tip);
        address a = e.depositAddress(p);
        if (w > 0) _fundWeth(a, w);
        if (x > 0) _fundEth(a, x);
        uint256 received = uint256(w) + x;
        if (received < uint256(minV) + tip) {
            vm.expectRevert(abi.encodeWithSelector(PrawlEscrowV31.Underfunded.selector, received, uint256(minV) + tip));
            vm.prank(relayer);
            e.activate(p);
            return;
        }
        vm.prank(relayer);
        uint256 v = e.activate(p);
        assertGe(v, minV);
        assertLe(v, maxV);
        assertEq(relayer.balance + dep.balance + v, received, "tip + excess + coin value == funded");
        assertEq(address(e).balance, v, "the escrow holds exactly the coin's value");
        assertEq(e.deposits(p.coinId), _commitment(p, v));
    }
}
