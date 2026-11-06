// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title BLS12-381 helpers on the EIP-2537 precompiles (Prague / Pectra).
/// @notice min_sig ciphersuite: signatures in G1 (48 B compressed, 128 B EIP-2537
///         encoded), public keys in G2. Hash-to-G1 is RFC 9380
///         BLS12381G1_XMD:SHA-256_SSWU_RO_, built from SHA-256 + MODEXP (mod p)
///         + MAP_FP_TO_G1 (which includes cofactor clearing) + G1ADD.
library BLS {
    address constant G1ADD = address(0x0b);
    address constant G2ADD = address(0x0d);
    address constant PAIRING = address(0x0f);
    address constant MAP_FP_TO_G1 = address(0x10);
    address constant MODEXP = address(0x05);
    bytes constant P =
        hex"1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaab";

    function slice(bytes memory b, uint256 s, uint256 l) internal pure returns (bytes memory r) {
        r = new bytes(l);
        assembly ("memory-safe") {
            mcopy(add(r, 32), add(add(b, 32), s), l)
        }
    }

    /// RFC 9380 expand_message_xmd with SHA-256, len_in_bytes = 128 (two Fp elements).
    function expandMsgXmd(bytes memory m, bytes memory dst) internal pure returns (bytes memory) {
        bytes memory dstPrime = abi.encodePacked(dst, uint8(dst.length));
        bytes32 b0 = sha256(abi.encodePacked(new bytes(64), m, uint16(128), uint8(0), dstPrime));
        bytes32 b1 = sha256(abi.encodePacked(b0, uint8(1), dstPrime));
        bytes32 b2 = sha256(abi.encodePacked(b0 ^ b1, uint8(2), dstPrime));
        bytes32 b3 = sha256(abi.encodePacked(b0 ^ b2, uint8(3), dstPrime));
        bytes32 b4 = sha256(abi.encodePacked(b0 ^ b3, uint8(4), dstPrime));
        return abi.encodePacked(b1, b2, b3, b4);
    }

    /// Reduce a 64-byte big-endian integer mod p and return the 64-byte EIP-2537 Fp encoding.
    function modP(bytes memory x64) internal view returns (bytes memory) {
        (bool ok, bytes memory r) =
            MODEXP.staticcall(abi.encodePacked(uint256(64), uint256(1), uint256(48), x64, uint8(1), P));
        require(ok && r.length == 48, "modexp");
        return abi.encodePacked(bytes16(0), r);
    }

    function hashToG1(bytes memory m, bytes memory dst) internal view returns (bytes memory) {
        bytes memory u = expandMsgXmd(m, dst);
        (bool ok0, bytes memory q0) = MAP_FP_TO_G1.staticcall(modP(slice(u, 0, 64)));
        (bool ok1, bytes memory q1) = MAP_FP_TO_G1.staticcall(modP(slice(u, 64, 64)));
        require(ok0 && ok1, "map");
        (bool ok, bytes memory r) = G1ADD.staticcall(abi.encodePacked(q0, q1));
        require(ok, "g1add");
        return r;
    }

    function g2Add(bytes memory a, bytes memory b) internal view returns (bytes memory r) {
        bool ok;
        (ok, r) = G2ADD.staticcall(abi.encodePacked(a, b));
        require(ok, "g2add");
    }

    /// e(sig, -g2) * e(H(m), apk) == 1. PAIRING_CHECK also subgroup-checks sig and apk.
    function verify(bytes memory sig, bytes memory apk, bytes memory m, bytes memory dst, bytes memory negG2)
        internal
        view
        returns (bool)
    {
        bytes memory hm = hashToG1(m, dst);
        (bool ok, bytes memory r) = PAIRING.staticcall(abi.encodePacked(sig, negG2, hm, apk));
        return ok && r.length == 32 && uint256(bytes32(r)) == 1;
    }
}

