// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title PrawlCodec -- byte-exact re-implementation of the phone's hop format (WalletActivity.java)
/// @notice Phone side (Java):
///   leafHash(key) = sha256hex(SubjectPublicKeyInfo DER of the P-256 key)
///   mintHash      = sha256hex(UTF8(coinId + "|" + value + "|" + leafHash(k0)))
///   hop i message = UTF8("PRAWL-OTK-v1|" + coinId + "|" + value + "|" + i + "|" + prevHash + "|" + leafHash(to))
///   prevHash      = mintHash for i = 0, else sha256hex(DER signature bytes of hop i-1)
///   signature     = SHA256withECDSA, DER encoded, s may be high.
/// "sha256hex" is lowercase hex without 0x (OtkVerify.sha256Hex uses "%02x").
library PrawlCodec {
    /// @dev DER prefix of a named-curve (prime256v1) uncompressed SubjectPublicKeyInfo, up to and
    ///  including the BIT STRING header and its 0 unused-bits byte. Java's PublicKey.getEncoded() for
    ///  an Android Keystore EC key is exactly this || 0x04 || x || y (checked for every vector by
    ///  tools/vectors_to_foundry.py).
    bytes constant SPKI_P256_PREFIX = hex"3059301306072a8648ce3d020106082a8648ce3d030107034200";

    /// @notice sha256 of the key's SPKI DER: the phone's leafHash, used as the key's identity everywhere.
    function keyHash(bytes32 x, bytes32 y) internal pure returns (bytes32) {
        return sha256(abi.encodePacked(SPKI_P256_PREFIX, bytes1(0x04), x, y));
    }

    /// @notice 32 bytes -> 64 lowercase ASCII hex chars, branch-free (nibble spreading).
    function hex32(bytes32 v) internal pure returns (bytes memory out) {
        out = new bytes(64);
        assembly ("memory-safe") {
            function spread(h) -> x {
                // h: 16 bytes in the low 128 bits -> 32 bytes, each holding one nibble, MSB first
                x := h
                x := and(or(shl(64, x), x), 0x0000000000000000ffffffffffffffff0000000000000000ffffffffffffffff)
                x := and(or(shl(32, x), x), 0x00000000ffffffff00000000ffffffff00000000ffffffff00000000ffffffff)
                x := and(or(shl(16, x), x), 0x0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff0000ffff)
                x := and(or(shl(8, x), x), 0x00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff)
                x := and(or(shl(4, x), x), 0x0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f)
                // nibble -> ascii: '0'+n, plus 0x27 more for n > 9 ('a' = 0x61 = 0x30 + 10 + 0x27)
                let gt9 := and(shr(4, add(x, 0x0606060606060606060606060606060606060606060606060606060606060606)),
                    0x0101010101010101010101010101010101010101010101010101010101010101)
                x := add(add(x, 0x3030303030303030303030303030303030303030303030303030303030303030), mul(gt9, 0x27))
            }
            mstore(add(out, 32), spread(shr(128, v)))
            mstore(add(out, 64), spread(and(v, 0xffffffffffffffffffffffffffffffff)))
        }
    }

    /// @notice 20-byte address -> 40 lowercase hex chars (no 0x).
    function hexAddr(address a) internal pure returns (bytes memory out) {
        bytes memory h = hex32(bytes32(uint256(uint160(a))));
        out = new bytes(40);
        for (uint256 i = 0; i < 40; i++) out[i] = h[24 + i];
    }

    /// @notice Decimal ASCII of an unsigned integer (Java's int-to-string for hop indexes).
    function dec(uint256 v) internal pure returns (bytes memory out) {
        if (v == 0) return "0";
        uint256 len;
        for (uint256 t = v; t != 0; t /= 10) len++;
        out = new bytes(len);
        for (; v != 0; v /= 10) out[--len] = bytes1(uint8(48 + (v % 10)));
    }

    /// @notice Canonical DER ECDSA-Sig-Value: SEQUENCE { INTEGER r, INTEGER s }, minimal encoding.
    /// @dev Java's SHA256withECDSA emits strict DER (re-encoding equals the phone bytes for all vectors).
    function derSig(bytes32 r, bytes32 s) internal pure returns (bytes memory) {
        bytes memory ri = _derInt(r);
        bytes memory si = _derInt(s);
        return abi.encodePacked(bytes1(0x30), bytes1(uint8(ri.length + si.length)), ri, si);
    }

    function _derInt(bytes32 v) private pure returns (bytes memory out) {
        uint256 lz;
        while (lz < 31 && v[lz] == 0) lz++;
        bool pad = uint8(v[lz]) >= 0x80;
        uint256 n = 32 - lz + (pad ? 1 : 0);
        out = new bytes(n + 2);
        out[0] = 0x02;
        out[1] = bytes1(uint8(n));
        uint256 o = pad ? 3 : 2;
        for (uint256 i = lz; i < 32; i++) out[o++] = v[i];
    }

    /// @notice The exact bytes the phone signs for hop `i`.
    function hopMessage(bytes memory coinId, bytes memory value, uint256 i, bytes32 prev, bytes32 toHash)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked("PRAWL-OTK-v1|", coinId, "|", value, "|", dec(i), "|", hex32(prev), "|", hex32(toHash));
    }

    function mintHash(bytes memory coinId, bytes memory value, bytes32 k0Hash) internal pure returns (bytes32) {
        return sha256(abi.encodePacked(coinId, "|", value, "|", hex32(k0Hash)));
    }

    /// @notice The "to" field of a redemption: the tip key pays the coin to an Ethereum payout address.
    /// @dev A 64-hex sha256 like a key hash, so the phone signs it with its unchanged hopMessage():
    ///  sha256(UTF8("PRAWL-REDEEM|" + chainId + "|" + escrowHex40 + "|" + payoutHex40)). Not yet on the phones.
    function redeemTarget(uint256 chainId, address escrow, address payout) internal pure returns (bytes32) {
        return sha256(abi.encodePacked("PRAWL-REDEEM|", dec(chainId), "|", hexAddr(escrow), "|", hexAddr(payout)));
    }

    /// @notice Validates and converts a canonical decimal ETH string ("0.2", "1", "12.5") to wei.
    ///  Canonical = no sign, no leading zeros (except a lone "0" before the point), no trailing zeros
    ///  in the fraction, at most 18 fraction digits. The phone signs the string, so the string is what
    ///  is stored; canonical form keeps one value = one string for the phones' snapshot equality.
    function parseEther(bytes memory v) internal pure returns (bool ok, uint256 wei_) {
        uint256 n = v.length;
        if (n == 0 || n > 40) return (false, 0);
        uint256 i;
        uint256 intPart;
        uint256 intDigits;
        for (; i < n && v[i] != "."; i++) {
            uint8 c = uint8(v[i]);
            if (c < 48 || c > 57) return (false, 0);
            intPart = intPart * 10 + (c - 48);
            intDigits++;
        }
        if (intDigits == 0 || (intDigits > 1 && v[0] == "0")) return (false, 0);
        uint256 frac;
        uint256 fracDigits;
        if (i < n) {
            i++; // '.'
            for (; i < n; i++) {
                uint8 c = uint8(v[i]);
                if (c < 48 || c > 57) return (false, 0);
                frac = frac * 10 + (c - 48);
                fracDigits++;
            }
            if (fracDigits == 0 || fracDigits > 18 || v[n - 1] == "0") return (false, 0);
        }
        wei_ = intPart * 1e18 + frac * (10 ** (18 - fracDigits));
        ok = wei_ > 0;
    }

    /// @notice coinId charset [0-9A-Za-z._-], 1..64 bytes. Excluding '|' prevents delimiter injection:
    ///  ("a|1","2") and ("a","1|2") would otherwise produce byte-identical hop messages.
    function validCoinId(bytes memory id) internal pure returns (bool) {
        if (id.length == 0 || id.length > 64) return false;
        for (uint256 i = 0; i < id.length; i++) {
            uint8 c = uint8(id[i]);
            bool ok = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c == 46 || c == 95
                || c == 45;
            if (!ok) return false;
        }
        return true;
    }
}
