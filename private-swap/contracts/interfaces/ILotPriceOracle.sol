// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @notice Quote for exchanging exact whole lots of two confidential assets.
/// @dev A production implementation must derive a manipulation-resistant price
///      and return the timestamp of the observations underlying that price.
interface ILotPriceOracle {
    function latestLotPrice() external view returns (uint64 lotA, uint64 lotB, uint256 updatedAt);
}
