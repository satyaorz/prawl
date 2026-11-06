// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// Hardhat only compiles the Solidity reachable from `contracts/`. The local
// end-to-end harness deploys the real Uniswap v4 contracts straight from their
// artifacts, so this file exists purely to keep them in the build graph.
//
// Nothing here is deployed. The imports have no side effects on the product
// contracts, and a build without the harness dependencies simply fails on this
// one file rather than on VeilBatchSwap itself.
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {UniversalRouter} from "@uniswap/universal-router/contracts/UniversalRouter.sol";
import {Permit2} from "@uniswap/permit2/src/Permit2.sol";

/// @notice Compile-time marker that pulls the Uniswap stack into the artifacts.
contract HarnessImports {
    // Referencing the types in a private function keeps solc from warning about
    // unused imports while producing no runtime code of consequence.
    function _types() private pure {
        PoolManager;
    }
}
