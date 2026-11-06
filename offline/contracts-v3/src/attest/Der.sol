// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Der -- minimal, bounds-checked DER reader over `bytes memory` (offsets, no copies)
/// @notice Enough of X.690 for X.509 certificates and the Android KeyDescription:
///  high-tag-number form (e.g. [704] = BF 85 40) and definite lengths of up to 3 length bytes.
///  Indefinite lengths (BER) are rejected; DER forbids them.
library Der {
    error DerOutOfBounds();
    error DerBadLength();
    error DerUnexpectedTag(uint256 want, uint256 got);

    /// @dev Unchecked single byte read; callers bound-check.
    function u8(bytes memory d, uint256 i) internal pure returns (uint256 v) {
        assembly ("memory-safe") {
            v := byte(0, mload(add(add(d, 32), i)))
        }
    }

    /// @notice Reads the TLV header at `i`.
    /// @return b0 identifier byte (class | constructed | low tag), tag the tag NUMBER (high-tag form decoded),
    ///  cs content start, len content length.
    function read(bytes memory d, uint256 i) internal pure returns (uint256 b0, uint256 tag, uint256 cs, uint256 len) {
        uint256 n = d.length;
        if (i + 2 > n) revert DerOutOfBounds();
        b0 = u8(d, i++);
        tag = b0 & 0x1f;
        if (tag == 0x1f) {
            tag = 0;
            for (uint256 k = 0;; k++) {
                if (k == 4 || i >= n) revert DerOutOfBounds();
                uint256 x = u8(d, i++);
                tag = (tag << 7) | (x & 0x7f);
                if (x & 0x80 == 0) break;
            }
        }
        if (i >= n) revert DerOutOfBounds();
        uint256 l = u8(d, i++);
        if (l & 0x80 != 0) {
            uint256 k = l & 0x7f;
            if (k == 0 || k > 3 || i + k > n) revert DerBadLength();
            l = 0;
            for (; k > 0; k--) l = (l << 8) | u8(d, i++);
        }
        cs = i;
        len = l;
        if (cs + len > n) revert DerOutOfBounds();
    }

    /// @notice Reads a TLV and requires its identifier byte to be `want`.
    function expect(bytes memory d, uint256 i, uint256 want) internal pure returns (uint256 cs, uint256 len) {
        uint256 b0;
        (b0,, cs, len) = read(d, i);
        if (b0 != want) revert DerUnexpectedTag(want, b0);
    }

    /// @notice Unsigned big-endian integer of up to 32 content bytes (a leading 0x00 sign byte is fine).
    function uintAt(bytes memory d, uint256 cs, uint256 len) internal pure returns (uint256 v) {
        if (len > 33 || (len == 33 && u8(d, cs) != 0)) revert DerBadLength();
        for (uint256 k = 0; k < len; k++) v = (v << 8) | u8(d, cs + k);
    }

    /// @notice First min(len, 32) content bytes, left-aligned.
    function word(bytes memory d, uint256 cs, uint256 len) internal pure returns (bytes32 w) {
        assembly ("memory-safe") {
            w := mload(add(add(d, 32), cs))
        }
        if (len < 32) w &= bytes32(type(uint256).max << (8 * (32 - len)));
    }

    function slice(bytes memory d, uint256 start, uint256 len) internal pure returns (bytes memory out) {
        out = new bytes(len);
        assembly ("memory-safe") {
            mcopy(add(out, 32), add(add(d, 32), start), len)
        }
    }

    function keccakSlice(bytes memory d, uint256 start, uint256 len) internal pure returns (bytes32 h) {
        assembly ("memory-safe") {
            h := keccak256(add(add(d, 32), start), len)
        }
    }

    function sha256Slice(bytes memory d, uint256 start, uint256 len) internal view returns (bytes32 h) {
        assembly ("memory-safe") {
            if iszero(staticcall(gas(), 0x02, add(add(d, 32), start), len, 0x00, 32)) { revert(0, 0) }
            h := mload(0x00)
        }
    }

    /// @notice UTCTime (YYMMDDHHMMSSZ, years 1950-2049) or GeneralizedTime (YYYYMMDDHHMMSSZ) -> unix seconds.
    function time(bytes memory d, uint256 i) internal pure returns (uint64 t, uint256 next) {
        (uint256 b0,, uint256 cs, uint256 len) = read(d, i);
        next = cs + len;
        uint256 y;
        uint256 p = cs;
        if (b0 == 0x17 && len == 13) {
            y = _dd(d, p);
            y += y < 50 ? 2000 : 1900;
            p += 2;
        } else if (b0 == 0x18 && len == 15) {
            y = _dd(d, p) * 100 + _dd(d, p + 2);
            p += 4;
        } else {
            revert DerUnexpectedTag(0x17, b0);
        }
        if (u8(d, p + 10) != 0x5a) revert DerBadLength(); // 'Z'
        uint256 days_ = _daysFromCivil(y, _dd(d, p), _dd(d, p + 2));
        t = uint64(days_ * 86400 + _dd(d, p + 4) * 3600 + _dd(d, p + 6) * 60 + _dd(d, p + 8));
    }

    function _dd(bytes memory d, uint256 p) private pure returns (uint256) {
        uint256 a = u8(d, p);
        uint256 b = u8(d, p + 1);
        if (a < 48 || a > 57 || b < 48 || b > 57) revert DerBadLength();
        return (a - 48) * 10 + (b - 48);
    }

    /// @dev Howard Hinnant's days_from_civil, for years >= 1970.
    function _daysFromCivil(uint256 y, uint256 m, uint256 dd) private pure returns (uint256) {
        if (m <= 2) y -= 1;
        uint256 era = y / 400;
        uint256 yoe = y - era * 400;
        uint256 mp = m > 2 ? m - 3 : m + 9;
        uint256 doy = (153 * mp + 2) / 5 + dd - 1;
        uint256 doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        return era * 146097 + doe - 719468;
    }
}
