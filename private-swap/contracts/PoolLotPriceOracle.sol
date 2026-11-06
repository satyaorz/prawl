// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {ERC7984ERC20Wrapper} from
    "@openzeppelin/confidential-contracts/contracts/token/ERC7984/extensions/ERC7984ERC20Wrapper.sol";

import {ILotPriceOracle} from "./interfaces/ILotPriceOracle.sol";

/// @title PoolLotPriceOracle — lot prices read from the Uniswap v4 pool itself.
///
/// For a prototype with a single pool there is no reason to depend on external
/// feeds: the batch settles against one Uniswap v4 pool, so that pool's own
/// current price is the only number that matters.
///
/// Units: the batch divides confidential order amounts by `lotA`/`lotB`, so
/// those must be expressed in *confidential wrapper units* (6 decimals for an
/// 18-decimal underlying). The pool prices 18-decimal underlying tokens, so the
/// result is converted with each wrapper's `rate()`.
///
/// Honest limitations:
///  * The spot price of a small pool is manipulable (move the quote, let a
///    round settle at the moved price). The batch snapshots the quote when a
///    round opens and allows refunds when it expires, but a thin pool is still
///    a real risk. Do not point this at a pool holding meaningful value.
///  * There is no historical timestamp: the pool price is always "now", so
///    `updatedAt` is `block.timestamp` and the batch's freshness check always
///    passes. Round expiry is still enforced by the batch's own clock.
contract PoolLotPriceOracle is ILotPriceOracle {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint256 private constant Q96 = 1 << 96;
    /// @dev Every confidential amount is a uint64, so a lot must fit in it.
    uint256 private constant MAX_LOT = type(uint64).max;

    IPoolManager public immutable poolManager;
    ERC7984ERC20Wrapper public immutable cTokenA;
    ERC7984ERC20Wrapper public immutable cTokenB;
    PoolKey public poolKey;

    /// @notice Token A units per lot, in 18-decimal underlying units.
    uint64 public immutable lotAUnits;

    error InvalidPool();
    error InsufficientPrecision();

    constructor(
        IPoolManager poolManager_,
        ERC7984ERC20Wrapper cTokenA_,
        ERC7984ERC20Wrapper cTokenB_,
        PoolKey memory poolKey_,
        uint64 lotAUnits_
    ) {
        if (address(poolManager_) == address(0)) revert InvalidPool();
        if (address(cTokenA_) == address(0) || address(cTokenB_) == address(0)) revert InvalidPool();
        if (lotAUnits_ == 0) revert InvalidPool();
        // lotA * sqrtPriceX96 must not overflow uint256 before mulDiv sees it.
        if (uint256(lotAUnits_) * (1 << 96) > type(uint256).max / 2) revert InvalidPool();
        poolManager = poolManager_;
        cTokenA = cTokenA_;
        cTokenB = cTokenB_;
        poolKey = poolKey_;
        lotAUnits = lotAUnits_;
    }

    /// @notice lotA units of tokenA are worth lotB units of tokenB, per the pool.
    function latestLotPrice() external view returns (uint64 lotA, uint64 lotB, uint256 updatedAt) {
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(poolKey.toId());
        if (sqrtPriceX96 == 0) revert InvalidPool();

        // price of currency1 per currency0 = (sqrtPriceX96 / Q96)^2, in
        // 18-decimal units because both assets use 18 decimals. FullMath keeps
        // the 512-bit intermediate so squaring sqrtPriceX96 cannot overflow.
        uint256 lotBUnderlying = FullMath.mulDiv(
            uint256(lotAUnits) * uint256(sqrtPriceX96), uint256(sqrtPriceX96), Q96 * Q96
        );

        // Convert underlying lot sizes into the confidential units the batch
        // works in. Rounding down means a lot is never worth more than quoted.
        uint256 lotAConfidential = uint256(lotAUnits) / cTokenA.rate();
        uint256 lotBConfidential = lotBUnderlying / cTokenB.rate();
        if (lotAConfidential == 0 || lotAConfidential > MAX_LOT) revert InsufficientPrecision();
        if (lotBConfidential == 0 || lotBConfidential > MAX_LOT) revert InsufficientPrecision();

        return (uint64(lotAConfidential), uint64(lotBConfidential), block.timestamp);
    }
}
