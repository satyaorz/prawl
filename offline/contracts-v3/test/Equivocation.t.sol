// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SoftKeys} from "./SoftKeys.sol";
import {console} from "forge-std/Test.sol";
import {PrawlEscrowV3, IOtkChecker} from "../src/PrawlEscrowV3.sol";
import {PrawlV3Codec as V3} from "../src/PrawlV3Codec.sol";
import {DeviceBondRegistry, IBrokenKeys} from "../src/DeviceBondRegistry.sol";
import {IP384Verifier} from "nitro/IP384Verifier.sol";
import {AndroidAttestation as AA} from "../src/attest/AndroidAttestation.sol";

/// @notice SYNTHETIC equivocation vectors (software keys):
///  coin "eq" (1.0): Ann0 -> Ben 0.4 + Ann 0.6; Ben's key signs TWO splits of his 0.4:
///     A: Cat 0.3 + Ben 0.1      B: Dan 0.4                       Ann's 0.6 is not under Ben.
///  coin "eq0" (0.5): the GENESIS key signs two splits: A: Yan1 0.5   B: Yan2 0.25 + Zed 0.25.
///  FROZEN-COIN RULE under test ("subtree freeze"): after an equivocation by key K is proven, nothing whose
///  path passes through K is paid (BOTH branches), everything else in the coin stays redeemable, and the
///  frozen coin's remainder goes to the compensation sink, never back to the depositor.
contract EquivocationTest is SoftKeys {
    address constant ESCROW = address(0xE5C70);
    PrawlEscrowV3 e;
    string eqName;
    bytes32 ben; // Ben's (equivocating) key hash

    function setUp() public {
        vm.warp(NOW);
        _loadFixture("fixtures/v3_synthetic.json");
        e = _deployAt(ESCROW, GRACE, MAX_LIFETIME);
        eqName = _equivFor("eq");
        ben = vm.parseJsonBytes32(fx, string.concat(".equivocations.", eqName, ".accusedKeyHash"));
    }

    // ------------------------------------------------------------------ detection by redeem

    function test_eq_secondBranchFreezes_otherBranchesStillPaid() public {
        PrawlEscrowV3.Header memory h = _depositCoin(e, "eq");
        assertTrue(_redeem(e, "eq_cat"), "branch A, first seen: paid");
        // branch B reaches the escrow: Ben's key signed a different message -> equivocation, coin frozen
        bytes32 mA = vm.parseJsonBytes32(fx, ".redeems.eq_cat.path[1].digest");
        bytes32 mB = vm.parseJsonBytes32(fx, ".redeems.eq_dan.path[1].digest");
        vm.expectEmit(true, true, false, true, address(e));
        emit PrawlEscrowV3.Equivocation(h.coinId, ben, mA, mB);
        vm.expectEmit(true, true, false, false, address(e));
        emit PrawlEscrowV3.CoinFrozen(h.coinId, ben);
        assertFalse(_redeem(e, "eq_dan"), "branch B: not paid, evidence persisted (no revert)");
        assertTrue(e.brokenKey(ben));
        _checkEvidence(h.coinId, mA, mB);
        // both branches under Ben are now blocked -- including branch A's not-yet-redeemed change
        _expectRevert("eq_ben", abi.encodeWithSelector(PrawlEscrowV3.KeyBroken.selector, 1, ben));
        _expectRevert("eq_dan", abi.encodeWithSelector(PrawlEscrowV3.KeyBroken.selector, 1, ben));
        // Ann's 0.6 never passed through Ben: still paid after the freeze
        assertTrue(_redeem(e, "eq_ann"));
        (uint128 paid,,) = e.coins(h.coinId);
        assertEq(paid, 0.9 ether);
        // expiry + grace: the 0.1 left goes to the compensation sink, the depositor gets nothing back
        vm.warp(uint256(h.expiry) + GRACE);
        uint256 dep = h.depositor.balance;
        vm.expectEmit(true, true, false, true, address(e));
        emit PrawlEscrowV3.FrozenRemainderSwept(h.coinId, SINK, 0.1 ether);
        e.reclaim(h);
        assertEq(SINK.balance, 0.1 ether);
        assertEq(h.depositor.balance, dep);
        assertEq(address(e).balance, 0);
    }

    // ------------------------------------------------------------------ detection by proof

    function test_eq_proveEquivocation_blocksSubtree() public {
        PrawlEscrowV3.Header memory h = _depositCoin(e, "eq");
        string memory b = string.concat(".equivocations.", eqName);
        bytes32 kh = e.proveEquivocation(h, _path(b), _signed(string.concat(b, ".a")), _signed(string.concat(b, ".b")));
        assertEq(kh, ben);
        assertTrue(e.brokenKey(ben));
        _expectRevert("eq_cat", abi.encodeWithSelector(PrawlEscrowV3.KeyBroken.selector, 1, ben));
        _expectRevert("eq_dan", abi.encodeWithSelector(PrawlEscrowV3.KeyBroken.selector, 1, ben));
        assertTrue(_redeem(e, "eq_ann"));
        // a second proof of the same thing changes nothing
        vm.expectRevert(abi.encodeWithSelector(PrawlEscrowV3.NothingNew.selector, ben));
        e.proveEquivocation(h, _path(b), _signed(string.concat(b, ".a")), _signed(string.concat(b, ".b")));
        vm.warp(uint256(h.expiry) + GRACE);
        e.reclaim(h);
        assertEq(SINK.balance, 0.4 ether, "Ben's whole 0.4 is blocked and swept");
    }

    function test_eq_proveEquivocation_rejects() public {
        PrawlEscrowV3.Header memory h = _depositCoin(e, "eq");
        string memory b = string.concat(".equivocations.", eqName);
        PrawlEscrowV3.Spend[] memory p = _path(b);
        PrawlEscrowV3.Signed memory a = _signed(string.concat(b, ".a"));
        PrawlEscrowV3.Signed memory bb = _signed(string.concat(b, ".b"));
        // same message twice (here: a malleated second signature) proves nothing
        vm.expectRevert(PrawlEscrowV3.SameMessage.selector);
        e.proveEquivocation(h, p, a, PrawlEscrowV3.Signed(a.message, a.r, bytes32(P256_N - uint256(a.s))));
        // the messages must be signed by the key the path leads to (here: claim it was Ann0, empty path)
        vm.expectRevert(abi.encodeWithSelector(PrawlEscrowV3.BadSig.selector, 0));
        e.proveEquivocation(h, new PrawlEscrowV3.Spend[](0), a, bb);
        // an unrelated coin cannot be frozen with this evidence (its genesis key did not sign the path)
        PrawlEscrowV3.Header memory t = _depositCoin(e, "tree");
        vm.expectRevert(abi.encodeWithSelector(PrawlEscrowV3.BadSig.selector, 0));
        e.proveEquivocation(t, p, a, bb);
        // a tampered message
        bytes memory m = bytes.concat(bb.message);
        m[m.length - 1] = m[m.length - 1] == bytes1("0") ? bytes1("1") : bytes1("0");
        bb.message = m;
        vm.expectRevert(abi.encodeWithSelector(PrawlEscrowV3.BadSig.selector, 1));
        e.proveEquivocation(h, p, a, bb);
        (, bool frozen,) = e.coins(h.coinId);
        assertFalse(frozen);
    }

    /// Evidence stays usable after the coin is closed (slashing needs brokenKey, whenever it surfaces).
    function test_eq_proofAfterClose_recordsBrokenKey() public {
        PrawlEscrowV3.Header memory h = _depositCoin(e, "eq");
        assertTrue(_redeem(e, "eq_cat"));
        vm.warp(uint256(h.expiry) + GRACE);
        e.reclaim(h); // not frozen: depositor gets 0.7 back
        string memory b = string.concat(".equivocations.", eqName);
        e.proveEquivocation(h, _path(b), _signed(string.concat(b, ".a")), _signed(string.concat(b, ".b")));
        assertTrue(e.brokenKey(ben));
        (, bool frozen, bool closed) = e.coins(h.coinId);
        assertTrue(frozen && closed);
    }

    // ------------------------------------------------------------------ genesis equivocation

    function test_eq0_genesisEquivocation_wholeCoinBlocked() public {
        PrawlEscrowV3.Header memory h = _depositCoin(e, "eq0");
        bytes32 k0 = e.keyHash(bytes32(h.k0x), bytes32(h.k0y));
        assertTrue(_redeem(e, "eq0_yan1"), "first branch to arrive is paid in full (the race inherent to offline cash)");
        assertFalse(_redeem(e, "eq0_yan2"), "second branch: equivocation");
        _expectRevert("eq0_zed1", abi.encodeWithSelector(PrawlEscrowV3.KeyBroken.selector, 0, k0));
        (uint128 paid, bool frozen,) = e.coins(h.coinId);
        assertEq(paid, 0.5 ether);
        assertTrue(frozen);
    }

    /// The depositor equivocates with her own genesis key and proves it herself, hoping to reclaim the coin
    /// she already spent offline. The frozen remainder goes to the sink instead.
    function test_eq0_depositorCannotReclaimFrozenCoin() public {
        PrawlEscrowV3.Header memory h = _depositCoin(e, "eq0");
        string memory b = string.concat(".equivocations.", _equivFor("eq0"));
        e.proveEquivocation(h, _path(b), _signed(string.concat(b, ".a")), _signed(string.concat(b, ".b")));
        bytes32 k0 = e.keyHash(bytes32(h.k0x), bytes32(h.k0y));
        _expectRevert("eq0_yan1", abi.encodeWithSelector(PrawlEscrowV3.KeyBroken.selector, 0, k0));
        vm.warp(uint256(h.expiry) + GRACE);
        uint256 dep = h.depositor.balance;
        e.reclaim(h);
        assertEq(h.depositor.balance, dep, "no refund of a frozen coin");
        assertEq(SINK.balance, 0.5 ether);
    }

    // ------------------------------------------------------------------ no false positives

    function test_sharedPrefixes_andSiblingRedeems_areNotEquivocation() public {
        PrawlEscrowV3.Header memory h = _depositCoin(e, "tree");
        string[9] memory leaves = ["tree_gina2a", "tree_gina2b", "tree_gina", "tree_erin", "tree_frank", "tree_dave",
            "tree_charlie", "tree_bob", "tree_alice"];
        for (uint256 i = 0; i < 9; i++) assertTrue(_redeem(e, leaves[i]));
        (, bool frozen,) = e.coins(h.coinId);
        assertFalse(frozen);
        assertFalse(e.brokenKey(e.keyHash(bytes32(h.k0x), bytes32(h.k0y))));
    }

    // ------------------------------------------------------------------ cross-coin key reuse (Solidity-signed)

    /// One "one-time" key used as genesis key of two coins and spent in both: the second spend conflicts
    /// with the first message recorded for that key. Coin B freezes at once; coin A freezes the next time a
    /// path through the (now broken) key is submitted, instead of paying.
    function test_crossCoinKeyReuse_freezesBoth() public {
        Key memory k = _key("reused");
        address payA = makeAddr("payA");
        address payB = makeAddr("payB");
        bytes32 idA;
        {
            // coin B: k redeems directly; k's first recorded message is B's, paid
            PrawlEscrowV3.Header memory B = _softCoin("coinB", k);
            assertTrue(e.redeem(B, new PrawlEscrowV3.Spend[](0), _genesisRedeem(B, k, payB)));
            // coin A: k pays key pa, pa redeems -> k's coin-A message differs: equivocation, A frozen
            PrawlEscrowV3.Header memory A = _softCoin("coinA", k);
            idA = A.coinId;
            (PrawlEscrowV3.Spend[] memory pathA, PrawlEscrowV3.Redemption memory rdA) = _twoStep(A, k, _key("pa"), payA);
            assertFalse(e.redeem(A, pathA, rdA));
            assertTrue(e.brokenKey(k.kh));
            assertTrue(_frozen(A.coinId));
            assertFalse(_frozen(B.coinId), "B was paid before the conflict existed");
        }
        // coin C also uses k and was never spent before: reaching the broken key freezes C instead of paying
        PrawlEscrowV3.Header memory C = _softCoin("coinC", k);
        vm.expectEmit(true, true, false, false, address(e));
        emit PrawlEscrowV3.CoinFrozen(C.coinId, k.kh);
        assertFalse(e.redeem(C, new PrawlEscrowV3.Spend[](0), _genesisRedeem(C, k, payA)));
        assertTrue(_frozen(C.coinId), "a path through an already-broken key freezes a not-yet-frozen coin");
        assertEq(payA.balance, 0);
        assertEq(payB.balance, 1 ether);
    }

    function _frozen(bytes32 id) internal view returns (bool f) {
        (, f,) = e.coins(id);
    }

    function _softCoin(bytes memory id, Key memory k) internal returns (PrawlEscrowV3.Header memory h) {
        h.coinId = keccak256(id);
        h.value = 1 ether;
        h.expiry = uint64(NOW + 10 days);
        h.k0x = uint256(k.x);
        h.k0y = uint256(k.y);
        h.depositor = address(0xDE9051);
        _deposit(e, h);
    }

    function _genesisRedeem(PrawlEscrowV3.Header memory h, Key memory k, address payout)
        internal
        view
        returns (PrawlEscrowV3.Redemption memory rd)
    {
        V3.Output[] memory o = _outs1(h.value, e.redeemKeyHash(payout));
        (bytes32 r, bytes32 s) = _signSpend(e, h, 0, e.genesisNoteId(h.coinId), o, k.sk);
        rd = PrawlEscrowV3.Redemption(o, 0, payout, r, s);
    }

    function _twoStep(PrawlEscrowV3.Header memory h, Key memory k, Key memory nk, address payout)
        internal
        view
        returns (PrawlEscrowV3.Spend[] memory p, PrawlEscrowV3.Redemption memory rd)
    {
        p = new PrawlEscrowV3.Spend[](1);
        p[0].outputs = _outs1(h.value, nk.kh);
        (p[0].r, p[0].s) = _signSpend(e, h, 0, e.genesisNoteId(h.coinId), p[0].outputs, k.sk);
        p[0].nextX = nk.x;
        p[0].nextY = nk.y;
        rd.outputs = _outs1(h.value, e.redeemKeyHash(payout));
        rd.payout = payout;
        (rd.r, rd.s) = _signSpend(e, h, 1, e.childNoteId(p[0].r, p[0].s, 0), rd.outputs, nk.sk);
    }

    function _checkEvidence(bytes32 coinId, bytes32 mA, bytes32 mB) internal view {
        (bytes32 ec, bytes32 ea, bytes32 eb) = e.evidence(ben);
        assertEq(ec, coinId);
        assertEq(ea, mA);
        assertEq(eb, mB);
        (, bool frozen,) = e.coins(coinId);
        assertTrue(frozen);
    }

    function _expectRevert(string memory name, bytes memory err) internal {
        (PrawlEscrowV3.Header memory hh, PrawlEscrowV3.Spend[] memory p, PrawlEscrowV3.Redemption memory rd) = _load(name);
        vm.expectRevert(err);
        e.redeem(hh, p, rd);
    }
}

