// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Script.sol";
import "../src/LockWitnessRegistry.sol";

/// Broadcasts real transactions to anvil (Prague) so receipts include intrinsic + calldata gas.
contract AnvilGas is Script {
    function run() external {
        string memory json = vm.readFile("test/vectors.json");
        string[3] memory ks = ["n4", "n7", "n31"];
        vm.startBroadcast();
        for (uint256 j; j < ks.length; ++j) {
            string memory k = ks[j];
            LockWitnessRegistry reg = new LockWitnessRegistry(vm.parseJsonBytes(json, ".negG2"));
            bytes[] memory pks = vm.parseJsonBytesArray(json, string.concat(".", k, ".pks"));
            bytes[] memory pops = vm.parseJsonBytesArray(json, string.concat(".", k, ".pops"));
            for (uint256 i; i < pks.length; ++i) {
                reg.register{value: 0.01 ether}(pks[i], pops[i]);
            }
            reg.setCommittee(1, pks, uint32(vm.parseJsonUint(json, string.concat(".", k, ".q"))));
            reg.slashEquivocation(
                1,
                pks,
                vm.parseJsonBytes32(json, string.concat(".", k, ".nf")),
                LockWitnessRegistry.Cert(
                    vm.parseJsonBytes32(json, string.concat(".", k, ".hB")),
                    uint256(vm.parseJsonBytes32(json, string.concat(".", k, ".bitmapB"))),
                    vm.parseJsonBytes(json, string.concat(".", k, ".sigB"))
                ),
                LockWitnessRegistry.Cert(
                    vm.parseJsonBytes32(json, string.concat(".", k, ".hC")),
                    uint256(vm.parseJsonBytes32(json, string.concat(".", k, ".bitmapC"))),
                    vm.parseJsonBytes(json, string.concat(".", k, ".sigC"))
                )
            );
        }
        vm.stopBroadcast();
    }
}
