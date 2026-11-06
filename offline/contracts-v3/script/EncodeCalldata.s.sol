// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {PrawlEscrowV3} from "../src/PrawlEscrowV3.sol";
import {PrawlV3Codec as V3} from "../src/PrawlV3Codec.sol";

/// @notice Writes ABI calldata for the anvil receipt run (tools/anvil_receipts.sh) to logs/calldata/:
///  <name>.hex for each listed redemption and proveEquivocation, read from fixtures/v3_synthetic.json.
///  No transactions are sent here; cast sends the raw calldata.
contract EncodeCalldata is Script {
    string fx;

    function run() external {
        fx = vm.readFile("fixtures/v3_synthetic.json");
        string[16] memory names = [
            "gas_d0_f2", "gas_d1_f2", "gas_d1_f2_sib", "gas_d1_f4", "gas_d1_f4_sib", "gas_d2_f2", "gas_d2_f2_sib",
            "gas_d2_f4", "gas_d2_f4_sib", "gas_d3_f2", "gas_d3_f2_sib", "gas_d3_f4", "gas_d3_f4_sib", "gas_d16_f2",
            "tree_gina2a", "eq_dan"
        ];
        for (uint256 i = 0; i < names.length; i++) {
            vm.writeFile(string.concat("logs/calldata/", names[i], ".hex"), vm.toString(_redeemCall(names[i])));
        }
        // REAL phone v3 redemption(s), if converted (fixtures/v3_phone.json)
        if (vm.exists("fixtures/v3_phone.json")) {
            string memory syn = fx;
            fx = vm.readFile("fixtures/v3_phone.json");
            string[] memory pn = vm.parseJsonStringArray(fx, ".redeemNames");
            for (uint256 i = 0; i < pn.length; i++) {
                vm.writeFile(string.concat("logs/calldata/phone_", pn[i], ".hex"), vm.toString(_redeemCall(pn[i])));
            }
            fx = syn;
        }
        // the tree's prefix for tree_gina2a (so it runs as a cold path), eq_cat before eq_dan (the conflict)
        vm.writeFile("logs/calldata/eq_cat.hex", vm.toString(_redeemCall("eq_cat")));
        string[] memory eqs = vm.parseJsonStringArray(fx, ".equivocationNames");
        for (uint256 i = 0; i < eqs.length; i++) {
            string memory b = string.concat(".equivocations.", eqs[i]);
            string memory coin = vm.parseJsonString(fx, string.concat(b, ".coin"));
            if (keccak256(bytes(coin)) != keccak256("eq0")) continue;
            bytes memory cd = abi.encodeCall(
                PrawlEscrowV3.proveEquivocation,
                (_header(coin), _path(b), _signed(string.concat(b, ".a")), _signed(string.concat(b, ".b")))
            );
            vm.writeFile("logs/calldata/prove_eq0.hex", vm.toString(cd));
        }
    }

    function _redeemCall(string memory name) internal view returns (bytes memory) {
        string memory coin = vm.parseJsonString(fx, string.concat(".redeems.", name, ".coin"));
        string memory b = string.concat(".redeems.", name);
        PrawlEscrowV3.Redemption memory rd;
        rd.outputs = _outputs(string.concat(b, ".redeem"));
        rd.index = vm.parseJsonUint(fx, string.concat(b, ".redeem.index"));
        rd.payout = vm.parseJsonAddress(fx, string.concat(b, ".payout"));
        rd.r = vm.parseJsonBytes32(fx, string.concat(b, ".redeem.r"));
        rd.s = vm.parseJsonBytes32(fx, string.concat(b, ".redeem.s"));
        return abi.encodeCall(PrawlEscrowV3.redeem, (_header(coin), _path(b), rd));
    }

    function _header(string memory coin) internal view returns (PrawlEscrowV3.Header memory h) {
        string memory b = string.concat(".coins.", coin, ".");
        h.coinId = vm.parseJsonBytes32(fx, string.concat(b, "coinId"));
        h.value = vm.parseJsonUint(fx, string.concat(b, "value"));
        h.expiry = uint64(vm.parseJsonUint(fx, string.concat(b, "expiry")));
        h.k0x = uint256(vm.parseJsonBytes32(fx, string.concat(b, "k0x")));
        h.k0y = uint256(vm.parseJsonBytes32(fx, string.concat(b, "k0y")));
        h.depositor = vm.parseJsonAddress(fx, string.concat(b, "depositor"));
    }

    function _outputs(string memory b) internal view returns (V3.Output[] memory o) {
        uint256[] memory v = vm.parseJsonUintArray(fx, string.concat(b, ".values"));
        bytes32[] memory k = vm.parseJsonBytes32Array(fx, string.concat(b, ".keyHashes"));
        o = new V3.Output[](v.length);
        for (uint256 i = 0; i < v.length; i++) o[i] = V3.Output(v[i], k[i]);
    }

    function _path(string memory base) internal view returns (PrawlEscrowV3.Spend[] memory p) {
        uint256 n = vm.parseJsonUint(fx, string.concat(base, ".nPath"));
        p = new PrawlEscrowV3.Spend[](n);
        for (uint256 i = 0; i < n; i++) {
            string memory b = string.concat(base, ".path[", vm.toString(i), "]");
            p[i].outputs = _outputs(b);
            p[i].index = vm.parseJsonUint(fx, string.concat(b, ".index"));
            p[i].r = vm.parseJsonBytes32(fx, string.concat(b, ".r"));
            p[i].s = vm.parseJsonBytes32(fx, string.concat(b, ".s"));
            p[i].nextX = vm.parseJsonBytes32(fx, string.concat(b, ".nextX"));
            p[i].nextY = vm.parseJsonBytes32(fx, string.concat(b, ".nextY"));
        }
    }

    function _signed(string memory b) internal view returns (PrawlEscrowV3.Signed memory s) {
        s.message = vm.parseJsonBytes(fx, string.concat(b, ".message"));
        s.r = vm.parseJsonBytes32(fx, string.concat(b, ".r"));
        s.s = vm.parseJsonBytes32(fx, string.concat(b, ".s"));
    }
}
