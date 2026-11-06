// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PrawlCodec} from "./PrawlCodec.sol";

/// @title PrawlRealEscrow -- settles and polices coins signed by REAL Android one-time keys (OTKs)
/// @notice Each coin hop is owned by a P-256 key generated in Android secure hardware with
///  setMaxUsageCount(1), so its holder can sign exactly one successor. The phones' hop format
///  (WalletActivity.java) is recomputed here byte for byte (PrawlCodec) and every signature is
///  checked with the EIP-7951 P256VERIFY precompile (0x100, live on L1 since Fusaka).
///
///  Settlement rule: CHALLENGE WINDOW, DEEPEST VALID CHAIN WINS (justification in RESULTS.md):
///   * a claim (`redeem`) opens a window; a strictly deeper valid chain replaces it and restarts the window;
///   * because every key's first signed message is recorded (`keyMsg`), a deeper chain that does not
///     extend the current claim necessarily makes some key sign two different messages, which is
///     detected and freezes the coin instead of paying anyone;
///   * `finalize` pays the surviving claim after the window.
///
///  Payout authorisation ("tip auth"): the phone v1 format has no redeem message, so in v1-compat mode
///  (requireTipAuth = false) the claimant names the payout and is protected only against STALE claims
///  (a previous holder redeeming a prefix), not against someone who copied the deepest payment file.
///  In production mode (requireTipAuth = true) the tip key spends its one signature on a redemption
///  hop whose "to" is PrawlCodec.redeemTarget(chainid, escrow, payout); a holder who already paid on
///  then cannot redeem without equivocating.
contract PrawlRealEscrow {
    using PrawlCodec for bytes;

    address internal constant P256VERIFY = address(0x100);

    enum Status {
        None,
        Open, // deposited, no claim yet
        Claimed, // claim pending inside its challenge window
        Paid,
        Frozen, // equivocation proven: the hardware/attestation assumption failed for some key
        Refunded
    }

    /// @notice One hop: the recipient's key and the previous owner's signature over the hop message.
    struct Hop {
        bytes32 x;
        bytes32 y;
        bytes32 r;
        bytes32 s;
    }

    /// @dev Running state of a chain walk (memory, to keep the legacy code generator's stack small).
    struct Walk {
        bytes32 sx;
        bytes32 sy;
        bytes32 prev;
        uint256 n;
        bool ok;
    }

    /// @notice A raw message and a P-256 signature over sha256(message).
    struct Signed {
        bytes message;
        bytes32 r;
        bytes32 s;
    }

    struct Coin {
        address depositor;
        uint64 expiry;
        Status status;
        uint16 claimDepth;
        bool claimTipAuth;
        address payout;
        uint64 deadline;
        uint256 amount;
        bytes32 k0x;
        bytes32 k0y;
        bytes32 mintHash;
        string value; // the exact decimal string the phones sign ("0.2")
    }

    uint256 public immutable challengeWindow;
    bool public immutable requireTipAuth;

    mapping(bytes32 => Coin) internal coins; // keccak256(coinId) => coin
    /// @notice OTK key hash (sha256 of SPKI, the phone's leafHash) => sha256 of the ONE message it signed.
    mapping(bytes32 => bytes32) public keyMsg;
    /// @notice genesis key hash => coin id hash (one coin per genesis key)
    mapping(bytes32 => bytes32) public genesisCoin;
    /// @notice keys proven to have signed two different messages. Input to slashing (DeviceBondRegistry).
    mapping(bytes32 => bool) public brokenKey;

    struct Evidence {
        bytes32 coin;
        bytes32 msgA;
        bytes32 msgB;
    }

    mapping(bytes32 => Evidence) public evidence; // key hash => first recorded equivocation

    event Deposited(bytes32 indexed coin, string coinId, string value, uint256 amount, bytes32 k0Hash, uint64 expiry);
    event Claimed(bytes32 indexed coin, uint256 depth, address payout, uint64 deadline, bool tipAuth);
    event Paid(bytes32 indexed coin, address payout, uint256 amount);
    event Refunded(bytes32 indexed coin, address depositor, uint256 amount);
    event Equivocation(bytes32 indexed coin, bytes32 indexed keyHash, bytes32 msgA, bytes32 msgB);

    error BadCoinId();
    error BadValue();
    error CoinExists();
    error GenesisKeyReused();
    error BadExpiry();
    error NotRedeemable(Status status);
    error Expired();
    error WindowClosed();
    error WindowOpen();
    error BadSig(uint256 hop); // hop == hops.length means the tip-auth (redemption) signature
    error TipAuthRequired();
    error OnlyDepositor();
    error NotDeeper(uint256 current, uint256 offered);
    error KeyBroken(bytes32 keyHash);
    error SameMessage();
    error TooManyHops();
    error PayFailed();
    error ZeroPayout();

    constructor(uint256 window, bool tipAuth) {
        challengeWindow = window;
        requireTipAuth = tipAuth;
    }

    // ------------------------------------------------------------------ deposit / refund

    /// @notice Lock `value` ETH as coin `coinId` owned by genesis OTK (k0x, k0y).
    /// @dev The genesis key's ATTESTATION is not checked here (see PrawlAttestedEscrow.depositAttested).
    function deposit(string calldata coinId, string calldata value, bytes32 k0x, bytes32 k0y, uint64 expiry)
        external
        payable
        returns (bytes32 id)
    {
        id = _deposit(bytes(coinId), bytes(value), k0x, k0y, expiry);
    }

    function _deposit(bytes memory coinId, bytes memory value, bytes32 k0x, bytes32 k0y, uint64 expiry)
        internal
        returns (bytes32 id)
    {
        if (!PrawlCodec.validCoinId(coinId)) revert BadCoinId();
        (bool ok, uint256 wei_) = PrawlCodec.parseEther(value);
        if (!ok || wei_ != msg.value) revert BadValue();
        if (expiry <= block.timestamp + challengeWindow) revert BadExpiry();
        id = keccak256(coinId);
        Coin storage c = coins[id];
        if (c.status != Status.None) revert CoinExists();
        bytes32 k0h = PrawlCodec.keyHash(k0x, k0y);
        if (genesisCoin[k0h] != 0) revert GenesisKeyReused();
        genesisCoin[k0h] = id;
        c.depositor = msg.sender;
        c.expiry = expiry;
        c.status = Status.Open;
        c.amount = msg.value;
        c.k0x = k0x;
        c.k0y = k0y;
        c.mintHash = PrawlCodec.mintHash(coinId, value, k0h);
        c.value = string(value);
        emit Deposited(id, string(coinId), string(value), msg.value, k0h, expiry);
    }

    /// @notice Depositor takes the coin back if nobody claimed it before expiry (lost phone, wiped app).
    function refundExpired(string calldata coinId) external {
        bytes32 id = keccak256(bytes(coinId));
        Coin storage c = coins[id];
        if (c.status != Status.Open) revert NotRedeemable(c.status);
        if (block.timestamp < c.expiry) revert WindowOpen();
        c.status = Status.Refunded;
        _pay(c.depositor, c.amount);
        emit Refunded(id, c.depositor, c.amount);
    }

    // ------------------------------------------------------------------ redeem (claim) / finalize

    /// @notice Claim coin `coinId` with hop chain `hops` (hop i: recipient key + signature by the owner of hop i-1,
    ///  or by the genesis key for i = 0). `tipR/tipS` = the tip key's redemption signature (0,0 = none).
    /// @return accepted false if the submission proved an equivocation (coin frozen; nothing reverted so
    ///  the evidence persists).
    function redeem(string calldata coinId, Hop[] calldata hops, address payout, bytes32 tipR, bytes32 tipS)
        external
        returns (bool accepted)
    {
        bytes32 id = keccak256(bytes(coinId));
        Coin storage c = coins[id];
        Status st = c.status;
        if (st == Status.Open) {
            if (block.timestamp >= c.expiry) revert Expired();
        } else if (st == Status.Claimed) {
            if (block.timestamp >= c.deadline) revert WindowClosed();
        } else {
            revert NotRedeemable(st);
        }
        uint256 n = hops.length;
        if (n > type(uint16).max) revert TooManyHops();
        if (payout == address(0)) revert ZeroPayout();
        bool tipAuth = tipR != 0 || tipS != 0;
        if (!tipAuth) {
            if (requireTipAuth) revert TipAuthRequired();
            if (n == 0 && msg.sender != c.depositor) revert OnlyDepositor();
        }

        Walk memory w = _verifyAndRecord(id, bytes(coinId), c, hops);
        if (!w.ok) return false;
        if (tipAuth && !_tipAuth(id, bytes(coinId), c, w, payout, tipR, tipS)) return false;
        // No key equivocated, so this chain and the current claim agree on every shared hop: one is a
        // prefix of the other. Only a strictly deeper chain may replace the claim (first-come on ties).
        if (st == Status.Claimed && n <= c.claimDepth) revert NotDeeper(c.claimDepth, n);
        uint64 deadline = uint64(block.timestamp + challengeWindow);
        c.status = Status.Claimed;
        c.claimDepth = uint16(n);
        c.claimTipAuth = tipAuth;
        c.payout = payout;
        c.deadline = deadline;
        emit Claimed(id, n, payout, deadline, tipAuth);
        return true;
    }

    /// @notice Pay the surviving claim once its challenge window has passed.
    function finalize(string calldata coinId) external {
        bytes32 id = keccak256(bytes(coinId));
        Coin storage c = coins[id];
        if (c.status != Status.Claimed) revert NotRedeemable(c.status);
        if (block.timestamp < c.deadline) revert WindowOpen();
        c.status = Status.Paid;
        _pay(c.payout, c.amount);
        emit Paid(id, c.payout, c.amount);
    }

    // ------------------------------------------------------------------ equivocation

    /// @notice Public proof that a coin key signed two different messages. `prefix` is a valid hop chain
    ///  from the coin's genesis key to the accused key K (empty: K is the genesis key), which shows K
    ///  really holds this coin (otherwise anyone could freeze any coin with their own key).
    ///  Raw messages are required, not digests: given only digests, anyone can fabricate
    ///  (digest, r, s) triples that verify under any public key.
    function proveEquivocation(string calldata coinId, Hop[] calldata prefix, Signed calldata a, Signed calldata b)
        external
        returns (bytes32 kh)
    {
        bytes32 id = keccak256(bytes(coinId));
        Coin storage c = coins[id];
        if (c.status == Status.None) revert NotRedeemable(Status.None);
        (bytes32 sx, bytes32 sy) = _walk(bytes(coinId), c, prefix);
        bytes32 hA = sha256(a.message);
        bytes32 hB = sha256(b.message);
        if (hA == hB) revert SameMessage(); // a re-randomised or malleated signature on the SAME message proves nothing
        if (!_p256(hA, a.r, a.s, sx, sy)) revert BadSig(prefix.length);
        if (!_p256(hB, b.r, b.s, sx, sy)) revert BadSig(prefix.length + 1);
        kh = PrawlCodec.keyHash(sx, sy);
        _equivocate(id, kh, hA, hB);
    }

    /// @dev Verifies a claim's hop chain and records each signer's message; false = equivocation found.
    function _verifyAndRecord(bytes32 id, bytes memory cid, Coin storage c, Hop[] calldata hops)
        internal
        returns (Walk memory w)
    {
        bytes memory val = bytes(c.value);
        w.sx = c.k0x;
        w.sy = c.k0y;
        w.prev = c.mintHash;
        for (uint256 i = 0; i < hops.length; i++) {
            Hop calldata h = hops[i];
            bytes32 m = sha256(PrawlCodec.hopMessage(cid, val, i, w.prev, PrawlCodec.keyHash(h.x, h.y)));
            if (!_p256(m, h.r, h.s, w.sx, w.sy)) revert BadSig(i);
            if (!_record(id, PrawlCodec.keyHash(w.sx, w.sy), m)) return w; // w.ok == false
            w.prev = sha256(PrawlCodec.derSig(h.r, h.s));
            (w.sx, w.sy) = (h.x, h.y);
        }
        w.n = hops.length;
        w.ok = true;
    }

    /// @dev The tip key's redemption: hop n paying the coin to `payout` (PrawlCodec.redeemTarget).
    function _tipAuth(
        bytes32 id,
        bytes memory cid,
        Coin storage c,
        Walk memory w,
        address payout,
        bytes32 r,
        bytes32 s
    ) internal returns (bool) {
        bytes32 target = PrawlCodec.redeemTarget(block.chainid, address(this), payout);
        bytes32 m = sha256(PrawlCodec.hopMessage(cid, bytes(c.value), w.n, w.prev, target));
        if (!_p256(m, r, s, w.sx, w.sy)) revert BadSig(w.n);
        return _record(id, PrawlCodec.keyHash(w.sx, w.sy), m);
    }

    /// @dev Verifies a hop chain from the genesis key without recording anything; returns its last key.
    function _walk(bytes memory cid, Coin storage c, Hop[] calldata hops) internal view returns (bytes32 sx, bytes32 sy) {
        bytes memory val = bytes(c.value);
        sx = c.k0x;
        sy = c.k0y;
        bytes32 prev = c.mintHash;
        for (uint256 i = 0; i < hops.length; i++) {
            Hop calldata h = hops[i];
            bytes32 m = sha256(PrawlCodec.hopMessage(cid, val, i, prev, PrawlCodec.keyHash(h.x, h.y)));
            if (!_p256(m, h.r, h.s, sx, sy)) revert BadSig(i);
            prev = sha256(PrawlCodec.derSig(h.r, h.s));
            (sx, sy) = (h.x, h.y);
        }
    }

    // ------------------------------------------------------------------ views

    function coin(string calldata coinId) external view returns (Coin memory) {
        return coins[keccak256(bytes(coinId))];
    }

    function hopDigest(string calldata coinId, uint256 i, bytes32 prev, bytes32 x, bytes32 y)
        external
        view
        returns (bytes memory message, bytes32 digest)
    {
        message = PrawlCodec.hopMessage(bytes(coinId), bytes(coins[keccak256(bytes(coinId))].value), i, prev, PrawlCodec.keyHash(x, y));
        digest = sha256(message);
    }

    /// @notice The message the tip key signs to redeem to `payout` (production mode).
    function redeemDigest(string calldata coinId, uint256 n, bytes32 prev, address payout)
        external
        view
        returns (bytes memory message, bytes32 digest)
    {
        bytes32 target = PrawlCodec.redeemTarget(block.chainid, address(this), payout);
        message = PrawlCodec.hopMessage(bytes(coinId), bytes(coins[keccak256(bytes(coinId))].value), n, prev, target);
        digest = sha256(message);
    }

    // ------------------------------------------------------------------ internals

    /// @dev Records the first message a key signs. Same message again: fine (shared prefix of a deeper chain,
    ///  or a re-submission). Different message: equivocation, the coin is frozen.
    function _record(bytes32 id, bytes32 kh, bytes32 m) internal returns (bool) {
        if (brokenKey[kh]) revert KeyBroken(kh);
        bytes32 prevMsg = keyMsg[kh];
        if (prevMsg == 0) {
            keyMsg[kh] = m;
            return true;
        }
        if (prevMsg == m) return true;
        _equivocate(id, kh, prevMsg, m);
        return false;
    }

    function _equivocate(bytes32 id, bytes32 kh, bytes32 hA, bytes32 hB) internal {
        Coin storage c = coins[id];
        if (c.status == Status.Open || c.status == Status.Claimed) c.status = Status.Frozen;
        if (!brokenKey[kh]) {
            brokenKey[kh] = true;
            evidence[kh] = Evidence(id, hA, hB);
        }
        emit Equivocation(id, kh, hA, hB);
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

    function _pay(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert PayFailed();
    }
}
