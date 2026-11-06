// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SoftKeys} from "./SoftKeys.sol";
import {Vm, console} from "forge-std/Test.sol";
import {PrawlEscrowV31} from "../src/PrawlEscrowV31.sol";
import {PrawlV3Codec as V3} from "../src/PrawlV3Codec.sol";
import {RailgunTypes, IWETH, IRailgunSmartWallet} from "../src/RailgunTypes.sol";

interface IRailgunView {
    function nextLeafIndex() external view returns (uint256);
    function merkleRoot() external view returns (bytes32);
    function treasury() external view returns (address);
    function shieldFee() external view returns (uint120);
}

/// @notice Against the REAL RAILGUN contracts on a Sepolia fork (anvil --fork-url ... --hardfork osaka, then
///  `forge test --fork-url http://127.0.0.1:<port> --match-contract RailgunForkTest`). Skipped elsewhere.
///  The ShieldRequest is REAL: built by kohaku-railgun-wasm's Shield.addErc20 (tools/build_shield_request.cjs),
///  i.e. what the Prawl wallet's RailgunWallet.buildShield produces, for a throwaway 0zk address.
contract RailgunForkTest is SoftKeys {
    address constant RSW = 0xeCFCf3b4eC647c4Ca6D49108b311b7a7C9543fea; // RailgunSmartWallet proxy (Sepolia)
    address constant WETH = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14; // RAILGUN wrappedBaseToken (Sepolia)
    bytes32 constant SHIELD_TOPIC = keccak256(
        "Shield(uint256,uint256,(bytes32,(uint8,address,uint256),uint120)[],(bytes32[3],bytes32)[],uint256[])"
    );
    PrawlEscrowV31 e;
    string sx;

    function setUp() public {
        if (block.chainid != 11155111 || RSW.code.length == 0) {
            vm.skip(true);
            return;
        }
        sx = vm.readFile("fixtures/railgun_shield_1e15.json");
        // a fresh address: forge's default CREATE addresses already hold Sepolia ETH from other people's runs
        address at = address(uint160(uint256(keccak256(abi.encode("prawl v3.1 fork escrow", block.number)))));
        require(at.balance == 0 && at.code.length == 0, "fork address in use");
        deployCodeTo(
            "PrawlEscrowV31.sol:PrawlEscrowV31", abi.encode(1 days, 30 days, address(0x5111C0), false, WETH, RSW), at
        );
        e = PrawlEscrowV31(payable(at));
    }

    function _realRequest() internal view returns (RailgunTypes.ShieldRequest memory sr) {
        sr.preimage.npk = vm.parseJsonBytes32(sx, ".request.npk");
        sr.preimage.token = RailgunTypes.TokenData(
            uint8(vm.parseJsonUint(sx, ".request.tokenType")),
            vm.parseJsonAddress(sx, ".request.tokenAddress"),
            vm.parseJsonUint(sx, ".request.tokenSubID")
        );
        sr.preimage.value = uint120(vm.parseJsonUint(sx, ".request.value"));
        bytes32[] memory eb = vm.parseJsonBytes32Array(sx, ".request.encryptedBundle");
        sr.ciphertext.encryptedBundle = [eb[0], eb[1], eb[2]];
        sr.ciphertext.shieldKey = vm.parseJsonBytes32(sx, ".request.shieldKey");
        assertEq(abi.encode(sr), vm.parseJsonBytes(sx, ".abiEncoded"), "fixture decodes to the kohaku calldata words");
    }

    // state of the shield scenario (storage: keeps the legacy code generator's stack small)
    PrawlEscrowV31.Header h;
    V3.Output[] outs;
    bytes32 sigR;
    bytes32 sigS;
    uint256 leaf0;
    bytes32 root0;
    uint256 poolW0;
    uint256 treW0;

    function _shieldCoin(RailgunTypes.ShieldRequest memory sr) internal returns (PrawlEscrowV31.Redemption memory rd) {
        uint256 amount = sr.preimage.value; // 0.001 ETH
        // a coin of 0.0015: the genesis note shields 0.001 and keeps 0.0005 for Bob
        Key memory k0 = _key("fork-k0");
        h = PrawlEscrowV31.Header(
            keccak256("fork-coin"), amount + 0.0005 ether, uint64(block.timestamp + 7 days), uint256(k0.x), uint256(k0.y), address(this)
        );
        e.deposit{value: h.value}(h.coinId, h.expiry, h.k0x, h.k0y);
        (bytes32 skh,) = e.shieldKeyHash(sr);
        V3.Output[] memory o = _outs2(amount, skh, 0.0005 ether, _key("fork-bob").kh);
        for (uint256 i = 0; i < o.length; i++) outs.push(o[i]);
        (sigR, sigS) = _signSpend(e, h, 0, e.genesisNoteId(h.coinId), o, k0.sk);
        rd = PrawlEscrowV31.Redemption(o, 0, address(0), sigR, sigS);
        IRailgunView rv = IRailgunView(RSW);
        leaf0 = rv.nextLeafIndex();
        root0 = rv.merkleRoot();
        poolW0 = IWETH(WETH).balanceOf(RSW);
        treW0 = IWETH(WETH).balanceOf(rv.treasury());
    }

    function _checkShieldEvent(Vm.Log[] memory logs, RailgunTypes.ShieldRequest memory sr, uint256 fee) internal view {
        bool seen;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != RSW || logs[i].topics[0] != SHIELD_TOPIC) continue;
            (uint256 tree, uint256 start, RailgunTypes.CommitmentPreimage[] memory cs, RailgunTypes.ShieldCiphertext[] memory cts, uint256[] memory fees) =
                abi.decode(logs[i].data, (uint256, uint256, RailgunTypes.CommitmentPreimage[], RailgunTypes.ShieldCiphertext[], uint256[]));
            console.log("Shield event from RailgunSmartWallet: tree", tree, "startPosition", start);
            console.log("  commitment value (after fee)", uint256(cs[0].value), "fee", fees[0]);
            console.log("  npk");
            console.logBytes32(cs[0].npk);
            assertEq(start, leaf0);
            assertEq(cs.length, 1);
            assertEq(cs[0].npk, sr.preimage.npk, "the phone-committed recipient");
            assertEq(cs[0].token.tokenAddress, WETH);
            assertEq(uint256(cs[0].value) + fees[0], sr.preimage.value);
            assertEq(fees[0], fee);
            assertEq(cts[0].shieldKey, sr.ciphertext.shieldKey);
            assertEq(cts[0].encryptedBundle[0], sr.ciphertext.encryptedBundle[0]);
            seen = true;
        }
        assertTrue(seen, "RailgunSmartWallet emitted Shield");
    }

    function test_fork_redeemToShield_realRailgun() public {
        RailgunTypes.ShieldRequest memory sr = _realRequest();
        PrawlEscrowV31.Redemption memory rd = _shieldCoin(sr);
        IRailgunView rv = IRailgunView(RSW);
        uint256 fee = (uint256(sr.preimage.value) * rv.shieldFee()) / 10000;
        vm.recordLogs();
        uint256 g = gasleft();
        assertTrue(e.redeemToShield(h, new PrawlEscrowV31.Spend[](0), rd, sr));
        console.log("FORK redeemToShield into the REAL RailgunSmartWallet, gas incl. call:", g - gasleft());
        _checkShieldEvent(vm.getRecordedLogs(), sr, fee);
        assertEq(rv.nextLeafIndex(), leaf0 + 1, "one commitment inserted");
        assertTrue(rv.merkleRoot() != root0, "merkle root moved");
        assertEq(IWETH(WETH).balanceOf(RSW), poolW0 + sr.preimage.value - fee);
        assertEq(IWETH(WETH).balanceOf(rv.treasury()), treW0 + fee);
        assertEq(IWETH(WETH).balanceOf(address(e)), 0);
        assertEq(address(e).balance, 0.0005 ether);
        _bobRedeems();
        assertEq(address(e).balance, 0);
    }

    /// Bob's sibling output (index 1 of the same genesis spend) still redeems publicly.
    function _bobRedeems() internal {
        Key memory bob = _key("fork-bob");
        address bobOut = makeAddr("bobOut");
        V3.Output[] memory o = _outs1(0.0005 ether, e.redeemKeyHash(bobOut));
        (bytes32 r2, bytes32 s2) = _signSpend(e, h, 1, e.childNoteId(sigR, sigS, 1), o, bob.sk);
        PrawlEscrowV31.Spend[] memory p = new PrawlEscrowV31.Spend[](1);
        p[0] = PrawlEscrowV31.Spend(outs, 1, sigR, sigS, bob.x, bob.y);
        assertTrue(e.redeem(h, p, PrawlEscrowV31.Redemption(o, 0, bobOut, r2, s2)));
        assertEq(bobOut.balance, 0.0005 ether);
    }

    /// Commit-then-fund with the REAL Sepolia WETH: the forwarder unwraps (WETH.withdraw sends it ETH).
    function test_fork_commitFund_realWeth() public {
        Key memory k0 = _key("fork-cf");
        address dep = makeAddr("fork-dep");
        PrawlEscrowV31.DepositParams memory p = PrawlEscrowV31.DepositParams(
            keccak256("fork-cf-coin"), uint64(block.timestamp + 7 days), uint256(k0.x), uint256(k0.y), dep, 0.001 ether, 0.001 ether, 0
        );
        address a = e.commitDeposit(p);
        address funder = makeAddr("unshield-standin");
        vm.deal(funder, 0.002 ether);
        vm.startPrank(funder);
        IWETH(WETH).deposit{value: 0.001 ether}();
        IWETH(WETH).transfer(a, 0.001 ether); // what RAILGUN's unshield does: token.transfer(recipient)
        vm.stopPrank();
        uint256 g = gasleft();
        assertEq(e.activate(p), 0.001 ether);
        console.log("FORK activate (real WETH, forwarder deploy + unwrap), gas incl. call:", g - gasleft());
        assertEq(e.deposits(p.coinId), e.commitment(0.001 ether, p.expiry, p.k0x, p.k0y, dep));
        assertEq(address(e).balance, 0.001 ether);
        assertEq(IWETH(WETH).balanceOf(a), 0);
        // late WETH after activation goes back to the depositor
        vm.prank(funder);
        (bool ok,) = a.call{value: 0.0004 ether}("");
        assertTrue(ok);
        assertEq(e.refundDeposit(p), 0.0004 ether);
        assertEq(dep.balance, 0.0004 ether);
    }
}
