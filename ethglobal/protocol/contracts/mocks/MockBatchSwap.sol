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

    constructor(
        address router_,
        address permit2_,
        address cTokenA_,
        address cTokenB_,
        PoolKey memory poolKey_,
        uint256 minRoundDuration_,
        uint256 minDistinctSubmitters_,
        address settler_,
        address swapReserve_
    ) VeilBatchSwap(router_, permit2_, cTokenA_, cTokenB_, poolKey_, minRoundDuration_, minDistinctSubmitters_, settler_) {
        swapReserve = swapReserve_;
    }

    function _swapExactInput(IERC20 tokenIn, IERC20 tokenOut, uint256 amountIn) internal override returns (uint256) {
        // 1:1 mock: the reserve pre-approved this contract and holds tokenOut.
        tokenOut.transferFrom(swapReserve, address(this), amountIn);
        return amountIn;
    }
}
