// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ERC7984} from "@openzeppelin/confidential-contracts/contracts/token/ERC7984/ERC7984.sol";
import {ERC7984ERC20Wrapper} from "@openzeppelin/confidential-contracts/contracts/token/ERC7984/extensions/ERC7984ERC20Wrapper.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/interfaces/IERC20Metadata.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

/// @title VeilConfidentialWrapper — confidential (ERC-7984) wrapper of a demo token.
/// Balances are euint64 ciphertexts; transfers reveal only sender/receiver addresses.
contract VeilConfidentialWrapper is ZamaEthereumConfig, ERC7984ERC20Wrapper {
    constructor(address assetAddress)
        ERC7984(
            string.concat("Veil c", IERC20Metadata(assetAddress).name()),
            string.concat("c", IERC20Metadata(assetAddress).symbol()),
            ""
        )
        ERC7984ERC20Wrapper(IERC20(assetAddress))
    {}
}
