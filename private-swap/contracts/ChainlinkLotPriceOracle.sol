// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ILotPriceOracle} from "./interfaces/ILotPriceOracle.sol";

interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @notice Crosses two independent USD feeds into a token A:B lot price.
/// @dev Both underlyings must have 18 decimals and their ERC-7984 wrappers
///      must use six decimals. Deployment must verify feed/asset mappings,
///      feed independence, liquidity and heartbeat. This is unaudited.
contract ChainlinkLotPriceOracle is ILotPriceOracle {
    uint64 public immutable lotAUnits;
    uint256 private constant MAX_NORMALIZED_PRICE = 1e30;
    IAggregatorV3 public immutable feedA;
    IAggregatorV3 public immutable feedB;
    uint8 public immutable decimalsA;
    uint8 public immutable decimalsB;
    uint16 public immutable maxRoundingBps;

    error InvalidFeed();
    error InsufficientPrecision();

    constructor(address tokenA, address tokenB, address feedA_, address feedB_, uint64 lotAUnits_, uint16 maxRoundingBps_) {
        require(tokenA != address(0) && tokenB != address(0) && tokenA != tokenB, "invalid tokens");
        require(feedA_ != address(0) && feedB_ != address(0) && feedA_ != feedB_, "invalid feeds");
        require(IERC20Metadata(tokenA).decimals() == 18 && IERC20Metadata(tokenB).decimals() == 18, "unsupported token decimals");
        require(maxRoundingBps_ <= 100, "rounding bound too high");
        require(lotAUnits_ > 0 && lotAUnits_ <= type(uint64).max / 6, "invalid lot size");
        lotAUnits = lotAUnits_;
        feedA = IAggregatorV3(feedA_);
        feedB = IAggregatorV3(feedB_);
        decimalsA = IAggregatorV3(feedA_).decimals();
        decimalsB = IAggregatorV3(feedB_).decimals();
        require(decimalsA <= 18 && decimalsB <= 18, "unsupported feed decimals");
        maxRoundingBps = maxRoundingBps_;
    }

    function latestLotPrice() external view returns (uint64 lotA, uint64 lotB, uint256 updatedAt) {
        (uint256 a, uint256 atA) = _read(feedA, decimalsA);
        (uint256 b, uint256 atB) = _read(feedB, decimalsB);
        uint256 numerator = a * lotAUnits;
        uint256 output = numerator / b;
        if (output == 0 || output > type(uint64).max) revert InsufficientPrecision();
        // Exact inequality avoids accepting rounding above the configured
        // bound because of integer division truncation.
        if ((numerator % b) * 10_000 > numerator * maxRoundingBps) revert InsufficientPrecision();
        return (lotAUnits, uint64(output), atA < atB ? atA : atB);
    }

    function _read(IAggregatorV3 feed, uint8 decimals_) private view returns (uint256 price, uint256 updatedAt) {
        (uint80 roundId, int256 answer,, uint256 at, uint80 answeredInRound) = feed.latestRoundData();
        if (roundId == 0 || answer <= 0 || at == 0 || at > block.timestamp || answeredInRound < roundId) revert InvalidFeed();
        uint256 multiplier = 10 ** (18 - uint256(decimals_));
        if (uint256(answer) > MAX_NORMALIZED_PRICE / multiplier) revert InvalidFeed();
        price = uint256(answer) * multiplier;
        return (price, at);
    }
}
