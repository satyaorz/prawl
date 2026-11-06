// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SoftKeys} from "./SoftKeys.sol";
import {PrawlEscrowV31} from "../src/PrawlEscrowV31.sol";
import {PrawlV3Codec as V3} from "../src/PrawlV3Codec.sol";
import {RailgunTypes, IWETH, IRailgunSmartWallet} from "../src/RailgunTypes.sol";
import {MockWETH9, MockRailgun} from "./Mocks.sol";

/// @notice Helpers for the v3.1 suites: an escrow wired to WETH + a RAILGUN shield target, coins built and
///  signed on the fly with software P-256 keys (vm.signP256 over the escrow's own spendMessage bytes, which
///  CodecTest pins to the independent Python implementation).
abstract contract V31Base is SoftKeys {
    address internal constant ESC = address(0xE5C31);
    MockWETH9 internal weth;
    MockRailgun internal rg;
    PrawlEscrowV31 internal e;

    function _setUp31(bool requireBonded) internal {
        vm.warp(NOW);
        weth = new MockWETH9();
        rg = new MockRailgun(weth);
        e = _deploy31(ESC, address(weth), address(rg), requireBonded);
    }

    function _deploy31(address at, address w, address r, bool requireBonded) internal returns (PrawlEscrowV31) {
        deployCodeTo(
            "PrawlEscrowV31.sol:PrawlEscrowV31", abi.encode(GRACE, MAX_LIFETIME, SINK, requireBonded, w, r), at
        );
        return PrawlEscrowV31(payable(at));
    }

    // ------------------------------------------------------------------ coins

    function _directCoin(PrawlEscrowV31 esc, string memory seed, uint256 value, address depositor)
        internal
        returns (PrawlEscrowV31.Header memory h, Key memory k0)
    {
        k0 = _key(abi.encode(seed, "k0"));
        h = PrawlEscrowV31.Header(
            keccak256(abi.encode(seed, "coin")), value, uint64(NOW + 30 days), uint256(k0.x), uint256(k0.y), depositor
        );
        vm.deal(depositor, depositor.balance + value);
        vm.prank(depositor);
        esc.deposit{value: value}(h.coinId, h.expiry, h.k0x, h.k0y);
    }

    function _params(string memory seed, address depositor, uint256 minV, uint256 maxV, uint256 tip)
        internal
        pure
        returns (PrawlEscrowV31.DepositParams memory p, Key memory k0)
    {
        k0 = _key(abi.encode(seed, "k0"));
        p = PrawlEscrowV31.DepositParams(
            keccak256(abi.encode(seed, "coin")),
            uint64(NOW + 30 days),
            uint256(k0.x),
            uint256(k0.y),
            depositor,
            minV,
            maxV,
            tip
        );
    }

    function _headerOf(PrawlEscrowV31.DepositParams memory p, uint256 value)
        internal
        pure
        returns (PrawlEscrowV31.Header memory)
    {
        return PrawlEscrowV31.Header(p.coinId, value, p.expiry, p.k0x, p.k0y, p.depositor);
    }

    /// @dev Fund a deposit address with WETH (as a RAILGUN unshield does: WETH.transfer to the recipient).
    function _fundWeth(address to, uint256 amount) internal {
        address funder = address(0xF00D);
        vm.deal(funder, amount);
        vm.startPrank(funder);
        weth.deposit{value: amount}();
        weth.transfer(to, amount);
        vm.stopPrank();
    }

    /// @dev Fund a deposit address with plain ETH (unwrapNative unshield + tail-call transfer).
    function _fundEth(address to, uint256 amount) internal {
        address funder = address(0xF00E);
        vm.deal(funder, amount);
        vm.prank(funder);
        (bool ok,) = to.call{value: amount}("");
        require(ok, "eth funding failed");
    }

    // ------------------------------------------------------------------ spends

    /// @dev The note (h, depth, noteId) held by key k signs `outs`; returns the Redemption taking output idx.
    function _tip(
        PrawlEscrowV31 esc,
        PrawlEscrowV31.Header memory h,
        uint256 depth,
        bytes32 noteId,
        Key memory k,
        V3.Output[] memory outs,
        uint256 idx,
        address payout
    ) internal view returns (PrawlEscrowV31.Redemption memory rd) {
        (bytes32 r, bytes32 s) = _signSpend(esc, h, depth, noteId, outs, k.sk);
        rd = PrawlEscrowV31.Redemption(outs, idx, payout, r, s);
    }

    /// @dev The same signed spend used as a path step towards output idx (key `next`).
    function _step(PrawlEscrowV31.Redemption memory signed, uint256 idx, Key memory next)
        internal
        pure
        returns (PrawlEscrowV31.Spend memory sp)
    {
        sp = PrawlEscrowV31.Spend(signed.outputs, idx, signed.r, signed.s, next.x, next.y);
    }

    function _noPath() internal pure returns (PrawlEscrowV31.Spend[] memory) {
        return new PrawlEscrowV31.Spend[](0);
    }

    function _path1(PrawlEscrowV31.Spend memory a) internal pure returns (PrawlEscrowV31.Spend[] memory p) {
        p = new PrawlEscrowV31.Spend[](1);
        p[0] = a;
    }

    function _msgHash(PrawlEscrowV31 esc, PrawlEscrowV31.Header memory h, uint256 depth, bytes32 noteId, V3.Output[] memory outs)
        internal
        view
        returns (bytes32)
    {
        return _digest(esc, h, depth, noteId, outs);
    }

    function _outs3(uint256 v0, bytes32 k0, uint256 v1, bytes32 k1, uint256 v2, bytes32 k2)
        internal
        pure
        returns (V3.Output[] memory o)
    {
        o = new V3.Output[](3);
        o[0] = V3.Output(v0, k0);
        o[1] = V3.Output(v1, k1);
        o[2] = V3.Output(v2, k2);
    }

    // ------------------------------------------------------------------ shield requests

    /// @dev A structurally valid ShieldRequest for local tests (the fork tests use a REAL one from kohaku).
    function _sr(string memory seed, uint256 value) internal view returns (RailgunTypes.ShieldRequest memory sr) {
        bytes32 r = keccak256(bytes(seed));
        sr.preimage.npk = bytes32(uint256(r) >> 8); // < the BN254 scalar field, like a real npk
        sr.preimage.token = RailgunTypes.TokenData(0, address(weth), 0);
        sr.preimage.value = uint120(value);
        sr.ciphertext.encryptedBundle = [keccak256(abi.encode(r, 1)), keccak256(abi.encode(r, 2)), keccak256(abi.encode(r, 3))];
        sr.ciphertext.shieldKey = keccak256(abi.encode(r, 4));
    }
}
