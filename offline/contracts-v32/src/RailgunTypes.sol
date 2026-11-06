// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice RAILGUN RailgunSmartWallet types, exactly as in kohaku-rs `crates/railgun/src/abis/railgun.rs` (sol!).
///  Verified against Sepolia (read-only, 2026-11-06): proxy 0xeCFCf3b4eC647c4Ca6D49108b311b7a7C9543fea,
///  implementation 0x16dc2574cc30e4deecfb9ba22d95e5126a2fc0b3 contains selector 0x044a40c3 =
///  shield(((bytes32,(uint8,address,uint256),uint120),(bytes32[3],bytes32))[]) and the Shield event topic
///  0x3a5b9dc26075a3801a6ddccf95fec485bb7500a91b44cec1add984c21ee6db3b. The enum TokenType is ABI-encoded as uint8.
///  Every field is static, so abi.encode(ShieldRequest) is exactly 9 words (288 bytes):
///    npk, tokenType, tokenAddress, tokenSubID, value, encryptedBundle[0..2], shieldKey.
library RailgunTypes {
    struct TokenData {
        uint8 tokenType; // 0 = ERC20, 1 = ERC721, 2 = ERC1155
        address tokenAddress;
        uint256 tokenSubID;
    }

    struct CommitmentPreimage {
        bytes32 npk; // Poseidon(Poseidon(master public key, random)): the recipient's note public key
        TokenData token;
        uint120 value; // gross amount pulled from msg.sender; RAILGUN keeps the shield fee from it
    }

    struct ShieldCiphertext {
        bytes32[3] encryptedBundle; // IV/tag, random (encrypted), receiver viewing key material
        bytes32 shieldKey; // ephemeral public key for the shared secret
    }

    struct ShieldRequest {
        CommitmentPreimage preimage;
        ShieldCiphertext ciphertext;
    }
}

interface IRailgunSmartWallet {
    function shield(RailgunTypes.ShieldRequest[] calldata _shieldRequests) external;
}

/// @notice WETH9 (Sepolia 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14 = RAILGUN's wrappedBaseToken there).
interface IWETH {
    function deposit() external payable;
    function withdraw(uint256 wad) external;
    function balanceOf(address who) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 wad) external returns (bool);
    function transfer(address to, uint256 wad) external returns (bool);
}
