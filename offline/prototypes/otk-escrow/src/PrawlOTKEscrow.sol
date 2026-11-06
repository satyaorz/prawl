// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title PrawlOTKEscrow -- escrow for offline coins whose spend keys are hardware one-time keys (OTKs)
/// @notice Prevention lives on the phones, not here: every coin key is an Android Keystore P-256 key
///  generated with KeyGenParameterSpec.Builder.setMaxUsageCount(1) whose attestation shows
///  usageCountLimit=1 in the TEE/StrongBox-enforced list. Recipients check that attestation OFFLINE
///  before accepting. A hardware OTK can produce exactly one signature, so each coin key moves the
///  coin exactly once (one hop message, or one redeem message).
///
///  This contract only (1) verifies the P-256 signature chain with the EIP-7951 P256VERIFY precompile
///  (0x100, live on L1 since Fusaka), (2) records the single message each OTK ever signed, and
///  (3) treats a second, different message by the same key as on-chain PROOF that the hardware
///  assumption failed for that key (TEE break / leaked attestation key), freezing that branch.
///  Attestation chains are NOT verified on-chain here (their intermediates are P-384; see notes).
contract PrawlOTKEscrow {
    address constant P256VERIFY = address(0x100);
    bytes32 constant D_COIN = keccak256("PRAWL.OTK.COIN.v1");
    bytes32 constant D_HOP = keccak256("PRAWL.OTK.HOP.v1");
    bytes32 constant D_REDEEM = keccak256("PRAWL.OTK.REDEEM.v1");
    uint256 constant MAX_OUTS = 8;

    struct Out {
        uint256 value;
        bytes32 x; // recipient OTK public key (P-256 affine coordinates)
        bytes32 y;
    }

    struct Hop {
        Out[] outs; // full split signed by the current key (payment + change ...)
        uint8 next; // which output this redemption path follows
        bytes32 r;
        bytes32 s;
    }

    struct Coin {
        uint256 value; // deposited amount: what the root key's first hop must conserve
        uint256 remaining; // unredeemed escrow for this coin (caps losses if hardware ever breaks)
        bytes32 x;
        bytes32 y;
    }

    mapping(bytes32 => Coin) public coins;
    /// @notice keyHash => sha256 of the ONE message that OTK signed (0 = never seen on-chain)
    mapping(bytes32 => bytes32) public keyUse;
    mapping(bytes32 => bool) public brokenKey; // keys proven to have signed twice

    event Deposited(bytes32 indexed coinId, uint256 value, bytes32 x, bytes32 y);
    event Redeemed(bytes32 indexed coinId, bytes32 indexed leafKey, address payout, uint256 value);
    event HardwareBreak(bytes32 indexed coinId, bytes32 indexed keyHash, bytes32 firstMsg, bytes32 secondMsg);

    error BadSig(uint256 hop);
    error Conservation(uint256 hop);
    error KeyBroken(bytes32 keyHash);

    function keyHash(bytes32 x, bytes32 y) public pure returns (bytes32) {
        return keccak256(abi.encode(x, y));
    }

    /// @notice Alice deposits ETH to a coin whose first owner is her hardware OTK (x,y).
    function deposit(bytes32 x, bytes32 y) external payable returns (bytes32 coinId) {
        require(msg.value > 0, "value");
        coinId = keccak256(abi.encode(D_COIN, x, y));
        require(coins[coinId].x == 0 && keyUse[keyHash(x, y)] == 0, "key reused");
        coins[coinId] = Coin(msg.value, msg.value, x, y);
        emit Deposited(coinId, msg.value, x, y);
    }

    /// @dev The exact bytes the phone signs (SHA256withECDSA inside the TEE). Domain-separated per chain/contract.
    function hopMessage(bytes32 coinId, bytes32 kh, Out[] calldata outs) public view returns (bytes memory) {
        return abi.encode(D_HOP, block.chainid, address(this), coinId, kh, outs);
    }

    function redeemMessage(bytes32 coinId, bytes32 kh, address payout) public view returns (bytes memory) {
        return abi.encode(D_REDEEM, block.chainid, address(this), coinId, kh, payout);
    }

    /// @notice Anyone may submit; the tip OTK's single signature authorises `payout`.
    function redeem(bytes32 coinId, Hop[] calldata hops, address payout, bytes32 r, bytes32 s) external {
        Coin storage c = coins[coinId];
        require(c.x != 0, "unknown coin");
        bytes32 x = c.x;
        bytes32 y = c.y;
        uint256 value = c.value; // the root key controls the whole deposit
        for (uint256 i = 0; i < hops.length; i++) {
            Hop calldata h = hops[i];
            bytes32 kh = keyHash(x, y);
            bytes32 m = sha256(hopMessage(coinId, kh, h.outs));
            if (!_p256(m, h.r, h.s, x, y)) revert BadSig(i);
            if (!_use(coinId, kh, m)) return; // equivocation proven: branch frozen, evidence emitted
            uint256 n = h.outs.length;
            require(n > 0 && n <= MAX_OUTS && h.next < n, "outs");
            uint256 sum;
            for (uint256 j = 0; j < n; j++) sum += h.outs[j].value;
            if (sum != value) revert Conservation(i);
            Out calldata o = h.outs[h.next];
            (x, y, value) = (o.x, o.y, o.value);
        }
        bytes32 leaf = keyHash(x, y);
        bytes32 rm = sha256(redeemMessage(coinId, leaf, payout));
        if (!_p256(rm, r, s, x, y)) revert BadSig(hops.length);
        // A redeem message must be NEW: re-submitting the same transcript must not pay twice.
        require(keyUse[leaf] != rm, "already redeemed");
        if (!_use(coinId, leaf, rm)) return;
        uint256 pay = value <= c.remaining ? value : c.remaining; // never pay out more than escrowed
        c.remaining -= pay;
        emit Redeemed(coinId, leaf, payout, pay);
        (bool ok,) = payout.call{value: pay}("");
        require(ok, "pay");
    }

    /// @dev First message seen for an OTK is recorded; the same message again is fine (shared prefix of
    ///  two branches of an honest split). A DIFFERENT message is impossible for a working hardware OTK.
    function _use(bytes32 coinId, bytes32 kh, bytes32 m) internal returns (bool) {
        if (brokenKey[kh]) revert KeyBroken(kh);
        bytes32 prev = keyUse[kh];
        if (prev == 0) {
            keyUse[kh] = m;
            return true;
        }
        if (prev == m) return true;
        brokenKey[kh] = true; // persists: later redemptions through this key revert
        emit HardwareBreak(coinId, kh, prev, m);
        return false;
    }

    function _p256(bytes32 h, bytes32 r, bytes32 s, bytes32 x, bytes32 y) internal view returns (bool) {
        (bool ok, bytes memory out) = P256VERIFY.staticcall(abi.encode(h, r, s, x, y));
        return ok && out.length == 32 && abi.decode(out, (uint256)) == 1;
    }
}
