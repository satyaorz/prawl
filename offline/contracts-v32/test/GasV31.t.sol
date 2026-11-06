// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {V31Base} from "./V31Base.sol";
import {console} from "forge-std/Test.sol";
import {PrawlEscrowV31} from "../src/PrawlEscrowV31.sol";
import {PrawlV3Codec as V3} from "../src/PrawlV3Codec.sol";
import {RailgunTypes, IWETH, IRailgunSmartWallet} from "../src/RailgunTypes.sol";
import {MockWETH9, MockRailgun} from "./Mocks.sol";

/// @notice Gas of the v3.1 calls (local osaka rules; MockRailgun for the shield, so the shield row here is the
///  escrow's own cost plus a cheap mock -- the REAL RailgunSmartWallet figure comes from the fork). The escrow is
///  created with `new` so that `forge test --gas-report` attributes the calls. Under --gas-report every test runs
///  in isolation and vm.lastCallGas is a full-transaction figure (21k base + calldata included).
contract GasV31Test is V31Base {
    address dep = makeAddr("depositor");

    function setUp() public {
        vm.warp(NOW);
        weth = new MockWETH9();
        rg = new MockRailgun(weth);
        e = new PrawlEscrowV31(GRACE, MAX_LIFETIME, SINK, false, IWETH(address(weth)), IRailgunSmartWallet(address(rg)));
    }

    function _log(string memory what) internal view returns (uint256 g) {
        g = _lastGas();
        console.log(what, g);
        assertLt(g, TX_CAP);
    }

    function test_gas_commit_and_activate_weth() public {
        (PrawlEscrowV31.DepositParams memory p,) = _params("g1", dep, 1 ether, 1 ether, 0);
        e.commitDeposit(p);
        _log("commitDeposit:");
        _fundWeth(e.depositAddress(p), 1 ether);
        e.activate(p);
        _log("activate (WETH, after commit; forwarder CREATE2 + unwrap):");
    }

    function test_gas_activate_eth_noCommit_tip() public {
        (PrawlEscrowV31.DepositParams memory p,) = _params("g2", dep, 1 ether, 1 ether, 0.001 ether);
        _fundEth(e.depositAddress(p), 1.001 ether);
        e.activate(p);
        _log("activate (ETH, no commit, tip):");
    }

    function test_gas_refund_late() public {
        (PrawlEscrowV31.DepositParams memory p,) = _params("g3", dep, 1 ether, 1 ether, 0);
        _fundEth(e.depositAddress(p), 1 ether);
        e.activate(p);
        _fundWeth(e.depositAddress(p), 0.1 ether);
        e.refundDeposit(p);
        _log("refundDeposit (late WETH, forwarder already deployed):");
    }

    function test_gas_deposit_direct() public {
        (PrawlEscrowV31.Header memory h,) = _directCoin(e, "g4", 1 ether, dep);
        h;
        _log("deposit (direct):");
    }

    function test_gas_redeemToShield_genesis_mock() public {
        (PrawlEscrowV31.Header memory h, Key memory k0) = _directCoin(e, "g5", 1 ether, dep);
        RailgunTypes.ShieldRequest memory sr = _sr("g5", 1 ether);
        (bytes32 kh,) = e.shieldKeyHash(sr);
        PrawlEscrowV31.Redemption memory rd = _tip(e, h, 0, e.genesisNoteId(h.coinId), k0, _outs1(1 ether, kh), 0, address(0));
        e.redeemToShield(h, _noPath(), rd, sr);
        _log("redeemToShield (genesis, MOCK railgun):");
    }

    function test_gas_refresh_genesis() public {
        (PrawlEscrowV31.Header memory h, Key memory k0) = _directCoin(e, "g6", 1 ether, dep);
        Key memory nk = _key("g6-new");
        uint64 nx = uint64(NOW + 40 days);
        V3.Output[] memory o = _outs1(1 ether, e.refreshKeyHash(nx, uint256(nk.x), uint256(nk.y), dep));
        bytes32 g0 = e.genesisNoteId(h.coinId);
        PrawlEscrowV31.Redemption memory rd = _tip(e, h, 0, g0, k0, o, 0, dep);
        bytes32 id = e.refreshCoinId(_msgHash(e, h, 0, g0, o), 0);
        e.refresh(h, _noPath(), rd, id, nx, uint256(nk.x), uint256(nk.y));
        _log("refresh (genesis):");
    }

    function test_gas_redeem_genesis() public {
        (PrawlEscrowV31.Header memory h, Key memory k0) = _directCoin(e, "g7", 1 ether, dep);
        address payout = makeAddr("payout-g7");
        PrawlEscrowV31.Redemption memory rd =
            _tip(e, h, 0, e.genesisNoteId(h.coinId), k0, _outs1(1 ether, e.redeemKeyHash(payout)), 0, payout);
        e.redeem(h, _noPath(), rd);
        _log("redeem (genesis, v3 path, for comparison):");
    }
}