/// @notice TEST-ONLY registry: the SYNTHETIC leaked-keybox leaves carry the REAL KeyDescription of Bob's
///  OnePlus leaf, whose attestation challenge is random (the app predates bonding). The override lets a test
///  declare that challenge to be the bonder's expected one (same device as seam_a's RealVectorRegistry).
contract TestRegistry is DeviceBondRegistry {
    mapping(address => bytes32) public challengeOverride;

    constructor(IBrokenKeys esc, bytes32 pkg, bytes32 signer)
        DeviceBondRegistry(new bytes[](0), Config(msg.sender, esc, 1 ether, 60 days, pkg, signer, IP384Verifier(address(0))))
    {}

    function setChallengeOverride(address who, bytes32 c) external {
        challengeOverride[who] = c;
    }

    function expectedChallenge(address owner) public view override returns (bytes32) {
        bytes32 o = challengeOverride[owner];
        return o != 0 ? o : super.expectedChallenge(owner);
    }
}

/// @notice depositAttested (reused AndroidAttestation + DeviceBondRegistry) and bond slashing after a v3
///  equivocation. SYNTHETIC "leaked keybox": a software genesis key whose forged attestation passes every
///  on-chain policy rule -- the threat device bonds exist for.
contract AttestedEscrowTest is SoftKeys {
    address constant ESCROW = address(0xE5C70);
    string leaked;
    string params;
    address mallory = makeAddr("mallory");
    address reporter = makeAddr("reporter");

    function setUp() public {
        vm.warp(NOW);
        _loadFixture("fixtures/v3_synthetic.json");
        leaked = vm.readFile("fixtures/leaked_keybox.json");
        params = vm.readFile("fixtures/attest_params.json");
    }

    function _setup(bool requireBonded, bytes32 pkg) internal returns (PrawlEscrowV3 e, TestRegistry reg, bytes32 ak) {
        deployCodeTo("PrawlEscrowV3.sol:PrawlEscrowV3", abi.encode(GRACE, MAX_LIFETIME, SINK, requireBonded), ESCROW);
        e = PrawlEscrowV3(ESCROW);
        reg = new TestRegistry(IBrokenKeys(ESCROW), pkg, vm.parseJsonBytes32(params, ".appSignerDigest"));
        e.setRegistry(IOtkChecker(address(reg)));
        bytes32 caId = reg.governanceRegisterIssuer(vm.parseJsonBytes(leaked, ".ca"), 1);
        ak = reg.registerAttestationKey(vm.parseJsonBytes(leaked, ".ak"), caId, "");
    }

    function _depositAttested(PrawlEscrowV3 e, bytes32 ak) internal returns (PrawlEscrowV3.Header memory h) {
        h = _header("att");
        vm.deal(h.depositor, h.value);
        vm.prank(h.depositor);
        uint256 g = gasleft();
        e.depositAttested{value: h.value}(h.coinId, h.expiry, vm.parseJsonBytes(leaked, ".leaves[0].der"), ak);
        console.log("depositAttested (leaf parse + P256VERIFY + KeyDescription policy), gas incl. call:", g - gasleft());
    }

    function test_depositAttested_redeem_equivocate_slash() public {
        (PrawlEscrowV3 e, TestRegistry reg, bytes32 ak) = _setup(false, keccak256("xyz.prawl.otktest"));
        // Mallory bonds the leaked AK (proof of possession = a forged leaf, she holds the leaked AK key)
        reg.setChallengeOverride(mallory, vm.parseJsonBytes32(params, ".attestationChallenge"));
        vm.deal(mallory, 1 ether);
        vm.prank(mallory);
        reg.bond{value: 1 ether}(ak, vm.parseJsonBytes(leaked, ".leaves[1].der"));
        PrawlEscrowV3.Header memory h = _depositAttested(e, ak);
        // the genesis key was taken from the certificate: the commitment matches the bundle's header
        assertEq(e.deposits(h.coinId), e.commitment(h.value, h.expiry, h.k0x, h.k0y, h.depositor));
        assertTrue(_redeemOn(e, "att_hal"));
        assertFalse(_redeemOn(e, "att_jon"), "the attested genesis key signed a second split");
        bytes32 k0 = e.keyHash(bytes32(h.k0x), bytes32(h.k0y));
        assertTrue(e.brokenKey(k0));
        // anyone slashes the device bond with the escrow's evidence
        bytes memory leaf0 = vm.parseJsonBytes(leaked, ".leaves[0].der");
        assertEq(AA.spkiHash(leaf0, AA.parse(leaf0)), k0, "registry and escrow use the same key id");
        vm.prank(reporter);
        reg.slash(leaf0, ak);
        assertTrue(reg.blacklisted(ak));
        assertEq(reporter.balance, 0.1 ether);
        assertEq(reg.compensationPool(ak), 0.9 ether);
        // the AK can no longer attest new coins
        vm.deal(h.depositor, 1 ether);
        vm.prank(h.depositor);
        vm.expectRevert(abi.encodeWithSelector(DeviceBondRegistry.AKBlacklisted.selector, ak));
        e.depositAttested{value: 1 ether}(keccak256("next"), h.expiry, leaf0, ak);
    }

    function test_depositAttested_policyFailure_rejected() public {
        (PrawlEscrowV3 e,, bytes32 ak) = _setup(false, keccak256("some.other.app"));
        PrawlEscrowV3.Header memory h = _header("att");
        vm.deal(h.depositor, h.value);
        vm.prank(h.depositor);
        vm.expectRevert(abi.encodeWithSelector(PrawlEscrowV3.NotOneTimeKey.selector, AA.F_PACKAGE));
        e.depositAttested{value: h.value}(h.coinId, h.expiry, vm.parseJsonBytes(leaked, ".leaves[0].der"), ak);
    }

    function test_depositAttested_requireBond() public {
        (PrawlEscrowV3 e, TestRegistry reg, bytes32 ak) = _setup(true, keccak256("xyz.prawl.otktest"));
        PrawlEscrowV3.Header memory h = _header("att");
        vm.deal(h.depositor, h.value);
        vm.prank(h.depositor);
        vm.expectRevert(abi.encodeWithSelector(PrawlEscrowV3.DeviceNotBonded.selector, ak));
        e.depositAttested{value: h.value}(h.coinId, h.expiry, vm.parseJsonBytes(leaked, ".leaves[0].der"), ak);
        reg.setChallengeOverride(mallory, vm.parseJsonBytes32(params, ".attestationChallenge"));
        vm.deal(mallory, 1 ether);
        vm.prank(mallory);
        reg.bond{value: 1 ether}(ak, vm.parseJsonBytes(leaked, ".leaves[1].der"));
        _depositAttested(e, ak);
        assertTrue(_redeemOn(e, "att_hal"));
    }

    function test_setRegistry_onlyOnce_onlyDeployer() public {
        (PrawlEscrowV3 e,,) = _setup(false, keccak256("xyz.prawl.otktest"));
        vm.expectRevert(PrawlEscrowV3.RegistryLocked.selector);
        e.setRegistry(IOtkChecker(address(1)));
        PrawlEscrowV3 f = new PrawlEscrowV3(GRACE, MAX_LIFETIME, SINK, false);
        vm.prank(mallory);
        vm.expectRevert(PrawlEscrowV3.RegistryLocked.selector);
        f.setRegistry(IOtkChecker(address(1)));
        vm.expectRevert(PrawlEscrowV3.NoRegistry.selector);
        f.depositAttested{value: 1}(bytes32(0), uint64(NOW + 1 days), "", bytes32(0));
    }

    function _redeemOn(PrawlEscrowV3 e, string memory name) internal returns (bool) {
        (PrawlEscrowV3.Header memory hh, PrawlEscrowV3.Spend[] memory p, PrawlEscrowV3.Redemption memory rd) = _load(name);
        return e.redeem(hh, p, rd);
    }
}
