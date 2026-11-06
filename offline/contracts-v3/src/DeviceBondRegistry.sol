// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AndroidAttestation as AA} from "./attest/AndroidAttestation.sol";
import {Der} from "./attest/Der.sol";
import {IP384Verifier} from "nitro/IP384Verifier.sol";

interface IBrokenKeys {
    function brokenKey(bytes32 keyHash) external view returns (bool);
}

/// @title DeviceBondRegistry -- trustless device bonds for Prowl one-time keys, slashed on equivocation
/// @notice Trust anchors are Google's attestation roots, pinned at deployment. Everything below them is
///  verified on-chain from the REAL certificate formats:
///   * `cacheIssuer`: permissionless; verifies an intermediate CA certificate against an already trusted
///     parent (RSA-4096 via MODEXP, P-384 via the hinted verifier, P-256 via P256VERIFY) and caches its key;
///   * `registerAttestationKey`: same for the attestation key (AK) certificate that signs one-time keys:
///     RKP: the per-device, per-app, ~2-week AK under "Droid CA3"; factory: the StrongBox batch key;
///   * `bond`: posts ETH against an AK, with proof of possession (a fresh key attested by that AK whose
///     attestationChallenge commits to the bonder's address);
///   * `slash`: anyone shows that a key attested by the AK equivocated (escrow.brokenKey); the bond is
///     forfeited and the AK blacklisted.
///  `governanceRegisterIssuer` is the cheap, trusted alternative to `cacheIssuer` (measured for comparison).
contract DeviceBondRegistry {
    using Der for bytes;

    enum Kind {
        None,
        P256,
        P384,
        RSA
    }

    struct Issuer {
        Kind kind;
        uint8 depth; // 0 = pinned root
        uint64 notAfter;
        bool revoked;
        bytes32 subjectHash; // keccak256 of the subject Name DER (to match children's issuer Name)
        bytes key; // P256: x||y (64 B), P384: x||y (96 B), RSA: modulus (e = rsaE)
        uint256 rsaE;
    }

    struct AttKey {
        bytes32 x;
        bytes32 y;
        uint64 notBefore;
        uint64 notAfter;
        bytes32 issuer;
        bool rkp; // carries the RKP provisioning-info extension (1.3.6.1.4.1.11129.2.1.30)
    }

    struct Bond {
        address owner;
        uint96 amount;
        uint64 unlockAt;
        bool slashed;
    }

    uint8 public constant MAX_ISSUER_DEPTH = 2; // RKP: CA1 -> CA2 -> CA3; factory: root -> StrongBox intermediate
    uint256 public constant REPORTER_SHARE_BPS = 1000; // 10% of a slashed bond to whoever proves it

    address public immutable governance;
    IBrokenKeys public immutable escrow;
    uint256 public immutable minBond;
    uint256 public immutable slashableAfterExpiry; // >= max coin lifetime + challenge window
    bytes32 public immutable appPackageHash; // keccak256("xyz.prawl.otktest")
    bytes32 public immutable appSignerDigest; // sha256 of the app signing certificate (0 = not enforced)
    IP384Verifier public immutable p384; // vendored hinted P-384 verifier, separate contract (EIP-170)

    mapping(bytes32 => Issuer) internal issuers; // id = sha256(SPKI DER)
    mapping(bytes32 => AttKey) public attKeys; // id = sha256(AK SPKI DER)
    mapping(bytes32 => Bond) public bonds; // by AK id
    mapping(bytes32 => bool) public blacklisted; // AK ids proven to have attested an equivocating key
    mapping(bytes32 => uint256) public compensationPool; // slashed funds per AK, for victims (distribution out of scope)

    event IssuerCached(bytes32 indexed id, bytes32 indexed parent, Kind kind, uint8 depth, uint64 notAfter, bool byGovernance);
    event AttestationKeyRegistered(bytes32 indexed ak, bytes32 indexed issuer, bool rkp, uint64 notAfter);
    event Bonded(bytes32 indexed ak, address owner, uint256 amount, uint64 unlockAt);
    event Slashed(bytes32 indexed ak, bytes32 indexed otkKey, address reporter, uint256 reward, uint256 toPool);
    event Withdrawn(bytes32 indexed ak, address owner, uint256 amount);

    error UnknownIssuer(bytes32 id);
    error IssuerUnusable(bytes32 id);
    error NameMismatch();
    error NotCA();
    error IsAttestedLeaf();
    error BadSignature();
    error OutsideValidity();
    error TooDeep();
    error AKNotP256();
    error UnknownAK(bytes32 id);
    error AKBlacklisted(bytes32 id);
    error AlreadyBonded();
    error BondTooSmall();
    error BadPossessionProof(uint256 policyFails);
    error NotBroken(bytes32 key);
    error NotOneTimeAttested(uint256 policyFails);
    error NotOwner();
    error Locked();
    error OnlyGovernance();
    error AlreadyRegistered();

    struct Config {
        address governance;
        IBrokenKeys escrow;
        uint256 minBond;
        uint256 slashableAfterExpiry;
        bytes32 appPackageHash;
        bytes32 appSignerDigest;
        IP384Verifier p384;
    }

    constructor(bytes[] memory pinnedRoots, Config memory cfg) {
        governance = cfg.governance;
        escrow = cfg.escrow;
        minBond = cfg.minBond;
        slashableAfterExpiry = cfg.slashableAfterExpiry;
        appPackageHash = cfg.appPackageHash;
        appSignerDigest = cfg.appSignerDigest;
        p384 = cfg.p384;
        for (uint256 i = 0; i < pinnedRoots.length; i++) {
            _store(pinnedRoots[i], AA.parse(pinnedRoots[i]), bytes32(0), 0, false);
        }
    }

    // ------------------------------------------------------------------ issuers

    /// @notice Permissionless: verify `cert` (an intermediate CA) against trusted `parentId` and cache its key.
    function cacheIssuer(bytes calldata cert, bytes32 parentId, bytes calldata hints) external returns (bytes32 id) {
        bytes memory d = cert;
        AA.Cert memory c = AA.parse(d);
        Issuer storage p = _verifyLink(d, c, parentId, hints);
        if (p.depth + 1 > MAX_ISSUER_DEPTH) revert TooDeep();
        if (!_isCA(d, c)) revert NotCA();
        id = _store(d, c, parentId, p.depth + 1, false);
        Issuer storage s = issuers[id];
        if (p.notAfter < s.notAfter) s.notAfter = p.notAfter;
    }

    /// @notice Trusted shortcut: governance registers an intermediate without on-chain chain verification.
    function governanceRegisterIssuer(bytes calldata cert, uint8 depth) external returns (bytes32 id) {
        if (msg.sender != governance) revert OnlyGovernance();
        bytes memory d = cert;
        id = _store(d, AA.parse(d), bytes32(0), depth, true);
    }

    function revokeIssuer(bytes32 id) external {
        if (msg.sender != governance) revert OnlyGovernance();
        issuers[id].revoked = true;
    }

    function issuer(bytes32 id) external view returns (Kind kind, uint8 depth, uint64 notAfter, bool revoked, bytes32 subjectHash) {
        Issuer storage s = issuers[id];
        return (s.kind, s.depth, s.notAfter, s.revoked, s.subjectHash);
    }

    // ------------------------------------------------------------------ attestation keys (device identity)

    /// @notice Permissionless: verify the attestation-key certificate against a trusted issuer and record it.
    function registerAttestationKey(bytes calldata akCert, bytes32 issuerId, bytes calldata hints)
        external
        returns (bytes32 akId)
    {
        bytes memory d = akCert;
        AA.Cert memory c = AA.parse(d);
        _verifyLink(d, c, issuerId, hints);
        if (!_isCA(d, c)) revert NotCA();
        (uint256 size,) = AA.ecKey(d, c);
        if (size != 32) revert AKNotP256();
        akId = AA.spkiHash(d, c);
        if (attKeys[akId].notAfter != 0) revert AlreadyRegistered();
        (bytes32 x, bytes32 y) = AA.p256Key(d, c);
        (, uint256 pl) = AA.findExtension(d, c, AA.OID_PROV_INFO, 10);
        uint64 na = c.notAfter;
        uint64 ina = issuers[issuerId].notAfter;
        if (ina < na) na = ina;
        attKeys[akId] = AttKey(x, y, c.notBefore, na, issuerId, pl != 0);
        emit AttestationKeyRegistered(akId, issuerId, pl != 0, na);
    }

    /// @notice Is `leaf` an acceptable Prowl one-time key attested by registered, non-blacklisted AK `akId`?
    /// @dev Returns the one-time key (x, y), its SPKI sha256 keyHash (= the phone's leafHash) and the OTK policy fail bitmask.
    function checkOtk(bytes calldata leaf, bytes32 akId)
        public
        view
        returns (bytes32 x, bytes32 y, bytes32 keyHash, uint256 fails)
    {
        AttKey storage ak = attKeys[akId];
        if (ak.notAfter == 0) revert UnknownAK(akId);
        if (blacklisted[akId]) revert AKBlacklisted(akId);
        if (issuers[ak.issuer].revoked) revert IssuerUnusable(ak.issuer);
        if (block.timestamp < ak.notBefore || block.timestamp > ak.notAfter) revert OutsideValidity();
        bytes memory d = leaf;
        AA.Cert memory c = AA.parse(d);
        if (!AA.verifiedByP256(d, c, ak.x, ak.y)) revert BadSignature();
        fails = AA.otkPolicy(AA.keyDescription(d, c), appPackageHash, appSignerDigest);
        keyHash = AA.spkiHash(d, c);
        (x, y) = AA.p256Key(d, c);
    }

    // ------------------------------------------------------------------ bonds

    /// @notice The attestationChallenge a device must put in its proof-of-possession key to bond as `owner`.
    function expectedChallenge(address owner) public view virtual returns (bytes32) {
        return keccak256(abi.encode("PRAWL-BOND-v1", block.chainid, address(this), owner));
    }

    /// @notice Bond the device behind attestation key `akId`. `popLeaf`: a key freshly attested by that AK
    ///  whose attestationChallenge (32 bytes) == expectedChallenge(msg.sender). Only software running in the
    ///  app on that device can obtain such a certificate, so a stranger who merely copied the public AK
    ///  certificate from a payment cannot bond (or squat) it.
    function bond(bytes32 akId, bytes calldata popLeaf) external payable {
        if (msg.value < minBond || msg.value > type(uint96).max) revert BondTooSmall();
        Bond storage b = bonds[akId];
        if (b.owner != address(0)) revert AlreadyBonded();
        (,,, uint256 fails) = checkOtk(popLeaf, akId);
        bytes memory d = popLeaf;
        AA.KeyDesc memory k = AA.keyDescription(d, AA.parse(d));
        bytes32 want = expectedChallenge(msg.sender);
        if (fails != 0 || k.challengeLen != 32 || k.challengeHash != keccak256(abi.encodePacked(want))) {
            revert BadPossessionProof(fails);
        }
        uint64 unlockAt = uint64(uint256(attKeys[akId].notAfter) + slashableAfterExpiry);
        bonds[akId] = Bond(msg.sender, uint96(msg.value), unlockAt, false);
        emit Bonded(akId, msg.sender, msg.value, unlockAt);
    }

    /// @notice Anyone: `leaf` is attested by `akId` AS A ONE-TIME KEY (OTK policy passes) and its key is proven
    ///  (in the escrow) to have signed two different messages. Blacklists the AK and forfeits its bond (10% to the reporter, rest to the pool).
    function slash(bytes calldata leaf, bytes32 akId) external {
        AttKey storage ak = attKeys[akId];
        if (ak.notAfter == 0) revert UnknownAK(akId);
        bytes memory d = leaf;
        AA.Cert memory c = AA.parse(d);
        // validity is NOT checked here: equivocation evidence stays good after the AK expires
        if (!AA.verifiedByP256(d, c, ak.x, ak.y)) revert BadSignature();
        // Only a key the AK vouched for as a Prowl ONE-TIME key is evidence against the AK. A multi-use key
        // (e.g. the real e1 "cheat" key, no usageCountLimit) may legitimately sign twice; without this check
        // anyone could blacklist an honest attestation key by double-signing with an ordinary key.
        uint256 fails = AA.otkPolicy(AA.keyDescription(d, c), appPackageHash, appSignerDigest);
        if (fails != 0) revert NotOneTimeAttested(fails);
        bytes32 kh = AA.spkiHash(d, c);
        if (!escrow.brokenKey(kh)) revert NotBroken(kh);
        blacklisted[akId] = true;
        Bond storage b = bonds[akId];
        uint256 reward;
        uint256 rest;
        if (b.owner != address(0) && !b.slashed) {
            b.slashed = true;
            reward = uint256(b.amount) * REPORTER_SHARE_BPS / 10_000;
            rest = uint256(b.amount) - reward;
            compensationPool[akId] += rest;
            (bool ok,) = msg.sender.call{value: reward}("");
            require(ok, "reward");
        }
        emit Slashed(akId, kh, msg.sender, reward, rest);
    }

    function withdraw(bytes32 akId) external {
        Bond storage b = bonds[akId];
        if (b.owner != msg.sender) revert NotOwner();
        if (b.slashed || block.timestamp < b.unlockAt) revert Locked();
        uint256 amt = b.amount;
        b.amount = 0;
        b.slashed = true; // closed
        (bool ok,) = msg.sender.call{value: amt}("");
        require(ok, "withdraw");
        emit Withdrawn(akId, msg.sender, amt);
    }

    // ------------------------------------------------------------------ internals

    function _verifyLink(bytes memory d, AA.Cert memory c, bytes32 parentId, bytes calldata hints)
        internal
        view
        returns (Issuer storage p)
    {
        p = issuers[parentId];
        if (p.kind == Kind.None) revert UnknownIssuer(parentId);
        if (p.revoked || block.timestamp > p.notAfter) revert IssuerUnusable(parentId);
        if (d.keccakSlice(c.issuerStart, c.issuerLen) != p.subjectHash) revert NameMismatch();
        if (block.timestamp < c.notBefore || block.timestamp > c.notAfter) revert OutsideValidity();
        if (AA.hasKeyDescription(d, c)) revert IsAttestedLeaf();
        bool ok;
        if (p.kind == Kind.P256) {
            bytes memory k = p.key;
            bytes32 x;
            bytes32 y;
            assembly ("memory-safe") {
                x := mload(add(k, 32))
                y := mload(add(k, 64))
            }
            ok = AA.verifiedByP256(d, c, x, y);
        } else if (p.kind == Kind.P384) {
            ok = AA.verifiedByP384(p384, d, c, p.key, hints);
        } else {
            ok = AA.verifiedByRsa(d, c, p.key, p.rsaE);
        }
        if (!ok) revert BadSignature();
    }

    function _store(bytes memory d, AA.Cert memory c, bytes32 parentId, uint8 depth, bool byGov)
        internal
        returns (bytes32 id)
    {
        id = AA.spkiHash(d, c);
        Issuer storage s = issuers[id];
        if (s.kind != Kind.None) revert AlreadyRegistered();
        s.depth = depth;
        s.notAfter = c.notAfter;
        s.subjectHash = d.keccakSlice(c.subjectStart, c.subjectLen);
        if (_isRsa(d, c)) {
            (s.key, s.rsaE) = AA.rsaKey(d, c);
            s.kind = Kind.RSA;
        } else {
            (uint256 size, uint256 xs) = AA.ecKey(d, c);
            s.key = d.slice(xs, 2 * size);
            s.kind = size == 32 ? Kind.P256 : Kind.P384;
        }
        emit IssuerCached(id, parentId, s.kind, depth, c.notAfter, byGov);
    }

    function _isRsa(bytes memory d, AA.Cert memory c) private pure returns (bool) {
        (uint256 cs,) = d.expect(c.spkiStart, 0x30);
        (uint256 acs,) = d.expect(cs, 0x30);
        (uint256 ocs, uint256 olen) = d.expect(acs, 0x06);
        return olen == 9 && d.word(ocs, olen) == AA.OID_RSA;
    }

    /// @dev basicConstraints (2.5.29.19) present with cA = TRUE.
    function _isCA(bytes memory d, AA.Cert memory c) private pure returns (bool) {
        (uint256 vs, uint256 vl) = AA.findExtension(d, c, bytes32(hex"551d13"), 3);
        if (vl == 0) return false;
        (uint256 cs, uint256 len) = d.expect(vs, 0x30);
        if (len == 0 || d.u8(cs) != 0x01) return false;
        (, , uint256 bcs, uint256 bl) = d.read(cs);
        return bl == 1 && d.u8(bcs) != 0;
    }
}
