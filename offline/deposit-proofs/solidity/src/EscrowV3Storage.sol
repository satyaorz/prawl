// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title EscrowV3Storage - storage-layout stub of the Prawl v3 escrow (deposit side only).
/// @notice Pins the layout the offline deposit proof depends on: `deposits` MUST be the first
///         state variable (slot 0), so deposits[coinId] lives at keccak256(abi.encode(coinId, uint256(0))).
///         The full escrow (redemption, conflicts, expiry) must keep this variable first and must not
///         inherit from contracts that declare storage (they would shift it). If it is ever made
///         upgradeable, use ERC-7201 namespaced storage elsewhere and leave slot 0 to `deposits`.
contract EscrowV3Storage {
    /// @dev slot 0. coinId => keccak256(abi.encode(value, expiry, k0x, k0y, depositor)).
    mapping(bytes32 => bytes32) public deposits;

    event Deposited(bytes32 indexed coinId, bytes32 commitment, uint256 value, uint64 expiry, address depositor);

    error CoinIdUsed(bytes32 coinId);
    error ZeroValue();

    /// @notice SPEC.md section 1. msg.value is the coin value in wei.
    function deposit(bytes32 coinId, uint64 expiry, uint256 k0x, uint256 k0y) external payable {
        if (msg.value == 0) revert ZeroValue();
        if (deposits[coinId] != bytes32(0)) revert CoinIdUsed(coinId);
        bytes32 c = commitment(msg.value, expiry, k0x, k0y, msg.sender);
        deposits[coinId] = c;
        emit Deposited(coinId, c, msg.value, expiry, msg.sender);
    }

    /// @notice What the recipient recomputes from the coin header and compares with the proven slot value.
    function commitment(uint256 value, uint64 expiry, uint256 k0x, uint256 k0y, address depositor)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(value, expiry, k0x, k0y, depositor));
    }

    /// @notice Storage key the proof builder and the phone use: keccak256(abi.encode(coinId, uint256(0))).
    function storageKey(bytes32 coinId) public pure returns (bytes32 key) {
        assembly ("memory-safe") {
            mstore(0x00, coinId)
            mstore(0x20, deposits.slot)
            key := keccak256(0x00, 0x40)
        }
    }
}
