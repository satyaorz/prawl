// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {RailgunTypes} from "../src/RailgunTypes.sol";

/// @notice WETH9 semantics (incl. withdraw via `transfer`, i.e. a 2300-gas stipend, and an allowance of
///  type(uint256).max that is never decremented). LOCAL TESTS ONLY; the fork tests use the real Sepolia WETH.
contract MockWETH9 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 wad);

    receive() external payable {
        deposit();
    }

    function deposit() public payable {
        balanceOf[msg.sender] += msg.value;
    }

    function withdraw(uint256 wad) external {
        require(balanceOf[msg.sender] >= wad);
        balanceOf[msg.sender] -= wad;
        payable(msg.sender).transfer(wad);
    }

    function approve(address guy, uint256 wad) external returns (bool) {
        allowance[msg.sender][guy] = wad;
        return true;
    }

    function transfer(address dst, uint256 wad) external returns (bool) {
        return transferFrom(msg.sender, dst, wad);
    }

    function transferFrom(address src, address dst, uint256 wad) public returns (bool) {
        require(balanceOf[src] >= wad);
        if (src != msg.sender && allowance[src][msg.sender] != type(uint256).max) {
            require(allowance[src][msg.sender] >= wad);
            allowance[src][msg.sender] -= wad;
        }
        balanceOf[src] -= wad;
        balanceOf[dst] += wad;
        emit Transfer(src, dst, wad);
        return true;
    }
}

/// @notice Stand-in for RailgunSmartWallet.shield with the same ABI, the same Shield event and RAILGUN's
///  inclusive fee rule (base = value - value*fee/10000, fee to the treasury). It does not hash or insert
///  commitments. LOCAL TESTS ONLY; the fork tests call the real contract.
contract MockRailgun {
    uint120 public constant shieldFee = 25;
    address public immutable treasury = address(0x7EA5);
    MockWETH9 public immutable weth;
    uint256 public nextLeafIndex;

    event Shield(
        uint256 treeNumber,
        uint256 startPosition,
        RailgunTypes.CommitmentPreimage[] commitments,
        RailgunTypes.ShieldCiphertext[] shieldCiphertext,
        uint256[] fees
    );

    constructor(MockWETH9 w) {
        weth = w;
    }

    function shield(RailgunTypes.ShieldRequest[] calldata reqs) external {
        RailgunTypes.CommitmentPreimage[] memory cs = new RailgunTypes.CommitmentPreimage[](reqs.length);
        RailgunTypes.ShieldCiphertext[] memory cts = new RailgunTypes.ShieldCiphertext[](reqs.length);
        uint256[] memory fees = new uint256[](reqs.length);
        for (uint256 i = 0; i < reqs.length; i++) {
            RailgunTypes.CommitmentPreimage calldata p = reqs[i].preimage;
            require(p.value > 0 && p.token.tokenType == 0 && p.token.tokenAddress == address(weth), "invalid preimage");
            uint120 fee = uint120((uint256(p.value) * shieldFee) / 10000);
            uint120 base = p.value - fee;
            weth.transferFrom(msg.sender, address(this), base);
            weth.transferFrom(msg.sender, treasury, fee);
            cs[i] = RailgunTypes.CommitmentPreimage(p.npk, p.token, base);
            cts[i] = reqs[i].ciphertext;
            fees[i] = fee;
        }
        emit Shield(0, nextLeafIndex, cs, cts, fees);
        nextLeafIndex += reqs.length;
    }
}

/// @notice Sends ETH with a 2300-gas stipend (`transfer`), like WETH9.withdraw or old wallets.
contract StipendSender {
    function send(address payable to) external payable {
        to.transfer(msg.value);
    }
}
