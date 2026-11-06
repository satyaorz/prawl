// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {V3Base} from "./V3Base.sol";
import {PrawlEscrowV31} from "../src/PrawlEscrowV31.sol";
import {PrawlV3Codec as V3} from "../src/PrawlV3Codec.sol";

/// @notice Software P-256 keys inside Foundry (vm.signP256 / vm.publicKeyP256), for trees built on the fly.
///  Message bytes come from the escrow's own `spendMessage` view, which CodecTest pins byte-for-byte to the
///  independent Python implementation.
abstract contract SoftKeys is V3Base {
    struct Key {
        uint256 sk;
        bytes32 x;
        bytes32 y;
        bytes32 kh;
    }

    function _key(bytes memory seed) internal pure returns (Key memory k) {
        k.sk = uint256(keccak256(abi.encode("prawl-v3 soft key", seed))) % (P256_N - 1) + 1;
        (uint256 x, uint256 y) = vm.publicKeyP256(k.sk);
        k.x = bytes32(x);
        k.y = bytes32(y);
        k.kh = sha256(abi.encodePacked(hex"3059301306072a8648ce3d020106082a8648ce3d030107034200", bytes1(0x04), k.x, k.y));
    }

    function _digest(
        PrawlEscrowV31 e,
        PrawlEscrowV31.Header memory h,
        uint256 depth,
        bytes32 noteId,
        V3.Output[] memory outs
    ) internal view returns (bytes32 d) {
        (, d) = e.spendMessage(h, depth, noteId, outs);
    }

    function _signSpend(
        PrawlEscrowV31 e,
        PrawlEscrowV31.Header memory h,
        uint256 depth,
        bytes32 noteId,
        V3.Output[] memory outs,
        uint256 sk
    ) internal view returns (bytes32 r, bytes32 s) {
        (r, s) = vm.signP256(sk, _digest(e, h, depth, noteId, outs));
    }

    function _outs1(uint256 v, bytes32 kh) internal pure returns (V3.Output[] memory o) {
        o = new V3.Output[](1);
        o[0] = V3.Output(v, kh);
    }

    function _outs2(uint256 v0, bytes32 k0, uint256 v1, bytes32 k1) internal pure returns (V3.Output[] memory o) {
        o = new V3.Output[](2);
        o[0] = V3.Output(v0, k0);
        o[1] = V3.Output(v1, k1);
    }
}
