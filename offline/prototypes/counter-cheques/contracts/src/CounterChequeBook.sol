// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SlackPayoutPool} from "./SlackPayoutPool.sol";

/// @title CounterChequeBook -- H-tier settlement sketch (seam D)
/// @notice Each account deposits W and registers, per epoch, a counter key with budget L and per-cheque
///  cap vmax, requiring W >= L*vmax ("your offline balance IS the collateral").  Offline, the owner signs
///  cheques (epoch, counter j in [1,L], value <= vmax, payee).  If the counter key really is
///  counter-limited (hardware; seam A), every counter value is signed at most once, so every accepted
///  cheque is payable and no fork can hurt anyone.  If the hardware is broken, two different cheques with
///  the same (epoch, j) are an equivocation proof: the remaining deposit is forfeited into a
///  SlackPayoutPool event (C-tier fallback) and the colliding cheques become claims there.
///  NOTE: the counter key is modelled with secp256k1/ecrecover for the sketch; a real deployment verifies
///  P-256 (App Attest / Android KeyMint) per seam A.
contract CounterChequeBook {
    struct Acct {
        uint128 deposit;
        uint128 vmax;
        uint32 L;
        uint32 epoch;
        uint64 unlockAt;    // epoch end + claim window
        address key;        // counter key (sketch)
        bool slashed;
    }

    bytes32 constant D_CHEQUE = keccak256("PRAWL.CHEQUE.v1");
    uint64 public constant CLAIM_WINDOW = 1 days;

    SlackPayoutPool public immutable pool;
    mapping(address => Acct) public accts;
    // account => epoch => counter => cheque digest that was paid (0 = unpaid)
    mapping(address => mapping(uint32 => mapping(uint32 => bytes32))) public paidDigest;
    mapping(bytes32 => bool) public claimed;

    event Registered(address indexed acct, uint32 epoch, uint32 L, uint256 vmax, uint256 deposit);
    event ChequePaid(address indexed acct, uint32 epoch, uint32 j, address payee, uint256 value);
    event Equivocation(address indexed acct, uint32 epoch, uint32 j, uint256 forfeited);

    constructor(uint64 poolWindow) {
        pool = new SlackPayoutPool(address(this), poolWindow);
    }

    function register(address key, uint32 epoch, uint32 L, uint128 vmax, uint64 epochEnd) external payable {
        Acct storage a = accts[msg.sender];
        require(!a.slashed, "slashed");
        require(block.timestamp >= a.unlockAt || a.key == address(0), "previous epoch locked");
        a.deposit += uint128(msg.value);
        require(uint256(L) * vmax <= a.deposit, "W < L*vmax");
        (a.key, a.epoch, a.L, a.vmax) = (key, epoch, L, vmax);
        a.unlockAt = epochEnd + CLAIM_WINDOW;
        emit Registered(msg.sender, epoch, L, vmax, a.deposit);
    }

    function digest(address acct, uint32 epoch, uint32 j, uint256 value, address payee) public pure returns (bytes32) {
        return keccak256(abi.encode(D_CHEQUE, acct, epoch, j, value, payee));
    }

    function redeem(address acct, uint32 epoch, uint32 j, uint256 value, address payee, uint8 v, bytes32 r, bytes32 s) external {
        Acct storage a = accts[acct];
        require(epoch == a.epoch && j >= 1 && j <= a.L && value <= a.vmax, "out of budget");
        require(block.timestamp < a.unlockAt, "expired");
        bytes32 d = digest(acct, epoch, j, value, payee);
        require(ecrecover(d, v, r, s) == a.key, "sig");
        require(!claimed[d], "already claimed");
        claimed[d] = true;
        bytes32 prev = paidDigest[acct][epoch][j];
        if (!a.slashed && prev == bytes32(0)) {
            paidDigest[acct][epoch][j] = d;
            a.deposit -= uint128(value);            // cannot underflow while hardware holds: sum <= L*vmax <= W
            (bool ok,) = payee.call{value: value}("");
            require(ok);
            emit ChequePaid(acct, epoch, j, payee, value);
        } else {
            // either a second cheque on an already-paid counter value (hardware broken -> equivocation proof)
            // or any cheque after the slash: it becomes a claim in the C-tier fallback pool
            if (!a.slashed) _forfeit(acct, epoch, j);
            pool.register(uint256(uint160(acct)), payee, value);
        }
    }

    function _forfeit(address acct, uint32 epoch, uint32 j) internal {
        Acct storage a = accts[acct];
        if (a.slashed) return;
        a.slashed = true;
        uint256 amt = a.deposit;
        a.deposit = 0;
        // burn 25%, coverage Hbar = D/2 (lambda = 2)
        pool.open{value: amt}(uint256(uint160(acct)), 2500, 5000);
        emit Equivocation(acct, epoch, j, amt);
    }

    function withdraw() external {
        Acct storage a = accts[msg.sender];
        require(!a.slashed && block.timestamp >= a.unlockAt, "locked");
        uint256 amt = a.deposit;
        a.deposit = 0;
        (bool ok,) = msg.sender.call{value: amt}("");
        require(ok);
    }
}
