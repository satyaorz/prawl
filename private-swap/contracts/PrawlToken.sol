// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Fixed-supply 18-decimal token for the Prawl swap pair.
/// @dev Supply, recipient, distribution, feed and liquidity are deployment
///      decisions. This contract has no post-deployment minting authority.
contract PrawlToken is ERC20 {
    constructor(string memory name_, string memory symbol_, address initialHolder, uint256 supply)
        ERC20(name_, symbol_)
    {
        require(bytes(name_).length != 0 && bytes(symbol_).length != 0, "empty metadata");
        require(initialHolder != address(0) && supply != 0, "invalid initial supply");
        _mint(initialHolder, supply);
    }
}
