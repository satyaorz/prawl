// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {V31Base} from "./V31Base.sol";
import {PrawlEscrowV31} from "../src/PrawlEscrowV31.sol";
import {PrawlCodec} from "../src/PrawlCodec.sol";
import {PrawlV3Codec as V3} from "../src/PrawlV3Codec.sol";
import {RailgunTypes} from "../src/RailgunTypes.sol";

/// @notice The v3.1 output kinds and deposit addresses, byte for byte against the independent Python
///  reference (fixtures/v31_vectors.json from tools/gen_v31_vectors.py), on two (chainId, escrow) pairs, and
///  against the reference PrawlCodec building blocks under fuzzing. Also: the storage layout of v3.1.
contract CodecV31Test is V31Base {
    string vx;

    function setUp() public {
        vm.warp(NOW);
        vx = vm.readFile("fixtures/v31_vectors.json");
    }

    function _escrowAt(uint256 i) internal returns (PrawlEscrowV31 esc) {
        string memory b = string.concat(".escrows[", vm.toString(i), "]");
        vm.chainId(vm.parseJsonUint(vx, string.concat(b, ".chainId")));
        esc = _deploy31(vm.parseJsonAddress(vx, string.concat(b, ".escrow")), address(0), address(0), false);
    }

    function _shieldReq(string memory b) internal view returns (RailgunTypes.ShieldRequest memory sr) {
        sr.preimage.npk = vm.parseJsonBytes32(vx, string.concat(b, ".npk"));
        sr.preimage.token.tokenType = uint8(vm.parseJsonUint(vx, string.concat(b, ".tokenType")));
        sr.preimage.token.tokenAddress = vm.parseJsonAddress(vx, string.concat(b, ".tokenAddress"));
        sr.preimage.token.tokenSubID = vm.parseJsonUint(vx, string.concat(b, ".tokenSubID"));
        sr.preimage.value = uint120(vm.parseJsonUint(vx, string.concat(b, ".value")));
        bytes32[] memory eb = vm.parseJsonBytes32Array(vx, string.concat(b, ".encryptedBundle"));
        sr.ciphertext.encryptedBundle = [eb[0], eb[1], eb[2]];
        sr.ciphertext.shieldKey = vm.parseJsonBytes32(vx, string.concat(b, ".shieldKey"));
    }

    function test_shieldKeys_matchPython() public {
        string[] memory names = vm.parseJsonStringArray(vx, ".shieldNames");
        for (uint256 i = 0; i < 2; i++) {
            PrawlEscrowV31 esc = _escrowAt(i);
            for (uint256 j = 0; j < names.length; j++) {
                string memory b = string.concat(".shields.", names[j]);
                RailgunTypes.ShieldRequest memory sr = _shieldReq(string.concat(b, ".request"));
                assertEq(abi.encode(sr), vm.parseJsonBytes(vx, string.concat(b, ".abi")), "abi.encode(ShieldRequest)");
                (bytes32 kh, bytes32 sh) = esc.shieldKeyHash(sr);
                assertEq(sh, vm.parseJsonBytes32(vx, string.concat(b, ".shieldHash")), "shieldHash");
                assertEq(kh, vm.parseJsonBytes32(vx, string.concat(b, ".keyHash[", vm.toString(i), "]")), "shield key");
            }
        }
    }

    function test_refreshKeysAndIds_matchPython() public {
        string[] memory names = vm.parseJsonStringArray(vx, ".refreshNames");
        for (uint256 i = 0; i < 2; i++) {
            PrawlEscrowV31 esc = _escrowAt(i);
            for (uint256 j = 0; j < names.length; j++) {
                string memory b = string.concat(".refreshes.", names[j], ".");
                bytes32 kh = esc.refreshKeyHash(
                    uint64(vm.parseJsonUint(vx, string.concat(b, "expiry"))),
                    vm.parseJsonUint(vx, string.concat(b, "k0x")),
                    vm.parseJsonUint(vx, string.concat(b, "k0y")),
                    vm.parseJsonAddress(vx, string.concat(b, "depositor"))
                );
                assertEq(kh, vm.parseJsonBytes32(vx, string.concat(b, "keyHash[", vm.toString(i), "]")), "refresh key");
            }
        }
        for (uint256 k = 0; k < 6; k++) {
            string memory b = string.concat(".ids[", vm.toString(k), "].");
            assertEq(
                V3.refreshCoinId(vm.parseJsonBytes32(vx, string.concat(b, "msgHash")), vm.parseJsonUint(vx, string.concat(b, "index"))),
                vm.parseJsonBytes32(vx, string.concat(b, "coinId"))
            );
        }
    }

    function test_depositAddresses_matchPython() public {
        string[] memory names = vm.parseJsonStringArray(vx, ".depositNames");
        for (uint256 i = 0; i < 2; i++) {
            PrawlEscrowV31 esc = _escrowAt(i);
            for (uint256 j = 0; j < names.length; j++) {
                string memory b = string.concat(".deposits.", names[j], ".");
                string memory q = string.concat(b, "params.");
                PrawlEscrowV31.DepositParams memory p = PrawlEscrowV31.DepositParams(
                    vm.parseJsonBytes32(vx, string.concat(q, "coinId")),
                    uint64(vm.parseJsonUint(vx, string.concat(q, "expiry"))),
                    vm.parseJsonUint(vx, string.concat(q, "k0x")),
                    vm.parseJsonUint(vx, string.concat(q, "k0y")),
                    vm.parseJsonAddress(vx, string.concat(q, "depositor")),
                    vm.parseJsonUint(vx, string.concat(q, "minValue")),
                    vm.parseJsonUint(vx, string.concat(q, "maxValue")),
                    vm.parseJsonUint(vx, string.concat(q, "tip"))
                );
                assertEq(esc.depositParamsHash(p), vm.parseJsonBytes32(vx, string.concat(b, "paramsHash")));
                assertEq(esc.depositAddress(p), vm.parseJsonAddress(vx, string.concat(b, "address[", vm.toString(i), "]")));
            }
        }
    }

    /// The forwarder the escrow deploys is exactly the documented 56 bytes, with this escrow's address inside.
    function test_forwarderBytecode() public {
        _setUp31(false);
        (PrawlEscrowV31.DepositParams memory p,) = _params("fw", address(0xD), 1, 1, 0);
        address a = e.depositAddress(p);
        _fundEth(a, 1);
        e.activate(p);
        assertEq(
            a.code,
            bytes.concat(hex"73", bytes20(address(e)), hex"3314601b57005b604036038060405f375f5f825f6020355f355af16036575f5ffd5b00")
        );
    }

    /// New output kinds are domain-separated from v3 REDEEM outputs and from each other (prefixes differ).
    function testFuzz_kindsDisjoint(address payout, bytes32 sh, uint64 exp, bytes32 kh, address dep) public pure {
        bytes32 a = V3.redeemTarget(11155111, address(0xE5C31), payout);
        bytes32 b = V3.shieldTarget(11155111, address(0xE5C31), sh);
        bytes32 c = V3.refreshTarget(11155111, address(0xE5C31), exp, kh, dep);
        assertTrue(a != b && b != c && a != c);
        // the shield target is the sha256 of exactly this string (reference building blocks)
        assertEq(
            b,
            sha256(abi.encodePacked("PRAWL-REDEEM-SHIELD|11155111|", PrawlCodec.hexAddr(address(0xE5C31)), "|", PrawlCodec.hex32(sh)))
        );
        assertEq(
            c,
            sha256(
                abi.encodePacked(
                    "PRAWL-REFRESH|11155111|",
                    PrawlCodec.hexAddr(address(0xE5C31)),
                    "|",
                    PrawlCodec.dec(exp),
                    "|",
                    PrawlCodec.hex32(kh),
                    "|",
                    PrawlCodec.hexAddr(dep)
                )
            )
        );
    }

    /// v3 slots 0..6 unchanged; v3.1 adds pendingDeposits at slot 7.
    function test_storage_v31_layout() public {
        _setUp31(false);
        (PrawlEscrowV31.DepositParams memory p,) = _params("lay", address(0xD), 1, 1, 0);
        e.commitDeposit(p);
        assertEq(vm.load(address(e), keccak256(abi.encode(p.coinId, uint256(7)))), e.depositParamsHash(p));
        _fundEth(e.depositAddress(p), 1);
        e.activate(p);
        assertEq(vm.load(address(e), keccak256(abi.encode(p.coinId, uint256(0)))), e.commitment(1, p.expiry, p.k0x, p.k0y, address(0xD)));
        assertEq(vm.load(address(e), keccak256(abi.encode(p.coinId, uint256(7)))), bytes32(0));
    }
}
