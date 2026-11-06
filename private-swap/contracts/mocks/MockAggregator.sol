// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

contract MockAggregator {
    uint8 public immutable decimals;
    uint80 public roundId = 1;
    int256 public answer;
    uint256 public updatedAt;
    uint80 public answeredInRound = 1;
    constructor(uint8 decimals_, int256 answer_) { decimals = decimals_; answer = answer_; updatedAt = block.timestamp; }
    function set(uint80 round_, int256 answer_, uint256 at_, uint80 answered_) external {
        roundId = round_; answer = answer_; updatedAt = at_; answeredInRound = answered_;
    }
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, updatedAt, updatedAt, answeredInRound);
    }
}
