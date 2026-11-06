// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {VeilBatchSwap} from "../VeilBatchSwap.sol";

/// @notice Test double for VeilBatchSwap: replaces the Uniswap leg with a 1:1
/// pull from a pre-funded reserve, so the full FHE round lifecycle can be
/// validated on the local FHEVM mock network without a real pool.
contract MockBatchSwap is VeilBatchSwap {
    address public immutable swapReserve;
    uint256 public outputBps = 10_000;

    function setOutputBps(uint256 bps) external { outputBps = bps; }

    constructor(
        address router_,
        address permit2_,
        address cTokenA_,
        address cTokenB_,
        PoolKey memory poolKey_,
        uint256 minRoundDuration_,
        uint256 minDistinctSubmitters_,
        uint256 refundDelay_,
        address swapReserve_,
        address priceOracle_,
        uint256 maxPriceAge_
    ) VeilBatchSwap(router_, permit2_, cTokenA_, cTokenB_, poolKey_, minRoundDuration_, minDistinctSubmitters_, refundDelay_, priceOracle_, maxPriceAge_) {
        swapReserve = swapReserve_;
    }

    function _swapExactInput(IERC20 tokenIn, IERC20 tokenOut, uint256 amountIn, uint256, uint64 lotA, uint64 lotB) internal override returns (uint256) {
        // 1:1 mock: the reserve pre-approved this contract and holds tokenOut.
        bool aToB = address(tokenIn) == address(cTokenA.underlying());
        uint256 inputLot = aToB ? lotA : lotB;
        uint256 outputLot = aToB ? lotB : lotA;
        uint256 rateIn = aToB ? cTokenA.rate() : cTokenB.rate();
        uint256 rateOut = aToB ? cTokenB.rate() : cTokenA.rate();
        uint256 amountOut = amountIn / rateIn * outputLot / inputLot * outputBps / 10_000 * rateOut;
        tokenOut.transferFrom(swapReserve, address(this), amountOut);
        return amountOut;
    }
}
