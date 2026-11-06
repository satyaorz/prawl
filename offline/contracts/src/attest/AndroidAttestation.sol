// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Der} from "./Der.sol";
import {IP384Verifier} from "nitro/IP384Verifier.sol";
import {Sha2Ext} from "nitro/Sha2Ext.sol";

/// @title AndroidAttestation -- on-chain X.509 + Android KeyDescription parsing and chain-link verification
/// @notice Sources for the schema: source.android.com/docs/security/features/keystore/attestation
///  (KeyDescription, AuthorizationList tag numbers: purpose [1], algorithm [2], ecCurve [10],
///  usageCountLimit [405], origin [702], rootOfTrust [704], attestationApplicationId [709]).
library AndroidAttestation {
    using Der for bytes;

    // OID content bytes, left-aligned
    bytes32 internal constant OID_ECDSA_SHA256 = bytes32(hex"2a8648ce3d040302"); // 1.2.840.10045.4.3.2
    bytes32 internal constant OID_ECDSA_SHA384 = bytes32(hex"2a8648ce3d040303"); // 1.2.840.10045.4.3.3
    bytes32 internal constant OID_RSA_SHA256 = bytes32(hex"2a864886f70d01010b"); // 1.2.840.113549.1.1.11
    bytes32 internal constant OID_EC_PUBKEY = bytes32(hex"2a8648ce3d0201"); // 1.2.840.10045.2.1
    bytes32 internal constant OID_P256 = bytes32(hex"2a8648ce3d030107"); // prime256v1
    bytes32 internal constant OID_P384 = bytes32(hex"2b81040022"); // secp384r1
    bytes32 internal constant OID_RSA = bytes32(hex"2a864886f70d010101"); // rsaEncryption
    bytes32 internal constant OID_KEY_DESC = bytes32(hex"2b06010401d679020111"); // 1.3.6.1.4.1.11129.2.1.17
    bytes32 internal constant OID_PROV_INFO = bytes32(hex"2b06010401d67902011e"); // 1.3.6.1.4.1.11129.2.1.30

    error BadCert(uint256 code);
    error WrongSigAlg(bytes32 oid);

    /// @notice Offsets into one DER certificate (no copies). *Start/*Len of issuer/subject/spki/tbs are full TLVs.
    struct Cert {
        uint256 tbsStart;
        uint256 tbsLen;
        bytes32 sigAlg;
        uint256 sigStart; // BIT STRING content after the unused-bits byte
        uint256 sigLen;
        uint256 issuerStart;
        uint256 issuerLen;
        uint256 subjectStart;
        uint256 subjectLen;
        uint256 spkiStart;
        uint256 spkiLen;
        uint64 notBefore;
        uint64 notAfter;
        uint256 extStart; // content of the Extensions SEQUENCE (0 if none)
        uint256 extLen;
    }

    /// @notice Fields of the KeyDescription that matter for a Prawl one-time key.
    struct KeyDesc {
        uint256 attestationVersion;
        uint256 attestationSecurityLevel; // 0 Software, 1 TrustedEnvironment, 2 StrongBox
        uint256 keyMintSecurityLevel;
        bytes32 challengeHash; // keccak256 of attestationChallenge
        uint256 challengeLen;
        uint256 usageCountLimitHw; // [405] in hardwareEnforced (0 = absent)
        bool usageCountLimitInSw; // [405] present in softwareEnforced
        bool hasRootOfTrust;
        bool deviceLocked;
        uint256 verifiedBootState; // 0 Verified
        bytes32 verifiedBootKey;
        uint256 origin; // [702]; 0 GENERATED; type(uint256).max = absent
        bool purposeSign; // [1] contains 2 (SIGN)
        uint256 algorithm; // [2]; 3 = EC
        uint256 ecCurve; // [10]; 1 = P_256
        bytes32 packageNameHash; // keccak256 of first package_name in attestationApplicationId [709]
        uint256 packageVersion;
        bytes32 signatureDigest; // first signature_digests entry (SHA-256 of the app signing cert)
    }

    // ------------------------------------------------------------------ certificate structure

    function parse(bytes memory d) internal pure returns (Cert memory c) {
        (uint256 cs, uint256 len) = d.expect(0, 0x30); // Certificate
        if (cs + len != d.length) revert BadCert(1);
        (uint256 tcs, uint256 tlen) = d.expect(cs, 0x30); // tbsCertificate
        c.tbsStart = cs;
        c.tbsLen = tcs + tlen - cs;
        (uint256 acs, uint256 alen) = d.expect(tcs + tlen, 0x30); // signatureAlgorithm
        (uint256 ocs, uint256 olen) = d.expect(acs, 0x06);
        c.sigAlg = d.word(ocs, olen);
        (uint256 scs, uint256 slen) = d.expect(acs + alen, 0x03); // signatureValue
        if (slen == 0 || d.u8(scs) != 0) revert BadCert(3);
        c.sigStart = scs + 1;
        c.sigLen = slen - 1;
        _tbs(d, tcs, tcs + tlen, c);
    }

    function _next(bytes memory d, uint256 p) private pure returns (uint256) {
        (, , uint256 cs, uint256 len) = d.read(p);
        return cs + len;
    }

    function _tbs(bytes memory d, uint256 p, uint256 tend, Cert memory c) private pure {
        if (d.u8(p) == 0xa0) p = _next(d, p); // [0] version
        p = _next(d, p); // serialNumber
        p = _next(d, p); // signature AlgorithmIdentifier
        if (d.u8(p) != 0x30) revert BadCert(4);
        c.issuerStart = p;
        p = _next(d, p);
        c.issuerLen = p - c.issuerStart;
        (uint256 vcs, uint256 vlen) = d.expect(p, 0x30); // validity
        uint256 q;
        (c.notBefore, q) = d.time(vcs);
        (c.notAfter,) = d.time(q);
        p = vcs + vlen;
        if (d.u8(p) != 0x30) revert BadCert(5);
        c.subjectStart = p;
        p = _next(d, p);
        c.subjectLen = p - c.subjectStart;
        if (d.u8(p) != 0x30) revert BadCert(6);
        c.spkiStart = p;
        p = _next(d, p);
        c.spkiLen = p - c.spkiStart;
        while (p < tend) {
            (uint256 b0,, uint256 xcs, uint256 xlen) = d.read(p);
            if (b0 == 0xa3) (c.extStart, c.extLen) = d.expect(xcs, 0x30);
            p = xcs + xlen;
        }
        if (p != tend) revert BadCert(7);
    }

    /// @notice Finds extension `oid`; returns the content of its extnValue OCTET STRING (0,0 if absent).
    function findExtension(bytes memory d, Cert memory c, bytes32 oid, uint256 oidLen)
        internal
        pure
        returns (uint256 vs, uint256 vlen)
    {
        uint256 p = c.extStart;
        uint256 end = c.extStart + c.extLen;
        while (p < end) {
            (uint256 ecs, uint256 elen) = d.expect(p, 0x30); // Extension
            p = ecs + elen;
            (uint256 ocs, uint256 olen) = d.expect(ecs, 0x06);
            if (olen == oidLen && d.word(ocs, olen) == oid) return _extValue(d, ocs + olen);
        }
    }

    /// @dev Skips the optional `critical BOOLEAN` and returns the extnValue OCTET STRING content.
    function _extValue(bytes memory d, uint256 q) private pure returns (uint256, uint256) {
        if (d.u8(q) == 0x01) {
            (, , uint256 bcs, uint256 blen) = d.read(q);
            q = bcs + blen;
        }
        return d.expect(q, 0x04);
    }

    function hasKeyDescription(bytes memory d, Cert memory c) internal pure returns (bool) {
        (, uint256 l) = findExtension(d, c, OID_KEY_DESC, 10);
        return l != 0;
    }

    // ------------------------------------------------------------------ public keys

    /// @notice EC public key from the SPKI. Returns the curve size in bytes (32 or 48) and the offset of X (Y follows).
    function ecKey(bytes memory d, Cert memory c) internal pure returns (uint256 size, uint256 xs) {
        (uint256 cs,) = d.expect(c.spkiStart, 0x30);
        (uint256 acs, uint256 alen) = d.expect(cs, 0x30); // AlgorithmIdentifier
        size = _ecCurveSize(d, acs);
        (uint256 bcs, uint256 blen) = d.expect(acs + alen, 0x03);
        if (blen != 2 + 2 * size || d.u8(bcs) != 0 || d.u8(bcs + 1) != 0x04) revert BadCert(12);
        xs = bcs + 2;
    }

    function _ecCurveSize(bytes memory d, uint256 p) private pure returns (uint256) {
        (uint256 ocs, uint256 olen) = d.expect(p, 0x06);
        if (d.word(ocs, olen) != OID_EC_PUBKEY || olen != 7) revert BadCert(10);
        (uint256 ccs, uint256 clen) = d.expect(ocs + olen, 0x06);
        bytes32 curve = d.word(ccs, clen);
        if (curve == OID_P256 && clen == 8) return 32;
        if (curve == OID_P384 && clen == 5) return 48;
        revert BadCert(11);
    }

    function p256Key(bytes memory d, Cert memory c) internal pure returns (bytes32 x, bytes32 y) {
        (uint256 size, uint256 xs) = ecKey(d, c);
        if (size != 32) revert BadCert(13);
        x = d.word(xs, 32);
        y = d.word(xs + 32, 32);
    }

    function p384Key(bytes memory d, Cert memory c) internal pure returns (bytes memory xy) {
        (uint256 size, uint256 xs) = ecKey(d, c);
        if (size != 48) revert BadCert(14);
        xy = d.slice(xs, 96);
    }

    /// @notice RSA modulus (leading zero stripped) and public exponent.
    function rsaKey(bytes memory d, Cert memory c) internal pure returns (bytes memory n, uint256 e) {
        (uint256 cs,) = d.expect(c.spkiStart, 0x30);
        (uint256 acs, uint256 alen) = d.expect(cs, 0x30);
        (uint256 ocs, uint256 olen) = d.expect(acs, 0x06);
        if (d.word(ocs, olen) != OID_RSA || olen != 9) revert BadCert(15);
        (uint256 bcs,) = d.expect(acs + alen, 0x03);
        (uint256 kcs,) = d.expect(bcs + 1, 0x30);
        return _rsaInts(d, kcs);
    }

    function _rsaInts(bytes memory d, uint256 p) private pure returns (bytes memory n, uint256 e) {
        (uint256 ncs, uint256 nlen) = d.expect(p, 0x02);
        (uint256 ecs, uint256 elen) = d.expect(ncs + nlen, 0x02);
        e = d.uintAt(ecs, elen);
        if (d.u8(ncs) == 0) n = d.slice(ncs + 1, nlen - 1);
        else n = d.slice(ncs, nlen);
    }

    /// @notice sha256 of the SubjectPublicKeyInfo DER: for a P-256 OTK this is the phone's leafHash.
    function spkiHash(bytes memory d, Cert memory c) internal view returns (bytes32) {
        return d.sha256Slice(c.spkiStart, c.spkiLen);
    }

    // ------------------------------------------------------------------ signatures (child signed by parent key)

    function _ecdsaSig(bytes memory d, Cert memory c, uint256 size) private pure returns (bytes memory rs) {
        (uint256 cs, uint256 len) = d.expect(c.sigStart, 0x30);
        if (cs + len != c.sigStart + c.sigLen) revert BadCert(20);
        (uint256 rcs, uint256 rlen) = d.expect(cs, 0x02);
        (uint256 scs, uint256 slen) = d.expect(rcs + rlen, 0x02);
        rs = new bytes(2 * size);
        _copyInt(d, rcs, rlen, rs, 0, size);
        _copyInt(d, scs, slen, rs, size, size);
    }

    function _copyInt(bytes memory d, uint256 cs, uint256 len, bytes memory out, uint256 off, uint256 size)
        private
        pure
    {
        while (len > 0 && d.u8(cs) == 0) {
            cs++;
            len--;
        }
        if (len > size) revert BadCert(21);
        for (uint256 k = 0; k < len; k++) out[off + size - len + k] = d[cs + k];
    }

    /// @notice child signed with ecdsa-with-SHA256 by a P-256 key: one P256VERIFY (EIP-7951) call.
    function verifiedByP256(bytes memory d, Cert memory c, bytes32 px, bytes32 py) internal view returns (bool ok) {
        if (c.sigAlg != OID_ECDSA_SHA256) revert WrongSigAlg(c.sigAlg);
        bytes32 h = d.sha256Slice(c.tbsStart, c.tbsLen);
        bytes memory rs = _ecdsaSig(d, c, 32);
        bytes32 r;
        bytes32 s;
        assembly ("memory-safe") {
            r := mload(add(rs, 32))
            s := mload(add(rs, 64))
        }
        return p256(h, r, s, px, py);
    }

    function p256(bytes32 h, bytes32 r, bytes32 s, bytes32 x, bytes32 y) internal view returns (bool ok) {
        assembly ("memory-safe") {
            let p := mload(0x40)
            mstore(p, h)
            mstore(add(p, 32), r)
            mstore(add(p, 64), s)
            mstore(add(p, 96), x)
            mstore(add(p, 128), y)
            mstore(0x00, 0)
            let success := staticcall(gas(), 0x100, p, 160, 0x00, 32)
            ok := and(success, and(eq(returndatasize(), 32), eq(mload(0x00), 1)))
        }
    }

    /// @notice child signed (SHA-256 or SHA-384) by a P-384 key: SHA-384 in Solidity (Sha2Ext) when needed,
    ///  then the hinted P-384 verifier (modular inverses supplied off-chain and checked on-chain). The verifier is
    ///  the vendored nitro-validator `P384Verifier`, deployed separately (as nitro-validator does) to keep callers
    ///  under the EIP-170 code-size limit.
    function verifiedByP384(IP384Verifier v, bytes memory d, Cert memory c, bytes memory pub96, bytes memory hints)
        internal
        view
        returns (bool)
    {
        bytes memory h;
        if (c.sigAlg == OID_ECDSA_SHA256) h = abi.encodePacked(d.sha256Slice(c.tbsStart, c.tbsLen));
        else if (c.sigAlg == OID_ECDSA_SHA384) h = Sha2Ext.sha384(d, c.tbsStart, c.tbsLen);
        else revert WrongSigAlg(c.sigAlg);
        return v.verifyP384SignatureWithHints(h, _ecdsaSig(d, c, 48), pub96, hints);
    }

    /// @notice child signed with sha256WithRSAEncryption (PKCS#1 v1.5) by RSA key (n, e): one MODEXP (0x05) call.
    function verifiedByRsa(bytes memory d, Cert memory c, bytes memory n, uint256 e) internal view returns (bool) {
        if (c.sigAlg != OID_RSA_SHA256) revert WrongSigAlg(c.sigAlg);
        uint256 k = n.length;
        if (c.sigLen != k) return false;
        bytes memory em = modexp(d.slice(c.sigStart, k), e, n);
        // EM = 00 01 FF..FF 00 || DigestInfo(SHA-256) || H
        bytes memory t = abi.encodePacked(hex"3031300d060960864801650304020105000420", d.sha256Slice(c.tbsStart, c.tbsLen));
        if (k < t.length + 11) return false;
        if (em[0] != 0x00 || em[1] != 0x01) return false;
        uint256 psEnd = k - t.length - 1;
        for (uint256 i = 2; i < psEnd; i++) if (em[i] != 0xff) return false;
        if (em[psEnd] != 0x00) return false;
        return Der.keccakSlice(em, psEnd + 1, t.length) == keccak256(t);
    }

    function modexp(bytes memory base, uint256 e, bytes memory m) internal view returns (bytes memory out) {
        bytes memory input = abi.encodePacked(base.length, uint256(32), m.length, base, e, m);
        out = new bytes(m.length);
        assembly ("memory-safe") {
            if iszero(staticcall(gas(), 0x05, add(input, 32), mload(input), add(out, 32), mload(m))) { revert(0, 0) }
        }
    }

    // ------------------------------------------------------------------ KeyDescription

    function keyDescription(bytes memory d, Cert memory c) internal pure returns (KeyDesc memory k) {
        (uint256 vs, uint256 vlen) = findExtension(d, c, OID_KEY_DESC, 10);
        if (vlen == 0) revert BadCert(30);
        (uint256 p, uint256 len) = d.expect(vs, 0x30);
        uint256 end = p + len;
        uint256 cs;
        (cs, len) = d.expect(p, 0x02);
        k.attestationVersion = d.uintAt(cs, len);
        (cs, len) = d.expect(cs + len, 0x0a);
        k.attestationSecurityLevel = d.uintAt(cs, len);
        (cs, len) = d.expect(cs + len, 0x02); // keyMintVersion
        (cs, len) = d.expect(cs + len, 0x0a);
        k.keyMintSecurityLevel = d.uintAt(cs, len);
        (cs, len) = d.expect(cs + len, 0x04); // attestationChallenge
        k.challengeHash = d.keccakSlice(cs, len);
        k.challengeLen = len;
        (cs, len) = d.expect(cs + len, 0x04); // uniqueId
        k.origin = type(uint256).max;
        (cs, len) = d.expect(cs + len, 0x30); // softwareEnforced
        _authList(d, cs, cs + len, k, false);
        (cs, len) = d.expect(cs + len, 0x30); // hardwareEnforced
        if (cs + len != end) revert BadCert(31);
        _authList(d, cs, cs + len, k, true);
    }

    function _authList(bytes memory d, uint256 p, uint256 end, KeyDesc memory k, bool hw) private pure {
        while (p < end) {
            (uint256 b0, uint256 tag, uint256 cs, uint256 len) = d.read(p);
            if (b0 & 0xe0 != 0xa0) revert BadCert(32); // context-specific, constructed (EXPLICIT)
            p = cs + len;
            if (tag == 405) {
                (uint256 ics, uint256 il) = d.expect(cs, 0x02);
                if (hw) k.usageCountLimitHw = d.uintAt(ics, il);
                else k.usageCountLimitInSw = true;
            } else if (!hw && tag == 709) {
                _appId(d, cs, k);
            } else if (hw) {
                _hwEntry(d, tag, cs, k);
            }
        }
    }

    function _hwEntry(bytes memory d, uint256 tag, uint256 cs, KeyDesc memory k) private pure {
        if (tag == 704) {
            _rootOfTrust(d, cs, k);
        } else if (tag == 702) {
            (uint256 ics, uint256 il) = d.expect(cs, 0x02);
            k.origin = d.uintAt(ics, il);
        } else if (tag == 1) {
            (uint256 scs, uint256 sl) = d.expect(cs, 0x31);
            uint256 end = scs + sl;
            while (scs < end) {
                (uint256 ics, uint256 il) = d.expect(scs, 0x02);
                if (d.uintAt(ics, il) == 2) k.purposeSign = true;
                scs = ics + il;
            }
        } else if (tag == 2) {
            (uint256 ics, uint256 il) = d.expect(cs, 0x02);
            k.algorithm = d.uintAt(ics, il);
        } else if (tag == 10) {
            (uint256 ics, uint256 il) = d.expect(cs, 0x02);
            k.ecCurve = d.uintAt(ics, il);
        }
    }

    /// @dev RootOfTrust ::= SEQUENCE { verifiedBootKey OCTET, deviceLocked BOOLEAN, verifiedBootState ENUM, verifiedBootHash OCTET }
    function _rootOfTrust(bytes memory d, uint256 cs, KeyDesc memory k) private pure {
        (uint256 p,) = d.expect(cs, 0x30);
        uint256 l;
        (p, l) = d.expect(p, 0x04);
        k.verifiedBootKey = d.word(p, l);
        (p, l) = d.expect(p + l, 0x01);
        k.deviceLocked = l == 1 && d.u8(p) != 0;
        (p, l) = d.expect(p + l, 0x0a);
        k.verifiedBootState = d.uintAt(p, l);
        k.hasRootOfTrust = true;
    }

    /// @dev [709] OCTET STRING { SEQUENCE { SET OF SEQUENCE { OCTET package_name, INTEGER version }, SET OF OCTET digest } }
    function _appId(bytes memory d, uint256 cs, KeyDesc memory k) private pure {
        (uint256 ocs,) = d.expect(cs, 0x04);
        (uint256 scs,) = d.expect(ocs, 0x30);
        (uint256 pcs, uint256 pl) = d.expect(scs, 0x31);
        if (pl != 0) {
            (uint256 ics,) = d.expect(pcs, 0x30);
            (uint256 ncs, uint256 nl) = d.expect(ics, 0x04);
            k.packageNameHash = d.keccakSlice(ncs, nl);
            (uint256 vcs, uint256 vl) = d.expect(ncs + nl, 0x02);
            k.packageVersion = d.uintAt(vcs, vl);
        }
        (uint256 dcs, uint256 dl) = d.expect(pcs + pl, 0x31);
        if (dl != 0) {
            (uint256 gcs, uint256 gl) = d.expect(dcs, 0x04);
            k.signatureDigest = d.word(gcs, gl);
        }
    }

    // ------------------------------------------------------------------ Prawl OTK policy

    uint256 internal constant F_LEVEL = 1 << 0; // attestation from TEE or StrongBox
    uint256 internal constant F_LEVEL_MATCH = 1 << 1; // keyMint level == attestation level
    uint256 internal constant F_USAGE_HW = 1 << 2; // usageCountLimit == 1 hardware-enforced
    uint256 internal constant F_USAGE_SW = 1 << 3; // usageCountLimit must not be software-only
    uint256 internal constant F_ORIGIN = 1 << 4; // generated inside the secure hardware
    uint256 internal constant F_PURPOSE = 1 << 5; // SIGN
    uint256 internal constant F_EC256 = 1 << 6; // EC P-256
    uint256 internal constant F_LOCKED = 1 << 7; // bootloader locked
    uint256 internal constant F_VERIFIED = 1 << 8; // verified boot state Verified
    uint256 internal constant F_PACKAGE = 1 << 9; // attestationApplicationId package
    uint256 internal constant F_SIGNER = 1 << 10; // app signing-certificate digest

    /// @return fails bitmask of failed rules (0 = acceptable Prawl one-time key). The same rules as
    ///  OtkVerify.java, minus RKP/root/revocation (those are properties of the chain, not of the leaf).
    function otkPolicy(KeyDesc memory k, bytes32 pkgHash, bytes32 signerDigest) internal pure returns (uint256 fails) {
        if (k.attestationSecurityLevel != 1 && k.attestationSecurityLevel != 2) fails |= F_LEVEL;
        if (k.attestationSecurityLevel != k.keyMintSecurityLevel) fails |= F_LEVEL_MATCH;
        if (k.usageCountLimitHw != 1) fails |= F_USAGE_HW;
        if (k.usageCountLimitInSw) fails |= F_USAGE_SW;
        if (k.origin != 0) fails |= F_ORIGIN;
        if (!k.purposeSign) fails |= F_PURPOSE;
        if (k.algorithm != 3 || k.ecCurve != 1) fails |= F_EC256;
        if (!k.hasRootOfTrust || !k.deviceLocked) fails |= F_LOCKED;
        if (!k.hasRootOfTrust || k.verifiedBootState != 0) fails |= F_VERIFIED;
        if (pkgHash != 0 && k.packageNameHash != pkgHash) fails |= F_PACKAGE;
        if (signerDigest != 0 && k.signatureDigest != signerDigest) fails |= F_SIGNER;
    }
}
