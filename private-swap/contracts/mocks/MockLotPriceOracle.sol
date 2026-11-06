// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ILotPriceOracle} from "../interfaces/ILotPriceOracle.sol";

contract MockLotPriceOracle is ILotPriceOracle {
    uint64 public a;
    uint64 public b;
    uint256 public updatedAt;

    constructor(uint64 lotA, uint64 lotB) { setPrice(lotA, lotB, block.timestamp); }
    function setPrice(uint64 lotA, uint64 lotB, uint256 timestamp) public { a = lotA; b = lotB; updatedAt = timestamp; }
    function latestLotPrice() external view returns (uint64, uint64, uint256) { return (a, b, updatedAt); }
}
