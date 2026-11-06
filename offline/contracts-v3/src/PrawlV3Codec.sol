// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PrawlCodec} from "./PrawlCodec.sol";

/// @title PrawlV3Codec -- byte-exact v3 spend messages (raw/v3/SPEC.md section 3, phone: Wallet3Activity.java)
/// @notice All strings are UTF-8/ASCII; integers are canonical decimal (no sign, no leading zeros);
///  hashes and addresses are lowercase hex without "0x". "sha256hex(x)" below means the 64-char hex of
///  sha256(x); on-chain we keep the 32 raw bytes and hex them only when they appear inside a message.
///
///    message      = "PRAWL-OTK-v3|" chainId "|" escrow40 "|" coinIdHex64 "|" expiry "|" depth "|"
///                   hex(parentNoteId) "|" hex(outputsHash)
///    outputsHash  = sha256( join(";", [ valueWei_i ":" hex(keyHash_i) ]) )
///    keyHash      = sha256(SPKI DER of the one-time P-256 key)               (PrawlCodec.keyHash)
///                 | sha256("PRAWL-REDEEM|" chainId "|" escrow40 "|" payout40) (PrawlCodec.redeemTarget)
///    genesis id   = sha256("genesis|" coinIdHex64)
///    child id     = sha256( hex(DER(sig of the spend that created it)) "|" outputIndex )
///
///  `depth` is the number of spends between genesis and the note being spent (0 for the genesis note) and
///  `parentNoteId` is the id of the note being spent (the parent of the new outputs).
library PrawlV3Codec {
    /// @notice One output of a spend: `value` wei to the one-time key (or PRAWL-REDEEM target) `keyHash`.
    struct Output {
        uint256 value;
        bytes32 keyHash;
    }

    /// @dev Longest item in the outputs string: 78 decimal digits (2^256-1) + ':' + 64 hex + ';'.
    uint256 private constant MAX_ITEM = 144;

    /// @notice "PRAWL-OTK-v3|<chainId>|<escrow40>|<coinIdHex64>|<expiry>|" -- constant for one coin, built once per call.
    function prefix(uint256 chainId, address escrow, bytes32 coinId, uint64 expiry) internal pure returns (bytes memory) {
        return abi.encodePacked(
            "PRAWL-OTK-v3|", dec(chainId), "|", hexAddr(escrow), "|", PrawlCodec.hex32(coinId), "|", dec(expiry), "|"
        );
    }

    /// @notice The exact bytes a note's one-time key signs when spending it.
    function message(bytes memory pre, uint256 depth, bytes32 noteId, bytes32 outsHash)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(pre, dec(depth), "|", PrawlCodec.hex32(noteId), "|", PrawlCodec.hex32(outsHash));
    }

    function genesisNoteId(bytes32 coinId) internal pure returns (bytes32) {
        return sha256(abi.encodePacked("genesis|", PrawlCodec.hex32(coinId)));
    }

    /// @notice Id of output `index` of a spend whose signature is (r, s). The signature enters as the lowercase
    ///  hex of its canonical (strict, minimal) DER encoding, which is what Java's SHA256withECDSA emits.
    /// @dev Malleability: (r, n-s) is a second valid signature of the same message and yields a DIFFERENT
    ///  child id. That is harmless for children (their own signatures commit to one id) but it means an
    ///  output must never be identified by its child id where double payment matters -- the escrow keys
    ///  redemptions by (sha256(message), index) instead.
    function childNoteId(bytes32 r, bytes32 s, uint256 index) internal pure returns (bytes32) {
        return sha256(abi.encodePacked(hexBytes(derSig(r, s)), "|", dec(index)));
    }

    /// @notice keyHash of a PRAWL-REDEEM output: sha256("PRAWL-REDEEM|" chainId "|" escrow40 "|" payout40).
    ///  Same bytes as PrawlCodec.redeemTarget (fuzzed equal in CodecTest), cheaper.
    function redeemTarget(uint256 chainId, address escrow, address payout) internal pure returns (bytes32) {
        return sha256(abi.encodePacked("PRAWL-REDEEM|", dec(chainId), "|", hexAddr(escrow), "|", hexAddr(payout)));
    }

    // ------------------------------------------------------------------ fast primitives
    // Assembly versions of PrawlCodec.dec / hexAddr / derSig (which index bytes one at a time with bounds
    // checks). PrawlCodec stays the unmodified reference; CodecTest fuzzes both for equality.

    /// @notice Canonical decimal ASCII of v.
    function dec(uint256 v) internal pure returns (bytes memory out) {
        assembly ("memory-safe") {
            out := mload(0x40)
            let len := 1
            for { let t := div(v, 10) } t { t := div(t, 10) } { len := add(len, 1) }
            mstore(out, len)
            let p := add(add(out, 32), len)
            for {} 1 {} {
                p := sub(p, 1)
                mstore8(p, add(48, mod(v, 10)))
                v := div(v, 10)
                if iszero(v) { break }
            }
            mstore(0x40, add(add(out, 32), and(add(len, 31), not(31))))
        }
    }

    /// @notice 40 lowercase hex chars of an address, no "0x".
    function hexAddr(address a) internal pure returns (bytes memory out) {
        uint256 v = uint256(uint160(a)) << 96;
        uint256 hi = _spread(v >> 128);
        uint256 lo = _spread(v & type(uint128).max);
        assembly ("memory-safe") {
            out := mload(0x40)
            mstore(out, 40)
            mstore(add(out, 32), hi)
            mstore(add(out, 64), lo) // chars 40..63 lie beyond the length
            mstore(0x40, add(out, 96))
        }
    }

    /// @notice Canonical DER ECDSA-Sig-Value SEQUENCE { INTEGER r, INTEGER s } (minimal INTEGERs).
    function derSig(bytes32 r, bytes32 s) internal pure returns (bytes memory out) {
        assembly ("memory-safe") {
            out := mload(0x40)
            let lzr := 0
            for {} and(lt(lzr, 31), iszero(byte(lzr, r))) {} { lzr := add(lzr, 1) }
            let padr := iszero(lt(byte(lzr, r), 0x80))
            let nr := add(sub(32, lzr), padr)
            let lzs := 0
            for {} and(lt(lzs, 31), iszero(byte(lzs, s))) {} { lzs := add(lzs, 1) }
            let pads := iszero(lt(byte(lzs, s), 0x80))
            let ns := add(sub(32, lzs), pads)
            let body := add(4, add(nr, ns))
            mstore(out, add(body, 2))
            let p := add(out, 32)
            mstore8(p, 0x30)
            mstore8(add(p, 1), body)
            mstore8(add(p, 2), 0x02)
            mstore8(add(p, 3), nr)
            p := add(p, 4)
            if padr {
                mstore8(p, 0)
                p := add(p, 1)
            }
            mstore(p, shl(mul(8, lzr), r)) // significant bytes first; the zero tail is overwritten next
            p := add(p, sub(32, lzr))
            mstore8(p, 0x02)
            mstore8(add(p, 1), ns)
            p := add(p, 2)
            if pads {
                mstore8(p, 0)
                p := add(p, 1)
            }
            mstore(p, shl(mul(8, lzs), s))
            // the last word written ends at p + 32 <= out + 32 + 74 + 32
            mstore(0x40, add(out, 160))
        }
    }

    /// @notice outputsHash plus what the conservation rule needs: the sum (with an overflow flag) and
    ///  whether any output is zero. Never reverts on content; the caller decides.
    function outputsHash(Output[] calldata outs)
        internal
        pure
        returns (bytes32 h, uint256 sum, bool overflow, bool anyZero)
    {
        uint256 n = outs.length;
        bytes memory buf = new bytes(n * MAX_ITEM);
        assembly ("memory-safe") {
            // 16 bytes (low 128 bits) -> 32 lowercase hex chars (same nibble spreading as PrawlCodec.hex32)
            function spread(x) -> y {
                y := and(or(shl(64, x), x), 0x0000000000000000ffffffffffffffff0000000000000000ffffffffffffffff)
                y := and(or(shl(32, y), y), 0x00000000ffffffff00000000ffffffff00000000ffffffff00000000ffffffff)
                y := and(or(shl(16, y), y), 0x0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff)
                y := and(or(shl(8, y), y), 0x00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff)
                y := and(or(shl(4, y), y), 0x0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f)
                let gt9 := and(shr(4, add(y, 0x0606060606060606060606060606060606060606060606060606060606060606)),
                    0x0101010101010101010101010101010101010101010101010101010101010101)
                y := add(add(y, 0x3030303030303030303030303030303030303030303030303030303030303030), mul(gt9, 0x27))
            }
            let start := add(buf, 32)
            let p := start
            // Output is a static (uint256, bytes32) struct: the calldata array is n contiguous 64-byte items
            for { let i := 0 } lt(i, n) { i := add(i, 1) } {
                let item := add(outs.offset, shl(6, i))
                let v := calldataload(item)
                let s2 := add(sum, v)
                if lt(s2, sum) { overflow := 1 }
                sum := s2
                if iszero(v) { anyZero := 1 }
                if i {
                    mstore8(p, 0x3b) // ';'
                    p := add(p, 1)
                }
                let len := 1
                for { let t := div(v, 10) } t { t := div(t, 10) } { len := add(len, 1) }
                let q := add(p, len)
                for {} 1 {} {
                    q := sub(q, 1)
                    mstore8(q, add(48, mod(v, 10)))
                    v := div(v, 10)
                    if iszero(v) { break }
                }
                p := add(p, len)
                mstore8(p, 0x3a) // ':'
                p := add(p, 1)
                let k := calldataload(add(item, 32))
                mstore(p, spread(shr(128, k)))
                mstore(add(p, 32), spread(and(k, 0xffffffffffffffffffffffffffffffff)))
                p := add(p, 64)
            }
            mstore(buf, sub(p, start))
        }
        h = sha256(buf);
    }

    /// @notice Lowercase hex of arbitrary bytes (used for the DER signature inside child note ids).
    function hexBytes(bytes memory b) internal pure returns (bytes memory out) {
        uint256 n = b.length;
        // new bytes(2n) reserves roundup32(2n) bytes == ceil(n/16) * 32: exactly what the 16-byte chunks write
        out = new bytes(2 * n);
        for (uint256 i = 0; i < n; i += 16) {
            uint256 chunk;
            // may read up to 31 bytes past b's allocation; those nibbles land beyond out.length and are ignored
            assembly {
                chunk := shr(128, mload(add(add(b, 32), i)))
            }
            uint256 x = _spread(chunk);
            assembly ("memory-safe") {
                mstore(add(add(out, 32), mul(i, 2)), x)
            }
        }
    }

    // ------------------------------------------------------------------ internals

    /// @dev 16 bytes (low 128 bits) -> 32 ASCII lowercase hex chars, MSB first (same nibble spreading as PrawlCodec.hex32).
    function _spread(uint256 h) private pure returns (uint256 x) {
        assembly ("memory-safe") {
            x := h
            x := and(or(shl(64, x), x), 0x0000000000000000ffffffffffffffff0000000000000000ffffffffffffffff)
            x := and(or(shl(32, x), x), 0x00000000ffffffff00000000ffffffff00000000ffffffff00000000ffffffff)
            x := and(or(shl(16, x), x), 0x0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff)
            x := and(or(shl(8, x), x), 0x00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff)
            x := and(or(shl(4, x), x), 0x0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f)
            let gt9 := and(shr(4, add(x, 0x0606060606060606060606060606060606060606060606060606060606060606)),
                0x0101010101010101010101010101010101010101010101010101010101010101)
            x := add(add(x, 0x3030303030303030303030303030303030303030303030303030303030303030), mul(gt9, 0x27))
        }
    }
}
