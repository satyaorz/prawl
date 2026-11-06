// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {EscrowV3Storage} from "../src/EscrowV3Storage.sol";

contract EscrowV3StorageTest is Test {
    EscrowV3Storage e;
    address alice = address(0xA11CE);

    // The coinId and storage key used by the Python builder for the real-Sepolia non-inclusion proof
    // (deposit_proofs/data/absent_coin_id.txt and proof_absent_coin.json "storage.key").
    bytes32 constant PY_COIN = 0xa45860a2283f7e14075bc4576d9cf53b4aff58ac15c6088394f60d0820e9402f;
    bytes32 constant PY_KEY = 0xb0ac2344e2fd8e92701c9304e2caadd2428d3d1128361149dc3dfa30900b91ab;

    function setUp() public {
        e = new EscrowV3Storage();
        vm.deal(alice, 10 ether);
    }

    function test_depositsIsSlotZero() public view {
        // storageKey() hashes with deposits.slot; equality with a literal 0 asserts the compiler put it at slot 0.
        assertEq(e.storageKey(bytes32(uint256(1))), keccak256(abi.encode(bytes32(uint256(1)), uint256(0))));
    }

    function test_slotMatchesBuilderFormula(bytes32 coinId, uint64 expiry, uint256 k0x, uint256 k0y, uint96 value) public {
        vm.assume(value > 0 && value <= 10 ether);
        vm.prank(alice);
        e.deposit{value: value}(coinId, expiry, k0x, k0y);
        bytes32 key = keccak256(abi.encode(coinId, uint256(0)));
        bytes32 expected = keccak256(abi.encode(uint256(value), expiry, k0x, k0y, alice));
        assertEq(vm.load(address(e), key), expected, "raw slot != commitment");
        assertEq(e.deposits(coinId), expected);
        assertEq(e.storageKey(coinId), key);
    }

    function test_pythonKeyVector() public view {
        assertEq(e.storageKey(PY_COIN), PY_KEY, "Solidity storage key != Python builder key");
    }

    function test_reuseReverts() public {
        vm.startPrank(alice);
        e.deposit{value: 1}(bytes32(uint256(7)), 1, 2, 3);
        vm.expectRevert(abi.encodeWithSelector(EscrowV3Storage.CoinIdUsed.selector, bytes32(uint256(7))));
        e.deposit{value: 1}(bytes32(uint256(7)), 1, 2, 3);
        vm.stopPrank();
    }

    function test_absentSlotIsZero(bytes32 coinId) public view {
        assertEq(vm.load(address(e), keccak256(abi.encode(coinId, uint256(0)))), bytes32(0));
    }
}
