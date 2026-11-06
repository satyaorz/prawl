// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {DeviceBondRegistry, IBrokenKeys} from "../src/DeviceBondRegistry.sol";
import {P384Verifier} from "nitro/P384Verifier.sol";
import {PrawlAttestedEscrow, IOtkChecker} from "../src/PrawlAttestedEscrow.sol";
import {PrawlRealEscrow} from "../src/PrawlRealEscrow.sol";
import {AndroidAttestation as AA} from "../src/attest/AndroidAttestation.sol";

/// @notice TEST-ONLY: the phones generated their attestation challenges at random (the test app predates
///  this registry), so a real certificate cannot commit to a bonder's address. This override lets a test
///  declare "bonder B's expected challenge is the real random challenge in cert X", which exercises the
///  on-chain challenge parsing and comparison with real bytes. Production uses the base function.
contract RealVectorRegistry is DeviceBondRegistry {
    mapping(address => bytes32) public challengeOverride;

    constructor(bytes[] memory roots, address gov, IBrokenKeys e, bytes32 pkg, bytes32 signer)
        DeviceBondRegistry(roots, Config(gov, e, 1 ether, 60 days, pkg, signer, new P384Verifier()))
    {}

    function setChallengeOverride(address who, bytes32 c) external {
        challengeOverride[who] = c;
    }

    function expectedChallenge(address owner) public view override returns (bytes32) {
        bytes32 o = challengeOverride[owner];
        return o != 0 ? o : super.expectedChallenge(owner);
    }
}

