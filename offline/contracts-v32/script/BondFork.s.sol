// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {DeviceBondRegistry, IBrokenKeys} from "../src/DeviceBondRegistry.sol";
import {PrawlEscrowV31, IOtkChecker} from "../src/PrawlEscrowV31.sol";
import {IWETH, IRailgunSmartWallet} from "../src/RailgunTypes.sol";
import {IP384Verifier} from "nitro/IP384Verifier.sol";
import {P384Verifier} from "nitro/P384Verifier.sol";

/// @notice TEST-ONLY registry variant (same as seam_a's RealVectorRegistry): the phones of the 2026-11-06 run drew
///  their attestation challenges at random, so no real certificate commits to a bonder's address; this override
///  lets `bond` run on REAL proof-of-possession bytes. Caching, registration and checkOtk are the unmodified
///  DeviceBondRegistry code. Production deploys DeviceBondRegistry itself.
contract RealVectorRegistry is DeviceBondRegistry {
    mapping(address => bytes32) public challengeOverride;

    constructor(bytes[] memory roots, address gov, IBrokenKeys e, bytes32 pkg, bytes32 signer, IP384Verifier p384)
        DeviceBondRegistry(roots, Config(gov, e, 1 ether, 60 days, pkg, signer, p384))
    {}

    function setChallengeOverride(address who, bytes32 c) external {
        require(msg.sender == governance, "gov");
        challengeOverride[who] = c;
    }

    function expectedChallenge(address owner) public view override returns (bytes32) {
        bytes32 o = challengeOverride[owner];
        return o != 0 ? o : super.expectedChallenge(owner);
    }
}

/// @notice Device-bond mode on a Sepolia fork, with the REAL OnePlus RKP chain (fixtures/rkp_chain_oneplus.json):
///   deploy P384Verifier, PrawlEscrowV31 (requireBondedDevice = true) and the registry pinned to Google's
///   "Key Attestation CA1" (P-384); setRegistry; cacheIssuer Droid CA2 and Droid CA3 (hinted P-384); register the
///   RKP attestation key (P256VERIFY under CA3); bond it (real PoP leaf, test-only challenge override);
///   commitDepositAttested with the REAL one-time leaf of the run as genesis key; fund with ETH; activate.
/// Broadcast with: forge script script/BondFork.s.sol --fork-url <anvil fork> --broadcast --unlocked --sender <S> --slow
contract BondFork is Script {
    address constant RSW = 0xeCFCf3b4eC647c4Ca6D49108b311b7a7C9543fea;
    address constant WETH = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;

    function run() external {
        string memory c = vm.readFile("fixtures/rkp_chain_oneplus.json");
        address s = msg.sender;
        vm.startBroadcast();
        P384Verifier p384 = new P384Verifier();
        PrawlEscrowV31 e = new PrawlEscrowV31(1 days, 30 days, s, true, IWETH(WETH), IRailgunSmartWallet(RSW));
        bytes[] memory roots = new bytes[](1);
        roots[0] = vm.parseJsonBytes(c, ".oneplusTEE_bob[4].der"); // Key Attestation CA1 (P-384), pinned
        RealVectorRegistry reg = new RealVectorRegistry(
            roots,
            s,
            IBrokenKeys(address(e)),
            keccak256("xyz.prawl.otktest"),
            vm.parseJsonBytes32(c, ".oneplusTEE_bob[0].keyDescription.signatureDigest"),
            IP384Verifier(address(p384))
        );
        e.setRegistry(IOtkChecker(address(reg)));
        bytes32 ca2 = reg.cacheIssuer(
            vm.parseJsonBytes(c, ".oneplusTEE_bob[3].der"),
            vm.parseJsonBytes32(c, ".oneplusTEE_bob[4].spkiSha256"),
            vm.parseJsonBytes(c, ".oneplusTEE_bob[3].p384Hints")
        );
        bytes32 ca3 = reg.cacheIssuer(
            vm.parseJsonBytes(c, ".oneplusTEE_bob[2].der"), ca2, vm.parseJsonBytes(c, ".oneplusTEE_bob[2].p384Hints")
        );
        bytes32 ak = reg.registerAttestationKey(vm.parseJsonBytes(c, ".oneplusTEE_bob[1].der"), ca3, "");
        reg.setChallengeOverride(s, vm.parseJsonBytes32(c, ".oneplusTEE_charlie[0].keyDescription.attestationChallenge"));
        reg.bond{value: 1 ether}(ak, vm.parseJsonBytes(c, ".oneplusTEE_charlie[0].der"));
        // the REAL one-time key of the run (req_bob) as the genesis key of a commit-then-fund coin
        PrawlEscrowV31.DepositParams memory p = PrawlEscrowV31.DepositParams(
            keccak256(abi.encode("prawl v3.1 bonded coin", block.number)),
            uint64(block.timestamp + 7 days),
            vm.parseJsonUint(c, ".oneplusTEE_bob[0].pubX"),
            vm.parseJsonUint(c, ".oneplusTEE_bob[0].pubY"),
            s,
            0.001 ether,
            0.001 ether,
            0
        );
        address a = e.commitDepositAttested(p, vm.parseJsonBytes(c, ".oneplusTEE_bob[0].der"), ak);
        payable(a).transfer(0.001 ether);
        e.activate(p);
        vm.stopBroadcast();
        require(e.deposits(p.coinId) == e.commitment(0.001 ether, p.expiry, p.k0x, p.k0y, s), "coin");
        console.log("escrow", address(e));
        console.log("registry", address(reg));
        console.log("ak");
        console.logBytes32(ak);
    }
}
