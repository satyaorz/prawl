// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {PrawlEscrowV31} from "../src/PrawlEscrowV31.sol";
import {PrawlV3Codec as V3} from "../src/PrawlV3Codec.sol";

/// @notice Generic loader for fixtures written by tools/bundles_to_foundry.py ("prawl-v3-foundry/1"), plus
///  shared deployment helpers. Nothing here is specific to the synthetic vectors: the same functions load
///  REAL phone bundles converted with the same tool.
abstract contract V3Base is Test {
    uint256 internal constant NOW = 1_793_966_400; // 2026-11-06 12:00 UTC
    uint256 internal constant GRACE = 7 days;
    uint256 internal constant MAX_LIFETIME = 60 days;
    uint256 internal constant TX_CAP = 1 << 24; // EIP-7825 per-transaction gas cap (Fusaka); anvil 1.5.1 does not enforce it
    address internal constant SINK = address(0x5111C0); // compensation sink for frozen remainders
    uint256 internal constant P256_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;

    string internal fx; // the loaded fixture JSON

    function _loadFixture(string memory path) internal {
        fx = vm.readFile(path);
        assertEq(vm.parseJsonString(fx, ".format"), "prawl-v3-foundry/1", "fixture format");
    }

    // ------------------------------------------------------------------ deployment

    function _deployAt(address at, uint256 grace, uint256 maxLifetime) internal returns (PrawlEscrowV31 e) {
        deployCodeTo("PrawlEscrowV31.sol:PrawlEscrowV31", abi.encode(grace, maxLifetime, SINK, false, address(0), address(0)), at);
        e = PrawlEscrowV31(payable(at));
    }

    function _coinEscrow(string memory coin) internal view returns (address) {
        return vm.parseJsonAddress(fx, string.concat(".coins.", coin, ".escrow"));
    }

    function _coinChainId(string memory coin) internal view returns (uint256) {
        return vm.parseJsonUint(fx, string.concat(".coins.", coin, ".chainId"));
    }

    // ------------------------------------------------------------------ loaders

    function _header(string memory coin) internal view returns (PrawlEscrowV31.Header memory h) {
        string memory b = string.concat(".coins.", coin, ".");
        h.coinId = vm.parseJsonBytes32(fx, string.concat(b, "coinId"));
        h.value = vm.parseJsonUint(fx, string.concat(b, "value"));
        h.expiry = uint64(vm.parseJsonUint(fx, string.concat(b, "expiry")));
        h.k0x = uint256(vm.parseJsonBytes32(fx, string.concat(b, "k0x")));
        h.k0y = uint256(vm.parseJsonBytes32(fx, string.concat(b, "k0y")));
        h.depositor = vm.parseJsonAddress(fx, string.concat(b, "depositor"));
    }

    function _outputs(string memory b) internal view returns (V3.Output[] memory o) {
        uint256[] memory v = vm.parseJsonUintArray(fx, string.concat(b, ".values"));
        bytes32[] memory k = vm.parseJsonBytes32Array(fx, string.concat(b, ".keyHashes"));
        require(v.length == k.length, "outputs arrays");
        o = new V3.Output[](v.length);
        for (uint256 i = 0; i < v.length; i++) o[i] = V3.Output(v[i], k[i]);
    }

    /// @param base ".redeems.<name>" or ".equivocations.<name>"
    function _path(string memory base) internal view returns (PrawlEscrowV31.Spend[] memory p) {
        uint256 n = vm.parseJsonUint(fx, string.concat(base, ".nPath"));
        p = new PrawlEscrowV31.Spend[](n);
        for (uint256 i = 0; i < n; i++) {
            string memory b = string.concat(base, ".path[", vm.toString(i), "]");
            p[i].outputs = _outputs(b);
            p[i].index = vm.parseJsonUint(fx, string.concat(b, ".index"));
            p[i].r = vm.parseJsonBytes32(fx, string.concat(b, ".r"));
            p[i].s = vm.parseJsonBytes32(fx, string.concat(b, ".s"));
            p[i].nextX = vm.parseJsonBytes32(fx, string.concat(b, ".nextX"));
            p[i].nextY = vm.parseJsonBytes32(fx, string.concat(b, ".nextY"));
        }
    }

    function _redemption(string memory name) internal view returns (PrawlEscrowV31.Redemption memory rd) {
        string memory b = string.concat(".redeems.", name, ".redeem");
        rd.outputs = _outputs(b);
        rd.index = vm.parseJsonUint(fx, string.concat(b, ".index"));
        rd.payout = vm.parseJsonAddress(fx, string.concat(".redeems.", name, ".payout"));
        rd.r = vm.parseJsonBytes32(fx, string.concat(b, ".r"));
        rd.s = vm.parseJsonBytes32(fx, string.concat(b, ".s"));
    }

    function _coinOf(string memory name) internal view returns (string memory) {
        return vm.parseJsonString(fx, string.concat(".redeems.", name, ".coin"));
    }

    function _amount(string memory name) internal view returns (uint256) {
        return vm.parseJsonUint(fx, string.concat(".redeems.", name, ".amount"));
    }

    function _expect(string memory name) internal view returns (string memory) {
        return vm.parseJsonString(fx, string.concat(".redeems.", name, ".expect"));
    }

    function _load(string memory name)
        internal
        view
        returns (PrawlEscrowV31.Header memory h, PrawlEscrowV31.Spend[] memory p, PrawlEscrowV31.Redemption memory rd)
    {
        h = _header(_coinOf(name));
        p = _path(string.concat(".redeems.", name));
        rd = _redemption(name);
    }

    function _signed(string memory b) internal view returns (PrawlEscrowV31.Signed memory s) {
        s.message = vm.parseJsonBytes(fx, string.concat(b, ".message"));
        s.r = vm.parseJsonBytes32(fx, string.concat(b, ".r"));
        s.s = vm.parseJsonBytes32(fx, string.concat(b, ".s"));
    }

    /// @notice Name of the converter's equivocation entry for `coin` (the first one listed).
    function _equivFor(string memory coin) internal view returns (string memory) {
        string[] memory names = vm.parseJsonStringArray(fx, ".equivocationNames");
        for (uint256 i = 0; i < names.length; i++) {
            if (keccak256(bytes(vm.parseJsonString(fx, string.concat(".equivocations.", names[i], ".coin"))))
                    == keccak256(bytes(coin))) return names[i];
        }
        revert("no equivocation entry for coin");
    }

    /// @dev forge 1.5.1 returns a 5-field Gas struct; the vendored forge-std declares 6 fields, so abi-decoding
    ///  `vm.lastCallGas()` reverts. Read word 1 (gasTotalUsed) of the raw return data instead.
    function _lastGas() internal view returns (uint256 g) {
        (bool ok, bytes memory ret) = address(vm).staticcall(abi.encodeWithSignature("lastCallGas()"));
        require(ok && ret.length >= 64, "lastCallGas");
        assembly ("memory-safe") {
            g := mload(add(ret, 64))
        }
    }

    // ------------------------------------------------------------------ actions

    function _deposit(PrawlEscrowV31 e, PrawlEscrowV31.Header memory h) internal {
        vm.deal(h.depositor, h.depositor.balance + h.value);
        vm.prank(h.depositor);
        e.deposit{value: h.value}(h.coinId, h.expiry, h.k0x, h.k0y);
    }

    function _depositCoin(PrawlEscrowV31 e, string memory coin) internal returns (PrawlEscrowV31.Header memory h) {
        h = _header(coin);
        _deposit(e, h);
    }

    function _redeem(PrawlEscrowV31 e, string memory name) internal returns (bool) {
        (PrawlEscrowV31.Header memory h, PrawlEscrowV31.Spend[] memory p, PrawlEscrowV31.Redemption memory rd) = _load(name);
        return e.redeem(h, p, rd);
    }

    /// @dev contract error name (as used in fixtures' "expect") -> selector
    function _sel(string memory n) internal pure returns (bytes4) {
        bytes32 k = keccak256(bytes(n));
        if (k == keccak256("BadSig")) return PrawlEscrowV31.BadSig.selector;
        if (k == keccak256("ConservationViolated")) return PrawlEscrowV31.ConservationViolated.selector;
        if (k == keccak256("ZeroOutput")) return PrawlEscrowV31.ZeroOutput.selector;
        if (k == keccak256("NotRedeemOutput")) return PrawlEscrowV31.NotRedeemOutput.selector;
        if (k == keccak256("OutputKeyMismatch")) return PrawlEscrowV31.OutputKeyMismatch.selector;
        if (k == keccak256("BadIndex")) return PrawlEscrowV31.BadIndex.selector;
        revert(string.concat("unknown expected error ", n));
    }

    function _eq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }
}