contract BondedDeviceTest is Test {
    uint256 constant NOW = 1_793_966_400; // 2026-11-06 12:00 UTC: inside every real certificate's validity
    string chains;
    string pays;
    string leaked;
    RealVectorRegistry reg;
    PrawlAttestedEscrow esc;
    bytes32 rsaRootId;
    bytes32 ca1Id;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address dave = makeAddr("dave");
    address mallory = makeAddr("mallory");
    address reporter = makeAddr("reporter");

    function setUp() public {
        vm.warp(NOW);
        chains = vm.readFile("fixtures/chains.json");
        pays = vm.readFile("fixtures/payments.json");
        leaked = vm.readFile("fixtures/leaked_keybox.json");
        esc = new PrawlAttestedEscrow(1 days, false, false);
        bytes[] memory roots = new bytes[](2);
        roots[0] = _der("samsungSB_mint_c1", 3); // Google hardware attestation root, RSA-4096
        roots[1] = _der("oneplusTEE_bob", 4); // Google "Key Attestation CA1", P-384 (RKP chains)
        reg = new RealVectorRegistry(
            roots,
            address(this),
            IBrokenKeys(address(esc)),
            keccak256("xyz.prawl.otktest"),
            vm.parseJsonBytes32(chains, ".oneplusTEE_bob[0].keyDescription.signatureDigest")
        );
        esc.setRegistry(IOtkChecker(address(reg)));
        rsaRootId = vm.parseJsonBytes32(chains, ".samsungSB_mint_c1[3].spkiSha256");
        ca1Id = vm.parseJsonBytes32(chains, ".oneplusTEE_bob[4].spkiSha256");
        vm.deal(alice, 10 ether);
        vm.deal(mallory, 10 ether);
    }

    function _der(string memory chain, uint256 i) internal view returns (bytes memory) {
        return vm.parseJsonBytes(chains, string.concat(".", chain, "[", vm.toString(i), "].der"));
    }

    function _hints(string memory chain, uint256 i) internal view returns (bytes memory) {
        return vm.parseJsonBytes(chains, string.concat(".", chain, "[", vm.toString(i), "].p384Hints"));
    }

    function _id(string memory chain, uint256 i) internal view returns (bytes32) {
        return vm.parseJsonBytes32(chains, string.concat(".", chain, "[", vm.toString(i), "].spkiSha256"));
    }

    /// Trustless: Google P-384 root -> Droid CA2 -> Droid CA3 -> OnePlus RKP attestation key.
    function _registerOnePlus() internal returns (bytes32 ak) {
        string memory n = "oneplusTEE_bob";
        bytes memory c3 = _der(n, 3);
        bytes memory h3 = _hints(n, 3);
        uint256 g = gasleft();
        bytes32 ca2 = reg.cacheIssuer(c3, ca1Id, h3);
        console.log("cacheIssuer Droid CA2 (P-384 by CA1, SHA-384), gas:", g - gasleft());
        bytes memory c2 = _der(n, 2);
        bytes memory h2 = _hints(n, 2);
        g = gasleft();
        bytes32 ca3 = reg.cacheIssuer(c2, ca2, h2);
        console.log("cacheIssuer Droid CA3 (P-384 by CA2, SHA-384), gas:", g - gasleft());
        bytes memory c1 = _der(n, 1);
        g = gasleft();
        ak = reg.registerAttestationKey(c1, ca3, "");
        console.log("registerAttestationKey OnePlus RKP AK (P-256 by CA3), gas:", g - gasleft());
        assertEq(ak, _id(n, 1));
    }

    /// Trustless: Google RSA-4096 root -> Samsung StrongBox intermediate (P-384) -> factory StrongBox AK.
    function _registerSamsung() internal returns (bytes32 ak) {
        string memory n = "samsungSB_mint_c1";
        bytes memory c2 = _der(n, 2);
        uint256 g = gasleft();
        bytes32 i2 = reg.cacheIssuer(c2, rsaRootId, "");
        console.log("cacheIssuer Samsung StrongBox intermediate (RSA-4096 MODEXP), gas:", g - gasleft());
        bytes memory c1 = _der(n, 1);
        bytes memory h1 = _hints(n, 1);
        g = gasleft();
        ak = reg.registerAttestationKey(c1, i2, h1);
        console.log("registerAttestationKey Samsung factory AK (hinted P-384), gas:", g - gasleft());
    }

    // ------------------------------------------------------------------ registration

    function test_trustlessRegistration_bothRealChains() public {
        bytes32 a1 = _registerOnePlus();
        bytes32 a2 = _registerSamsung();
        (,,,,, bool rkp1) = reg.attKeys(a1);
        (,,,,, bool rkp2) = reg.attKeys(a2);
        assertTrue(rkp1, "OnePlus AK carries the RKP provisioning-info extension");
        assertFalse(rkp2, "Samsung StrongBox AK is factory-provisioned");
    }

    function test_governanceShortcut_vs_trustless() public {
        bytes memory ca3 = _der("oneplusTEE_bob", 2);
        uint256 g = gasleft();
        bytes32 id = reg.governanceRegisterIssuer(ca3, 2);
        console.log("governanceRegisterIssuer Droid CA3 (no chain verification), gas:", g - gasleft());
        bytes memory ak = _der("oneplusTEE_bob", 1);
        g = gasleft();
        reg.registerAttestationKey(ak, id, "");
        console.log("registerAttestationKey under governance CA3, gas:", g - gasleft());
        vm.prank(mallory);
        vm.expectRevert(DeviceBondRegistry.OnlyGovernance.selector);
        reg.governanceRegisterIssuer(_der("samsungSB_mint_c1", 2), 1);
    }

    function test_registration_rejects() public {
        bytes32 ak = _registerOnePlus();
        bytes32 ca3 = _id("oneplusTEE_bob", 2);
        // an AK is not an issuer: nothing can be registered "under" it
        vm.expectRevert(abi.encodeWithSelector(DeviceBondRegistry.UnknownIssuer.selector, ak));
        reg.registerAttestationKey(_der("oneplusTEE_bob", 0), ak, "");
        // even if governance wrongly made the AK an issuer, an attested leaf can never become an AK
        bytes32 akAsIssuer = reg.governanceRegisterIssuer(_der("oneplusTEE_bob", 1), 2);
        vm.expectRevert(DeviceBondRegistry.IsAttestedLeaf.selector);
        reg.registerAttestationKey(_der("oneplusTEE_bob", 0), akAsIssuer, "");
        // Samsung's AK is not signed by Droid CA3
        vm.expectRevert(DeviceBondRegistry.NameMismatch.selector);
        reg.registerAttestationKey(_der("samsungSB_mint_c1", 1), ca3, "");
        // validity: after the RKP AK expires (2026-11-17) it can no longer attest deposits
        vm.warp(1_795_400_000); // 2026-11-23
        vm.expectRevert(DeviceBondRegistry.OutsideValidity.selector);
        reg.checkOtk(_der("oneplusTEE_bob", 0), ak);
    }

    // ------------------------------------------------------------------ attested deposits (REAL genesis certificates)

    function test_depositAttested_realC1_thenRealTwoHopRedeem() public {
        bytes32 ak = _registerSamsung();
        bytes memory leaf = _der("samsungSB_mint_c1", 0);
        vm.prank(alice);
        uint256 g = gasleft();
        esc.depositAttested{value: 0.2 ether}("c1", "0.2", leaf, ak, uint64(NOW + 30 days));
        console.log("depositAttested c1 (REAL StrongBox genesis cert, on-chain parse + policy), gas:", g - gasleft());
        assertEq(esc.coin("c1").k0x, vm.parseJsonBytes32(pays, ".payments.dave.k0x"), "genesis key taken from the cert");
        PrawlRealEscrow.Hop[] memory h = new PrawlRealEscrow.Hop[](2);
        for (uint256 i = 0; i < 2; i++) {
            string memory b = string.concat(".payments.dave.hops[", vm.toString(i), "].");
            h[i] = PrawlRealEscrow.Hop(
                vm.parseJsonBytes32(pays, string.concat(b, "x")),
                vm.parseJsonBytes32(pays, string.concat(b, "y")),
                vm.parseJsonBytes32(pays, string.concat(b, "r")),
                vm.parseJsonBytes32(pays, string.concat(b, "s"))
            );
        }
        assertTrue(esc.redeem("c1", h, dave, 0, 0));
        vm.warp(NOW + 1 days);
        esc.finalize("c1");
        assertEq(dave.balance, 0.2 ether);
    }

    function test_depositAttested_cheatKeyC2_rejected() public {
        bytes32 ak = _registerSamsung();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PrawlAttestedEscrow.NotOneTimeKey.selector, AA.F_USAGE_HW));
        esc.depositAttested{value: 0.1 ether}("c2", "0.1", _der("samsungSB_mint_c2_cheat", 0), ak, uint64(NOW + 30 days));
    }

    function test_depositAttested_wrongAK_rejected() public {
        bytes32 akS = _registerSamsung();
        vm.prank(alice);
        vm.expectRevert(DeviceBondRegistry.BadSignature.selector);
        esc.depositAttested{value: 0.2 ether}("c1", "0.2", _der("oneplusTEE_bob", 0), akS, uint64(NOW + 30 days));
    }

    // ------------------------------------------------------------------ bonds with REAL proof-of-possession bytes

    function test_bond_realPossessionProof() public {
        bytes32 ak = _registerOnePlus();
        bytes memory pop = _der("oneplusTEE_bob", 0);
        bytes32 realChallenge = vm.parseJsonBytes32(chains, ".oneplusTEE_bob[0].keyDescription.attestationChallenge");
        vm.deal(bob, 5 ether);
        // without a matching challenge, Bob cannot bond (a copied public certificate is not possession)
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(DeviceBondRegistry.BadPossessionProof.selector, 0));
        reg.bond{value: 1 ether}(ak, pop);
        reg.setChallengeOverride(bob, realChallenge); // TEST-ONLY: pretend the phone had used this challenge
        vm.prank(bob);
        uint256 g = gasleft();
        reg.bond{value: 1 ether}(ak, pop);
        console.log("bond (REAL OnePlus PoP leaf: P256VERIFY + KeyDescription + challenge), gas:", g - gasleft());
        (address owner, uint96 amt, uint64 unlockAt,) = reg.bonds(ak);
        assertEq(owner, bob);
        assertEq(amt, 1 ether);
        assertEq(unlockAt, vm.parseJsonUint(chains, ".oneplusTEE_bob[1].notAfter") + 60 days); // AK notAfter + 60 days
        vm.prank(bob);
        vm.expectRevert(DeviceBondRegistry.Locked.selector);
        reg.withdraw(ak);
        vm.warp(unlockAt);
        vm.prank(bob);
        reg.withdraw(ak);
        assertEq(bob.balance, 5 ether);
    }

    // ------------------------------------------------------------------ slashing (SYNTHETIC leaked keybox)

    function test_slash_leakedKeybox_equivocation() public {
        // governance trusts the synthetic CA (stands in for a genuine CA whose AK private key leaked)
        bytes32 caId = reg.governanceRegisterIssuer(vm.parseJsonBytes(leaked, ".ca"), 1);
        bytes32 ak = reg.registerAttestationKey(vm.parseJsonBytes(leaked, ".ak"), caId, "");
        bytes memory leaf0 = vm.parseJsonBytes(leaked, ".leaves[0].der");
        bytes memory leaf1 = vm.parseJsonBytes(leaked, ".leaves[1].der");
        // Mallory bonds the AK (proof of possession = a forged leaf; she holds the leaked AK key)
        reg.setChallengeOverride(mallory, vm.parseJsonBytes32(chains, ".oneplusTEE_bob[0].keyDescription.attestationChallenge"));
        vm.prank(mallory);
        reg.bond{value: 1 ether}(ak, leaf1);
        // the forged attestation passes every on-chain policy rule (its KeyDescription is a real one)
        (,,, uint256 fails) = reg.checkOtk(leaf0, ak);
        assertEq(fails, 0, "a leaked AK defeats the attestation policy: that is what the bond is for");
        vm.prank(mallory);
        esc.depositAttested{value: 1 ether}("c9", "1", leaf0, ak, uint64(NOW + 30 days));
        // the software "one-time" key signs hop 0 twice: to Bob's and to Charlie's REAL keys
        uint256 sk = vm.parseJsonUint(leaked, ".leaves[0].priv");
        PrawlRealEscrow.Hop[] memory a = _swHop(sk, "c9", ".keys.bob.");
        PrawlRealEscrow.Hop[] memory b = _swHop(sk, "c9", ".keys.charlie.");
        assertTrue(esc.redeem("c9", a, bob, 0, 0));
        assertFalse(esc.redeem("c9", b, mallory, 0, 0), "second branch: equivocation");
        bytes32 kh = AA.spkiHash(leaf0, AA.parse(leaf0));
        assertTrue(esc.brokenKey(kh));
        // anyone slashes: leaf0 is attested by `ak` and its key is broken
        vm.prank(reporter);
        uint256 g = gasleft();
        reg.slash(leaf0, ak);
        console.log("slash (leaf sig by AK + escrow.brokenKey + payouts), gas:", g - gasleft());
        assertTrue(reg.blacklisted(ak));
        assertEq(reporter.balance, 0.1 ether);
        assertEq(reg.compensationPool(ak), 0.9 ether);
        // the AK is dead for new coins, and the bond cannot be withdrawn
        vm.expectRevert(abi.encodeWithSelector(DeviceBondRegistry.AKBlacklisted.selector, ak));
        reg.checkOtk(leaf1, ak);
        vm.warp(NOW + 400 days);
        vm.prank(mallory);
        vm.expectRevert(DeviceBondRegistry.Locked.selector);
        reg.withdraw(ak);
    }

    function test_slash_requiresBrokenKey() public {
        bytes32 ak = _registerOnePlus();
        vm.expectRevert(abi.encodeWithSelector(DeviceBondRegistry.NotBroken.selector, _id("oneplusTEE_bob", 0)));
        reg.slash(_der("oneplusTEE_bob", 0), ak);
    }

    function _swHop(uint256 sk, string memory coinId, string memory who) internal view returns (PrawlRealEscrow.Hop[] memory h) {
        bytes32 x = vm.parseJsonBytes32(pays, string.concat(who, "x"));
        bytes32 y = vm.parseJsonBytes32(pays, string.concat(who, "y"));
        (, bytes32 d) = esc.hopDigest(coinId, 0, esc.coin(coinId).mintHash, x, y);
        (bytes32 r, bytes32 s) = vm.signP256(sk, d);
        h = new PrawlRealEscrow.Hop[](1);
        h[0] = PrawlRealEscrow.Hop(x, y, r, s);
    }
}
