// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PrawlCodec} from "./PrawlCodec.sol";
import {PrawlV3Codec as V3} from "./PrawlV3Codec.sol";

/// @notice The part of DeviceBondRegistry that the attested deposit path needs (same interface as v2).
interface IOtkChecker {
    function checkOtk(bytes calldata leaf, bytes32 akId)
        external
        view
        returns (bytes32 x, bytes32 y, bytes32 keyHash, uint256 fails);

    function bonds(bytes32 akId) external view returns (address owner, uint96 amount, uint64 unlockAt, bool slashed);
}

/// @title PrawlEscrowV3 -- on-chain settlement of Prowl v3 offline coins (splitting + change)
/// @notice Protocol: raw/v3/SPEC.md. A coin is a deposit owned by a genesis one-time P-256 key k0. Offline,
///  each note (value, one-time key K) is spent by K signing ONE v3 spend message that creates n >= 1 output
///  notes whose values sum to the note's value. A note is redeemed when its own key signs a spend with a
///  PRAWL-REDEEM output naming (chainId, this escrow, payout) ("tip auth"). Everything is verified here with
///  the EIP-7951 P256VERIFY precompile over the exact message bytes (PrawlV3Codec).
///
///  Settlement rules (justified in RESULTS.md):
///   * Each REDEEM output is paid once, keyed by (sha256(message), outputIndex) -- malleation-proof.
///   * Every spend verified here records its signer's FIRST message (`firstMsg`). A second, different valid
///     message under the same key is equivocation: the key is marked broken and the coin is frozen.
///     Because every paid note lies in the tree of first-seen messages, and every spend in it conserves
///     value, the payouts of a coin can never exceed its deposit even before any freeze; the explicit
///     `paid <= value` counter is a second, independent guard.
///   * FROZEN-COIN RULE ("subtree freeze"): a frozen coin pays nothing through a broken key -- i.e. nothing
///     in the subtree of any key proven to have equivocated (both branches) -- but notes whose path avoids
///     every broken key stay redeemable. The remainder of a frozen coin is never returned to the depositor
///     (who could be the equivocator); after expiry + grace it goes to `compensationSink`.
///   * Redemption is open until expiry + grace; after that the depositor reclaims what is unredeemed.
///
///  STORAGE LAYOUT IS PART OF THE PROTOCOL: `deposits` must stay in slot 0 (a light-client deposit proof
///  proves storage key keccak256(abi.encode(coinId, uint256(0)))), and `coins` sits in slot 1 so that a
///  proof of keccak256(abi.encode(coinId, uint256(1))) shows a coin's paid/frozen/closed state.
contract PrawlEscrowV3 {
    // ================================================================ storage (ORDER IS NORMATIVE)

    /// @notice slot 0. coinId => keccak256(abi.encode(uint256 value, uint64 expiry, uint256 k0x, uint256 k0y,
    ///  address depositor)). Written once at deposit and never changed or deleted (a coinId is never reusable).
    mapping(bytes32 => bytes32) public deposits;

    /// @notice slot 1. Mutable per-coin state, packed into one word: paid (low 128 bits) | frozen | closed.
    mapping(bytes32 => CoinState) public coins;

    /// @notice slot 2. One-time key hash => sha256 of the first spend message it was seen signing, or BROKEN.
    mapping(bytes32 => bytes32) public firstMsg;

    /// @notice slot 3. Broken key hash => the first equivocation recorded against it.
    mapping(bytes32 => Evidence) public evidence;

    /// @notice slot 4. keccak256(abi.encode(sha256(redeem message), outputIndex)) => paid.
    mapping(bytes32 => bool) public redeemed;

    /// @notice slot 5. Payments whose push failed (payout contract reverted), withdrawable by the payee.
    mapping(address => uint256) public owed;

    /// @notice slot 6. DeviceBondRegistry for `depositAttested` (set once by the deployer).
    IOtkChecker public registry;

    // ================================================================ types

    struct CoinState {
        uint128 paid; // total paid to REDEEM outputs
        bool frozen; // an equivocation was proven inside this coin's tree
        bool closed; // reclaimed (or remainder swept) after expiry + grace
    }

    struct Evidence {
        bytes32 coinId; // coin in whose context it was proven
        bytes32 msgA; // sha256 of the first message
        bytes32 msgB; // sha256 of the conflicting message
    }

    /// @notice The coin header every holder carries; checked against `deposits[coinId]`.
    struct Header {
        bytes32 coinId;
        uint256 value;
        uint64 expiry;
        uint256 k0x;
        uint256 k0y;
        address depositor;
    }

    /// @notice One spend on the path from genesis to the note being redeemed.
    ///  `index` is the output the path follows; (nextX, nextY) is that output's one-time key.
    struct Spend {
        V3.Output[] outputs;
        uint256 index;
        bytes32 r;
        bytes32 s;
        bytes32 nextX;
        bytes32 nextY;
    }

    /// @notice The final spend, signed by the redeemed note's own key; outputs[index] is a PRAWL-REDEEM output for `payout`.
    struct Redemption {
        V3.Output[] outputs;
        uint256 index;
        address payout;
        bytes32 r;
        bytes32 s;
    }

    /// @notice A raw message and a P-256 signature over sha256(message).
    struct Signed {
        bytes message;
        bytes32 r;
        bytes32 s;
    }

    /// @dev Running state of a path walk (memory: keeps the legacy code generator's stack small).
    struct Walk {
        bytes prefix;
        bytes32 x;
        bytes32 y;
        bytes32 kh;
        uint256 value;
        bytes32 noteId;
        uint256 depth;
    }

    // ================================================================ constants / immutables

    address internal constant P256VERIFY = address(0x100);
    /// @dev firstMsg sentinel for a key proven to have signed two different messages (no sha256 output is 1).
    bytes32 internal constant BROKEN = bytes32(uint256(1));

    uint8 internal constant REC_OK = 0;
    uint8 internal constant REC_CONFLICT = 1; // new equivocation found now
    uint8 internal constant REC_BROKEN = 2; // key was already proven broken

    /// @notice Redemption stays open this long after a coin's expiry; then the depositor may reclaim.
    uint256 public immutable grace;
    /// @notice Longest allowed coin lifetime (bounds bond lock-ups: DeviceBondRegistry.slashableAfterExpiry).
    uint256 public immutable maxLifetime;
    /// @notice Receives the unredeemed remainder of FROZEN coins (victim compensation; distribution out of scope).
    address public immutable compensationSink;
    bool public immutable requireBondedDevice;
    address public immutable deployer;

    // ================================================================ events

    event Deposited(
        bytes32 indexed coinId,
        address indexed depositor,
        uint256 value,
        uint64 expiry,
        uint256 k0x,
        uint256 k0y,
        bytes32 k0Hash,
        bytes32 commitment
    );
    event DepositAttested(bytes32 indexed coinId, bytes32 indexed akId, bytes32 k0Hash);
    /// @notice A key's first spend message was recorded (watchers can compare offline spends against it).
    event SpendRecorded(bytes32 indexed coinId, bytes32 indexed keyHash, uint256 depth, bytes32 msgHash);
    event Redeemed(
        bytes32 indexed coinId,
        address indexed payout,
        bytes32 indexed noteId,
        uint256 outputIndex,
        uint256 amount,
        bytes32 msgHash,
        uint256 totalPaid
    );
    event Equivocation(bytes32 indexed coinId, bytes32 indexed keyHash, bytes32 msgA, bytes32 msgB);
    event CoinFrozen(bytes32 indexed coinId, bytes32 indexed keyHash);
    /// @notice A redeem attempt reached a broken key (path blocked; recorded instead of reverting when it froze the coin).
    event RedeemBlocked(bytes32 indexed coinId, bytes32 indexed keyHash, uint256 depth);
    event Reclaimed(bytes32 indexed coinId, address indexed depositor, uint256 amount);
    event FrozenRemainderSwept(bytes32 indexed coinId, address indexed sink, uint256 amount);
    event PaymentDeferred(address indexed to, uint256 amount);
    event OwedWithdrawn(address indexed to, uint256 amount);
    event RegistrySet(address registry);

    // ================================================================ errors

    error BadValue();
    error BadExpiry();
    error CoinExists();
    error BadHeader(); // unknown coin, or header fields differ from the deposit commitment
    error RedeemWindowClosed();
    error ZeroPayout();
    error ConservationViolated(uint256 depth, uint256 outputsSum, uint256 noteValue);
    error ZeroOutput(uint256 depth);
    error BadSig(uint256 depth);
    error BadIndex(uint256 depth);
    error OutputKeyMismatch(uint256 depth);
    error NotRedeemOutput();
    error AlreadyRedeemed(bytes32 redemptionId);
    error CapExceeded(uint256 paid, uint256 amount, uint256 deposit);
    error KeyBroken(uint256 depth, bytes32 keyHash);
    error SameMessage();
    error NothingNew(bytes32 keyHash);
    error TooEarly();
    error AlreadyClosed();
    error NotOneTimeKey(uint256 policyFails);
    error DeviceNotBonded(bytes32 akId);
    error RegistryLocked();
    error NoRegistry();
    error PayFailed();

    constructor(uint256 grace_, uint256 maxLifetime_, address sink_, bool requireBonded_) {
        grace = grace_;
        maxLifetime = maxLifetime_;
        compensationSink = sink_;
        requireBondedDevice = requireBonded_;
        deployer = msg.sender;
        // NOTE: the constructor writes no storage, so tooling may place the runtime code anywhere (anvil_setCode).
    }

    // ================================================================ deposit

    /// @notice Lock msg.value wei as coin `coinId`, owned by genesis one-time key (k0x, k0y).
    /// @dev The genesis key's attestation is NOT checked here; recipients check it offline (v2 rule), or use
    ///  `depositAttested`. k0 is deliberately not required to be unique across coins: enforcing that would
    ///  let anyone front-run a deposit with the same k0 and block it, while a k0 reused by its owner is
    ///  caught anyway (spending both coins = two different messages under one key = equivocation).
    function deposit(bytes32 coinId, uint64 expiry, uint256 k0x, uint256 k0y) external payable {
        _deposit(coinId, expiry, k0x, k0y);
    }

    /// @notice Deposit whose genesis key is taken from its Android attestation leaf certificate, verified
    ///  on-chain by the registry against registered attestation key `akId` (P256VERIFY over the tbs hash)
    ///  with the one-time-key policy (usageCountLimit = 1 hardware-enforced, locked + verified boot, app id).
    function depositAttested(bytes32 coinId, uint64 expiry, bytes calldata genesisLeafCert, bytes32 akId)
        external
        payable
    {
        IOtkChecker reg = registry;
        if (address(reg) == address(0)) revert NoRegistry();
        (bytes32 x, bytes32 y, bytes32 kh, uint256 fails) = reg.checkOtk(genesisLeafCert, akId);
        if (fails != 0) revert NotOneTimeKey(fails);
        if (requireBondedDevice) {
            (address owner,,, bool slashed) = reg.bonds(akId);
            if (owner == address(0) || slashed) revert DeviceNotBonded(akId);
        }
        _deposit(coinId, expiry, uint256(x), uint256(y));
        emit DepositAttested(coinId, akId, kh);
    }

    /// @dev one-time wiring (the registry needs this escrow's address for `brokenKey`)
    function setRegistry(IOtkChecker r) external {
        if (msg.sender != deployer || address(registry) != address(0)) revert RegistryLocked();
        registry = r;
        emit RegistrySet(address(r));
    }

    function _deposit(bytes32 coinId, uint64 expiry, uint256 k0x, uint256 k0y) internal {
        if (msg.value == 0 || msg.value > type(uint128).max) revert BadValue();
        if (expiry <= block.timestamp || expiry > block.timestamp + maxLifetime) revert BadExpiry();
        if (deposits[coinId] != 0) revert CoinExists();
        bytes32 c = commitment(msg.value, expiry, k0x, k0y, msg.sender);
        deposits[coinId] = c;
        emit Deposited(coinId, msg.sender, msg.value, expiry, k0x, k0y, PrawlCodec.keyHash(bytes32(k0x), bytes32(k0y)), c);
    }

    // ================================================================ redeem

    /// @notice Redeem one PRAWL-REDEEM output.
    /// @param h     the coin header (must match the deposit commitment)
    /// @param path  the spends from genesis to the note being redeemed (empty: the genesis note itself)
    /// @param rd    the note key's REDEEM spend; rd.outputs[rd.index] must be the PRAWL-REDEEM output for
    ///              (block.chainid, this escrow, rd.payout)
    /// @return paid true if paid; false if this submission proved an equivocation or reached a broken key in
    ///  a not-yet-frozen coin (the coin is now frozen; nothing reverts so the evidence persists)
    function redeem(Header calldata h, Spend[] calldata path, Redemption calldata rd) external returns (bool paid) {
        _checkHeader(h);
        if (block.timestamp >= uint256(h.expiry) + grace) revert RedeemWindowClosed();
        if (rd.payout == address(0)) revert ZeroPayout();
        // The chosen output must be a REDEEM output for (this chain, this escrow, payout). Checked first, so a
        // submission that is not a redemption here reverts cheaply and never records anything.
        if (rd.index >= rd.outputs.length) revert BadIndex(path.length);
        if (rd.outputs[rd.index].keyHash != V3.redeemTarget(block.chainid, address(this), rd.payout)) {
            revert NotRedeemOutput();
        }
        Walk memory w = _start(h);
        for (uint256 i = 0; i < path.length; i++) {
            Spend calldata sp = path[i];
            (, uint8 st) = _spend(h.coinId, w, sp.outputs, sp.r, sp.s);
            if (st != REC_OK) return _blocked(h.coinId, w, st);
            _advance(w, sp);
        }
        // tip auth: the final spend is verified under the redeemed note's own key (w.x, w.y)
        (bytes32 m, uint8 st2) = _spend(h.coinId, w, rd.outputs, rd.r, rd.s);
        if (st2 != REC_OK) return _blocked(h.coinId, w, st2);
        _payRedemption(h, w, rd, m);
        return true;
    }

    function _payRedemption(Header calldata h, Walk memory w, Redemption calldata rd, bytes32 m) internal {
        bytes32 rid = keccak256(abi.encode(m, rd.index));
        if (redeemed[rid]) revert AlreadyRedeemed(rid);
        uint256 amount = rd.outputs[rd.index].value;
        CoinState storage c = coins[h.coinId];
        if (c.closed) revert AlreadyClosed();
        uint256 total = uint256(c.paid) + amount;
        if (total > h.value) revert CapExceeded(c.paid, amount, h.value);
        redeemed[rid] = true;
        c.paid = uint128(total);
        emit Redeemed(h.coinId, rd.payout, w.noteId, rd.index, amount, m, total);
        _pay(rd.payout, amount);
    }

    /// @dev A path reached a key that conflicts (REC_CONFLICT: just proven, coin frozen by _record) or that
    ///  was proven broken before (REC_BROKEN). A broken key inside an ALREADY frozen coin is a plain revert;
    ///  in a not-yet-frozen coin (the key equivocated in another coin's context) it freezes this coin too.
    function _blocked(bytes32 coinId, Walk memory w, uint8 st) internal returns (bool) {
        if (st == REC_BROKEN) {
            if (coins[coinId].frozen) revert KeyBroken(w.depth, w.kh);
            _freeze(coinId, w.kh);
        }
        emit RedeemBlocked(coinId, w.kh, w.depth);
        return false;
    }

    // ================================================================ equivocation

    /// @notice Public proof that a one-time key of coin `h.coinId` signed two different messages.
    /// @param path spends from genesis to the accused note (empty: the accused key is k0); shows that the
    ///  accused key really holds part of this coin, so nobody can freeze a coin with an unrelated key.
    /// @param a,b  two RAW messages with signatures by the accused key (raw, not digests: from digests alone
    ///  anyone can fabricate (digest, r, s) triples that verify under any public key).
    /// @dev Allowed at any time, also after the coin closed: the record (brokenKey) is slashing evidence.
    function proveEquivocation(Header calldata h, Spend[] calldata path, Signed calldata a, Signed calldata b)
        external
        returns (bytes32 kh)
    {
        _checkHeader(h);
        Walk memory w = _start(h);
        for (uint256 i = 0; i < path.length; i++) {
            Spend calldata sp = path[i];
            (, uint8 st) = _spend(h.coinId, w, sp.outputs, sp.r, sp.s);
            if (st == REC_BROKEN) _freeze(h.coinId, w.kh); // an ancestor was already broken (REC_CONFLICT froze already)
            _advance(w, sp);
        }
        bytes32 hA = sha256(a.message);
        bytes32 hB = sha256(b.message);
        if (hA == hB) revert SameMessage(); // a re-randomised or malleated signature of the SAME message proves nothing
        if (!_p256(hA, a.r, a.s, w.x, w.y)) revert BadSig(w.depth);
        if (!_p256(hB, b.r, b.s, w.x, w.y)) revert BadSig(w.depth);
        kh = w.kh;
        bool fresh = firstMsg[kh] != BROKEN;
        if (!fresh && coins[h.coinId].frozen) revert NothingNew(kh);
        if (fresh) _markBroken(h.coinId, kh, hA, hB);
        _freeze(h.coinId, kh);
    }

    /// @notice Read by DeviceBondRegistry.slash: has this one-time key been proven to sign two different messages?
    function brokenKey(bytes32 kh) external view returns (bool) {
        return firstMsg[kh] == BROKEN;
    }

    // ================================================================ expiry

    /// @notice After expiry + grace: the unredeemed value goes back to the depositor -- unless the coin is
    ///  frozen, in which case it goes to `compensationSink` (a depositor who equivocated with one of her own
    ///  keys must not get the blocked value back). Anyone may trigger it; funds only go to those two places.
    function reclaim(Header calldata h) external {
        _checkHeader(h);
        if (block.timestamp < uint256(h.expiry) + grace) revert TooEarly();
        CoinState storage c = coins[h.coinId];
        if (c.closed) revert AlreadyClosed();
        c.closed = true;
        uint256 rest = h.value - c.paid;
        if (c.frozen) {
            emit FrozenRemainderSwept(h.coinId, compensationSink, rest);
            _pay(compensationSink, rest);
        } else {
            emit Reclaimed(h.coinId, h.depositor, rest);
            _pay(h.depositor, rest);
        }
    }

    /// @notice Pull a payment whose push failed.
    function withdrawOwed() external {
        uint256 amt = owed[msg.sender];
        owed[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amt}("");
        if (!ok) revert PayFailed();
        emit OwedWithdrawn(msg.sender, amt);
    }

    // ================================================================ views (wallet / test helpers)

    function commitment(uint256 value, uint64 expiry, uint256 k0x, uint256 k0y, address depositor)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(value, expiry, k0x, k0y, depositor));
    }

    /// @notice The exact message (and its sha256) that a note's key signs, for this escrow and chain.
    function spendMessage(Header calldata h, uint256 depth, bytes32 noteId, V3.Output[] calldata outs)
        external
        view
        returns (bytes memory message, bytes32 digest)
    {
        (bytes32 oh,,,) = V3.outputsHash(outs);
        message = V3.message(V3.prefix(block.chainid, address(this), h.coinId, h.expiry), depth, noteId, oh);
        digest = sha256(message);
    }

    function outputsHash(V3.Output[] calldata outs) external pure returns (bytes32 h) {
        (h,,,) = V3.outputsHash(outs);
    }

    function genesisNoteId(bytes32 coinId) external pure returns (bytes32) {
        return V3.genesisNoteId(coinId);
    }

    function childNoteId(bytes32 r, bytes32 s, uint256 index) external pure returns (bytes32) {
        return V3.childNoteId(r, s, index);
    }

    /// @notice keyHash of the PRAWL-REDEEM output that pays `payout` through this escrow on this chain.
    function redeemKeyHash(address payout) external view returns (bytes32) {
        return V3.redeemTarget(block.chainid, address(this), payout);
    }

    function keyHash(bytes32 x, bytes32 y) external pure returns (bytes32) {
        return PrawlCodec.keyHash(x, y);
    }

    function redemptionId(bytes32 msgHash, uint256 index) external pure returns (bytes32) {
        return keccak256(abi.encode(msgHash, index));
    }

    // ================================================================ internals

    function _checkHeader(Header calldata h) internal view {
        bytes32 c = deposits[h.coinId];
        if (c == 0 || c != commitment(h.value, h.expiry, h.k0x, h.k0y, h.depositor)) revert BadHeader();
    }

    function _start(Header calldata h) internal view returns (Walk memory w) {
        w.prefix = V3.prefix(block.chainid, address(this), h.coinId, h.expiry);
        w.x = bytes32(h.k0x);
        w.y = bytes32(h.k0y);
        w.kh = PrawlCodec.keyHash(w.x, w.y);
        w.value = h.value;
        w.noteId = V3.genesisNoteId(h.coinId);
    }

    /// @dev Verifies one spend of the current note: conservation, signature by the note's key, then records
    ///  the key's message. Returns the message hash and the record status.
    function _spend(bytes32 coinId, Walk memory w, V3.Output[] calldata outs, bytes32 r, bytes32 s)
        internal
        returns (bytes32 m, uint8 st)
    {
        (bytes32 oh, uint256 sum, bool overflow, bool anyZero) = V3.outputsHash(outs);
        if (anyZero) revert ZeroOutput(w.depth);
        if (overflow || sum != w.value) revert ConservationViolated(w.depth, overflow ? type(uint256).max : sum, w.value);
        m = sha256(V3.message(w.prefix, w.depth, w.noteId, oh));
        if (!_p256(m, r, s, w.x, w.y)) revert BadSig(w.depth);
        st = _record(coinId, w.kh, m, w.depth);
    }

    /// @dev Moves the walk from the current note to output `sp.index` of the spend just verified.
    function _advance(Walk memory w, Spend calldata sp) internal pure {
        if (sp.index >= sp.outputs.length) revert BadIndex(w.depth);
        bytes32 nk = PrawlCodec.keyHash(sp.nextX, sp.nextY);
        if (sp.outputs[sp.index].keyHash != nk) revert OutputKeyMismatch(w.depth);
        w.value = sp.outputs[sp.index].value;
        w.noteId = V3.childNoteId(sp.r, sp.s, sp.index);
        w.x = sp.nextX;
        w.y = sp.nextY;
        w.kh = nk;
        w.depth++;
    }

    /// @dev First message: record. Same message again: fine (shared prefix, other output of the same spend,
    ///  re-submission). Different message: equivocation -> key broken, coin frozen.
    function _record(bytes32 coinId, bytes32 kh, bytes32 m, uint256 depth) internal returns (uint8) {
        bytes32 prev = firstMsg[kh];
        if (prev == m) return REC_OK;
        if (prev == 0) {
            firstMsg[kh] = m;
            emit SpendRecorded(coinId, kh, depth, m);
            return REC_OK;
        }
        if (prev == BROKEN) return REC_BROKEN;
        _markBroken(coinId, kh, prev, m);
        _freeze(coinId, kh);
        return REC_CONFLICT;
    }

    function _markBroken(bytes32 coinId, bytes32 kh, bytes32 hA, bytes32 hB) internal {
        firstMsg[kh] = BROKEN;
        evidence[kh] = Evidence(coinId, hA, hB);
        emit Equivocation(coinId, kh, hA, hB);
    }

    function _freeze(bytes32 coinId, bytes32 kh) internal {
        CoinState storage c = coins[coinId];
        if (!c.frozen) {
            c.frozen = true;
            emit CoinFrozen(coinId, kh);
        }
    }

    function _p256(bytes32 h, bytes32 r, bytes32 s, bytes32 x, bytes32 y) internal view returns (bool ok) {
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

    /// @dev Push; if the recipient reverts, keep it as `owed` (a payout address is fixed by the tip key's
    ///  signature, so a reverting payout must not lock the value forever).
    function _pay(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) {
            owed[to] += amount;
            emit PaymentDeferred(to, amount);
        }
    }
}