/// @title LockWitnessRegistry: bonded lock witnesses + equivocation slashing.
/// @notice A lock certificate is (epoch, nf, h, bitmap, aggSig) where aggSig is the
///         aggregate BLS signature of the committee members in `bitmap` on
///         "PRAWL.LOCK.v1" || epoch || nf || h. Two valid certificates with the same
///         (epoch, nf) and different h prove that every member of bitmapA & bitmapB
///         signed both (multi-signature unforgeability with proofs of possession),
///         so all of them are slashed. Honest witnesses never sign two h for one nf.
contract LockWitnessRegistry {
    struct Committee {
        bytes32 pkHash; // keccak256(abi.encode(pks)) for this epoch
        uint32 n;
        uint32 q;
    }

    bytes public negG2;
    bytes public constant DST = "BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_POP_";
    bytes public constant POP_DST = "BLS_POP_BLS12381G1_XMD:SHA-256_SSWU_RO_POP_";

    mapping(bytes32 => uint256) public bondOf; // keccak(pk) -> wei
    mapping(bytes32 => bool) public isSlashed;
    mapping(uint64 => Committee) public committees;
    mapping(bytes32 => bool) public evidenceUsed;
    uint256 public victimPool;

    event WitnessRegistered(bytes32 indexed id, uint256 bond);
    event CommitteeSet(uint64 indexed epoch, bytes32 pkHash, uint32 n, uint32 q);
    event Equivocation(uint64 indexed epoch, bytes32 indexed nf, uint256 slashedMask, uint256 total);

    constructor(bytes memory _negG2) {
        require(_negG2.length == 256, "negG2");
        negG2 = _negG2;
    }

    /// @notice Register a witness key with a proof of possession (rogue-key defence).
    function register(bytes calldata pk, bytes calldata pop) external payable {
        require(pk.length == 256 && pop.length == 128, "len");
        require(BLS.verify(pop, pk, pk, POP_DST, negG2), "bad PoP");
        bytes32 id = keccak256(pk);
        require(!isSlashed[id], "slashed");
        bondOf[id] += msg.value;
        emit WitnessRegistered(id, bondOf[id]);
    }

    /// @notice Demo-only committee setter. Production: committee = stake-weighted sample
    ///         from the registry with an on-chain beacon, published as pkHash per epoch.
    function setCommittee(uint64 epoch, bytes[] calldata pks, uint32 q) external {
        require(committees[epoch].pkHash == 0, "set");
        require(pks.length <= 256 && 3 * uint256(q) > 2 * pks.length, "quorum must exceed 2n/3");
        for (uint256 i; i < pks.length; ++i) {
            require(bondOf[keccak256(pks[i])] > 0, "unbonded");
        }
        bytes32 h = keccak256(abi.encode(pks));
        committees[epoch] = Committee(h, uint32(pks.length), q);
        emit CommitteeSet(epoch, h, uint32(pks.length), q);
    }

    function lockMsg(uint64 epoch, bytes32 nf, bytes32 h) public pure returns (bytes memory) {
        return abi.encodePacked("PRAWL.LOCK.v1", epoch, nf, h);
    }

    function _popcount(uint256 x) internal pure returns (uint256 c) {
        while (x != 0) {
            x &= x - 1;
            ++c;
        }
    }

    function _apk(bytes[] calldata pks, uint256 bitmap) internal view returns (bytes memory apk) {
        bool first = true;
        for (uint256 i; i < pks.length; ++i) {
            if ((bitmap >> i) & 1 == 1) {
                if (first) {
                    apk = pks[i];
                    first = false;
                } else {
                    apk = BLS.g2Add(apk, pks[i]);
                }
            }
        }
    }

    function verifyCert(
        uint64 epoch,
        bytes[] calldata pks,
        bytes32 nf,
        bytes32 h,
        uint256 bitmap,
        bytes calldata sig
    ) public view returns (bool) {
        Committee memory c = committees[epoch];
        require(c.pkHash != 0 && keccak256(abi.encode(pks)) == c.pkHash, "committee");
        if (bitmap >> c.n != 0 || _popcount(bitmap) < c.q) return false;
        return BLS.verify(sig, _apk(pks, bitmap), lockMsg(epoch, nf, h), DST, negG2);
    }

    struct Cert {
        bytes32 h;
        uint256 bitmap;
        bytes sig;
    }

    /// @notice Slash every witness in a.bitmap & b.bitmap given two conflicting certificates.
    function slashEquivocation(uint64 epoch, bytes[] calldata pks, bytes32 nf, Cert calldata a, Cert calldata b)
        external
        returns (uint256 total)
    {
        require(a.h != b.h, "not conflicting");
        bytes32 ev = keccak256(abi.encode(epoch, nf));
        require(!evidenceUsed[ev], "used");
        require(verifyCert(epoch, pks, nf, a.h, a.bitmap, a.sig), "certA");
        require(verifyCert(epoch, pks, nf, b.h, b.bitmap, b.sig), "certB");
        evidenceUsed[ev] = true;
        uint256 inter = a.bitmap & b.bitmap;
        total = _slashMask(pks, inter);
        // Demo split: 10% to the reporter, 90% to the victim pool (claims by the losing recipient).
        uint256 tip = total / 10;
        victimPool += total - tip;
        emit Equivocation(epoch, nf, inter, total);
        if (tip > 0) {
            (bool ok,) = msg.sender.call{value: tip}("");
            require(ok, "tip");
        }
    }

    function _slashMask(bytes[] calldata pks, uint256 inter) internal returns (uint256 total) {
        for (uint256 i; i < pks.length; ++i) {
            if ((inter >> i) & 1 == 1) {
                bytes32 id = keccak256(pks[i]);
                if (!isSlashed[id]) {
                    isSlashed[id] = true;
                    total += bondOf[id];
                    bondOf[id] = 0;
                }
            }
        }
    }
}
