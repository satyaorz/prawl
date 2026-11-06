// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {PrawlRealEscrow} from "../src/PrawlRealEscrow.sol";
import {PrawlCodec} from "../src/PrawlCodec.sol";

/// @notice Codec harness so library functions can be called (and gas-measured) externally.
contract CodecHarness {
    function hopMessage(bytes memory c, bytes memory v, uint256 i, bytes32 p, bytes32 t) external pure returns (bytes memory) {
        return PrawlCodec.hopMessage(c, v, i, p, t);
    }

    function derSig(bytes32 r, bytes32 s) external pure returns (bytes memory) {
        return PrawlCodec.derSig(r, s);
    }

    function keyHash(bytes32 x, bytes32 y) external pure returns (bytes32) {
        return PrawlCodec.keyHash(x, y);
    }

    function mintHash(bytes memory c, bytes memory v, bytes32 k) external pure returns (bytes32) {
        return PrawlCodec.mintHash(c, v, k);
    }

    function parseEther(bytes memory v) external pure returns (bool, uint256) {
        return PrawlCodec.parseEther(v);
    }
}

/// @notice Every signature in these tests that is called REAL was produced inside a phone's secure
///  hardware on 2026-11-06 (Samsung S25 Ultra StrongBox, OnePlus CPH2487 TEE) and read from
///  ../phone_vectors_v1 by tools/vectors_to_foundry.py. Synthetic software-key signatures are labelled.
contract RealPhoneEscrowTest is Test {
    uint256 constant WINDOW = 1 days;
    uint256 constant T0 = 1_790_000_000; // 2026-09-21, set in setUp
    uint256 constant N256 = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;
    string json;
    PrawlRealEscrow v1; // phone-v1 compatible mode: no tip authorisation in the phone format
    PrawlRealEscrow prod; // production mode: tip key must sign the redemption
    CodecHarness codec;
    address alice = makeAddr("alice");
    address bobAddr = makeAddr("bob");
    address daveAddr = makeAddr("dave");
    address charlieAddr = makeAddr("charlie");

    event Equivocation(bytes32 indexed coin, bytes32 indexed keyHash, bytes32 msgA, bytes32 msgB);

    function setUp() public {
        json = vm.readFile("fixtures/payments.json");
        v1 = new PrawlRealEscrow(WINDOW, false);
        prod = new PrawlRealEscrow(WINDOW, true);
        codec = new CodecHarness();
        vm.deal(alice, 100 ether);
        vm.warp(T0);
    }

    // ------------------------------------------------------------------ fixture helpers

    function _b32(string memory k) internal view returns (bytes32) {
        return vm.parseJsonBytes32(json, k);
    }

    function _str(string memory k) internal view returns (string memory) {
        return vm.parseJsonString(json, k);
    }

    function _hopsN(string memory pay, uint256 n) internal view returns (PrawlRealEscrow.Hop[] memory hs) {
        hs = new PrawlRealEscrow.Hop[](n);
        for (uint256 i = 0; i < n; i++) {
            string memory b = string.concat(".payments.", pay, ".hops[", vm.toString(i), "].");
            hs[i] = PrawlRealEscrow.Hop(
                _b32(string.concat(b, "x")), _b32(string.concat(b, "y")), _b32(string.concat(b, "r")), _b32(string.concat(b, "s"))
            );
        }
    }

    function _depositC1(PrawlRealEscrow e, string memory value, uint256 amount) internal {
        vm.prank(alice);
        e.deposit{value: amount}("c1", value, _b32(".payments.bob.k0x"), _b32(".payments.bob.k0y"), uint64(block.timestamp + 30 days));
    }

    // ------------------------------------------------------------------ 0. codec == phone, byte for byte

    function test_codec_reproducesPhoneMessagesExactly() public view {
        bytes32 k0h = codec.keyHash(_b32(".payments.dave.k0x"), _b32(".payments.dave.k0y"));
        assertEq(k0h, _b32(".payments.dave.k0Hash"), "SPKI hash of genesis key");
        bytes32 mh = codec.mintHash("c1", "0.2", k0h);
        assertEq(mh, _b32(".payments.dave.mintHash"), "mintHash");
        bytes32 prev = mh;
        for (uint256 i = 0; i < 2; i++) {
            string memory b = string.concat(".payments.dave.hops[", vm.toString(i), "].");
            bytes32 to = codec.keyHash(_b32(string.concat(b, "x")), _b32(string.concat(b, "y")));
            bytes memory m = codec.hopMessage("c1", "0.2", i, prev, to);
            assertEq(string(m), _str(string.concat(b, "message")), "hop message bytes");
            assertEq(sha256(m), _b32(string.concat(b, "msgSha256")));
            bytes memory der = codec.derSig(_b32(string.concat(b, "r")), _b32(string.concat(b, "s")));
            assertEq(der, vm.parseJsonBytes(json, string.concat(b, "sigDer")), "DER re-encoding == phone bytes");
            prev = sha256(der);
        }
        assertEq(codec.keyHash(_b32(".keys.dave.x"), _b32(".keys.dave.y")), _b32(".keys.dave.hash"));
    }

    function test_codec_parseEther() public view {
        (bool ok, uint256 w) = codec.parseEther("0.2");
        assertTrue(ok);
        assertEq(w, 0.2 ether);
        (ok, w) = codec.parseEther("12.5");
        assertEq(w, 12.5 ether);
        (ok,) = codec.parseEther("0.20");
        assertFalse(ok, "trailing zero is not canonical");
        (ok,) = codec.parseEther("00.2");
        assertFalse(ok);
        (ok,) = codec.parseEther(".2");
        assertFalse(ok);
        (ok,) = codec.parseEther("1|2");
        assertFalse(ok);
    }

    function test_p256verify_acceptsHighS_fromRealTEE() public view {
        // Dave's hop 1 was signed by Bob's OnePlus TEE key with s > n/2; P256VERIFY (EIP-7951) must accept it.
        assertTrue(uint256(_b32(".payments.dave.hops[1].s")) > N256 / 2);
        assertTrue(vm.parseJsonBool(json, ".payments.dave.hops[1].highS"));
    }

    // ------------------------------------------------------------------ 1. real chains redeem

    function test_real_1hop_AliceToBob_redeems() public {
        _depositC1(v1, "0.2", 0.2 ether);
        PrawlRealEscrow.Hop[] memory h = _hopsN("bob", 1);
        uint256 g = gasleft();
        assertTrue(v1.redeem("c1", h, bobAddr, 0, 0));
        console.log("redeem REAL 1 hop (execution gas, gasleft delta):", g - gasleft());
        vm.expectRevert(PrawlRealEscrow.WindowOpen.selector);
        v1.finalize("c1");
        vm.warp(block.timestamp + WINDOW);
        v1.finalize("c1");
        assertEq(bobAddr.balance, 0.2 ether);
    }

    function test_real_2hop_AliceBobDave_redeems() public {
        _depositC1(v1, "0.2", 0.2 ether);
        PrawlRealEscrow.Hop[] memory h = _hopsN("dave", 2);
        uint256 g = gasleft();
        assertTrue(v1.redeem("c1", h, daveAddr, 0, 0));
        console.log("redeem REAL 2 hops (execution gas, gasleft delta):", g - gasleft());
        vm.warp(block.timestamp + WINDOW);
        v1.finalize("c1");
        assertEq(daveAddr.balance, 0.2 ether);
    }

    /// Bob already paid Dave, then tries to cash the coin himself with his 1-hop chain.
    function test_real_staleClaim_supersededByDeeperChain() public {
        _depositC1(v1, "0.2", 0.2 ether);
        uint256 t0 = T0; // not block.timestamp: via_ir may re-read TIMESTAMP after vm.warp
        v1.redeem("c1", _hopsN("bob", 1), bobAddr, 0, 0);
        vm.warp(t0 + WINDOW - 1);
        assertTrue(v1.redeem("c1", _hopsN("dave", 2), daveAddr, 0, 0), "Dave's deeper chain replaces Bob's claim");
        // Bob cannot come back with the shallower chain, and Dave's own chain cannot be re-claimed to another payout
        vm.expectRevert(abi.encodeWithSelector(PrawlRealEscrow.NotDeeper.selector, 2, 1));
        v1.redeem("c1", _hopsN("bob", 1), bobAddr, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(PrawlRealEscrow.NotDeeper.selector, 2, 2));
        v1.redeem("c1", _hopsN("dave", 2), bobAddr, 0, 0);
        vm.warp(t0 + 2 * WINDOW - 2); // the window restarted with Dave's claim
        vm.expectRevert(PrawlRealEscrow.WindowOpen.selector);
        v1.finalize("c1");
        vm.warp(t0 + 2 * WINDOW - 1);
        v1.finalize("c1");
        assertEq(daveAddr.balance, 0.2 ether);
        assertEq(bobAddr.balance, 0);
        assertFalse(v1.brokenKey(_b32(".keys.bob.hash")), "a stale claim is not equivocation");
    }

    function test_real_challengeAfterWindow_tooLate() public {
        _depositC1(v1, "0.2", 0.2 ether);
        v1.redeem("c1", _hopsN("bob", 1), bobAddr, 0, 0);
        vm.warp(block.timestamp + WINDOW);
        vm.expectRevert(PrawlRealEscrow.WindowClosed.selector);
        v1.redeem("c1", _hopsN("dave", 2), daveAddr, 0, 0);
    }

    // ------------------------------------------------------------------ 2. real invalid cases are rejected

    /// pay_c1_tamper.json: Alice edited the value 0.2 -> 2.0. The phone signature covers "0.2".
    function test_real_tamper_valueEdited_rejected() public {
        // (a) the tampered file's value string "2.0" is not even a canonical deposit value
        vm.expectRevert(PrawlRealEscrow.BadValue.selector);
        _depositC1(v1, "2.0", 2 ether);
    }

    function test_real_tamper_valueEdited_rejected_sigFails() public {
        // the tampered file's own mint record, deposited with the canonical spelling of 2.0 ETH
        vm.prank(alice);
        v1.deposit{value: 2 ether}("c1", "2", _b32(".payments.tamper.k0x"), _b32(".payments.tamper.k0y"), uint64(block.timestamp + 30 days));
        PrawlRealEscrow.Hop[] memory h = _hopsN("tamper", 1);
        vm.expectRevert(abi.encodeWithSelector(PrawlRealEscrow.BadSig.selector, 0));
        v1.redeem("c1", h, bobAddr, 0, 0);
    }

    function test_real_tamper_cannotRaiseValue_ofRealCoin() public {
        // (b) against the real 0.2 deposit the value is read from the deposit, never from the claimant:
        // the tampered file's hop is the untouched real hop, so it can only ever release the 0.2 deposited.
        _depositC1(v1, "0.2", 0.2 ether);
        v1.redeem("c1", _hopsN("tamper", 1), bobAddr, 0, 0);
        vm.warp(block.timestamp + WINDOW);
        v1.finalize("c1");
        assertEq(bobAddr.balance, 0.2 ether);
    }

    /// pay_c1_replay.json: Alice forwards Bob's payment to Charlie; Charlie claims with his own key as recipient.
    function test_real_replay_wrongRecipient_rejected() public {
        _depositC1(v1, "0.2", 0.2 ether);
        PrawlRealEscrow.Hop[] memory h = _hopsN("replay", 1);
        h[0].x = _b32(".keys.charlie.x");
        h[0].y = _b32(".keys.charlie.y");
        vm.expectRevert(abi.encodeWithSelector(PrawlRealEscrow.BadSig.selector, 0));
        v1.redeem("c1", h, charlieAddr, 0, 0);
        // and in production mode Charlie cannot produce the tip key's (Bob's) redemption signature
        _depositC1(prod, "0.2", 0.2 ether);
        vm.expectRevert(PrawlRealEscrow.TipAuthRequired.selector);
        prod.redeem("c1", _hopsN("replay", 1), charlieAddr, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(PrawlRealEscrow.BadSig.selector, 1));
        prod.redeem("c1", _hopsN("replay", 1), charlieAddr, bytes32(uint256(1)), bytes32(uint256(2)));
    }

    /// pay_c2_bob3.json: coin c2's genesis key is an ordinary MULTI-USE key (the phone's cheat test).
    function test_real_cheatKeyCoin_replayedOntoRealCoin_rejected() public {
        _depositC1(v1, "0.2", 0.2 ether);
        vm.expectRevert(abi.encodeWithSelector(PrawlRealEscrow.BadSig.selector, 0));
        v1.redeem("c1", _hopsN("c2bob3", 1), bobAddr, 0, 0);
    }

    /// Documents the limit of a PLAIN deposit: signatures alone cannot reveal that c2's genesis key is
    /// multi-use, so its (validly signed) hop redeems. PrawlAttestedEscrow.depositAttested rejects c2 at
    /// deposit by parsing the genesis key's attestation on-chain (test/AttestedDeposit.t.sol).
    function test_real_cheatKeyCoin_plainDeposit_cannotTell() public {
        vm.prank(alice);
        v1.deposit{value: 0.1 ether}("c2", "0.1", _b32(".payments.c2bob3.k0x"), _b32(".payments.c2bob3.k0y"), uint64(block.timestamp + 30 days));
        assertTrue(v1.redeem("c2", _hopsN("c2bob3", 1), bobAddr, 0, 0));
    }

    function test_depthZero_onlyDepositor_inV1() public {
        _depositC1(v1, "0.2", 0.2 ether);
        vm.expectRevert(PrawlRealEscrow.OnlyDepositor.selector);
        v1.redeem("c1", new PrawlRealEscrow.Hop[](0), bobAddr, 0, 0);
        vm.prank(alice);
        v1.redeem("c1", new PrawlRealEscrow.Hop[](0), alice, 0, 0); // Alice cashes out ... after paying Bob
        assertTrue(v1.redeem("c1", _hopsN("bob", 1), bobAddr, 0, 0), "... Bob's chain supersedes her");
    }

    function test_deposit_rules() public {
        vm.startPrank(alice);
        vm.expectRevert(PrawlRealEscrow.BadValue.selector);
        v1.deposit{value: 0.3 ether}("c1", "0.2", bytes32(uint256(1)), bytes32(uint256(2)), uint64(block.timestamp + 30 days));
        vm.expectRevert(PrawlRealEscrow.BadCoinId.selector);
        v1.deposit{value: 0.2 ether}("c1|0.2", "0.2", bytes32(uint256(1)), bytes32(uint256(2)), uint64(block.timestamp + 30 days));
        vm.expectRevert(PrawlRealEscrow.BadExpiry.selector);
        v1.deposit{value: 0.2 ether}("c1", "0.2", bytes32(uint256(1)), bytes32(uint256(2)), uint64(block.timestamp + 1 hours));
        v1.deposit{value: 0.2 ether}("c1", "0.2", _b32(".payments.bob.k0x"), _b32(".payments.bob.k0y"), uint64(block.timestamp + 30 days));
        vm.expectRevert(PrawlRealEscrow.CoinExists.selector);
        v1.deposit{value: 0.2 ether}("c1", "0.2", bytes32(uint256(1)), bytes32(uint256(2)), uint64(block.timestamp + 30 days));
        vm.expectRevert(PrawlRealEscrow.GenesisKeyReused.selector);
        v1.deposit{value: 0.2 ether}("c9", "0.2", _b32(".payments.bob.k0x"), _b32(".payments.bob.k0y"), uint64(block.timestamp + 30 days));
        vm.stopPrank();
    }

    function test_expiry_refund_and_lateClaim() public {
        _depositC1(v1, "0.2", 0.2 ether);
        vm.expectRevert(PrawlRealEscrow.WindowOpen.selector);
        v1.refundExpired("c1");
        vm.warp(block.timestamp + 30 days);
        vm.expectRevert(PrawlRealEscrow.Expired.selector);
        v1.redeem("c1", _hopsN("bob", 1), bobAddr, 0, 0);
        uint256 b = alice.balance;
        v1.refundExpired("c1");
        assertEq(alice.balance, b + 0.2 ether);
    }

    // ------------------------------------------------------------------ 3. equivocation (SYNTHETIC second signature)

    function _depositC3() internal {
        vm.prank(alice);
        v1.deposit{value: 0.05 ether}(
            "c3", "0.05", _b32(".equivocation.k0x"), _b32(".equivocation.k0y"), uint64(block.timestamp + 30 days)
        );
    }

    function _branch(string memory who) internal view returns (PrawlRealEscrow.Hop[] memory h) {
        h = new PrawlRealEscrow.Hop[](1);
        string memory b = string.concat(".equivocation.branches.", who, ".");
        h[0] = PrawlRealEscrow.Hop(
            _b32(string.concat(b, "x")), _b32(string.concat(b, "y")), _b32(string.concat(b, "r")), _b32(string.concat(b, "s"))
        );
    }

    /// A software genesis key (standing in for broken hardware) signs hop 0 of c3 to Bob's REAL key and
    /// again to Charlie's REAL key. Anyone holding both payments proves it on-chain.
    function test_equivocation_proveEquivocation_freezesAndRecordsKey() public {
        _depositC3();
        bytes memory mA = vm.parseJsonBytes(json, ".equivocation.branches.bob.messageHex");
        bytes memory mB = vm.parseJsonBytes(json, ".equivocation.branches.charlie.messageHex");
        PrawlRealEscrow.Hop[] memory a = _branch("bob");
        PrawlRealEscrow.Hop[] memory b = _branch("charlie");
        bytes32 k0h = codec.keyHash(_b32(".equivocation.k0x"), _b32(".equivocation.k0y"));
        vm.expectEmit(true, true, false, true);
        emit Equivocation(keccak256("c3"), k0h, sha256(mA), sha256(mB));
        uint256 g = gasleft();
        bytes32 kh = v1.proveEquivocation(
            "c3", new PrawlRealEscrow.Hop[](0), PrawlRealEscrow.Signed(mA, a[0].r, a[0].s), PrawlRealEscrow.Signed(mB, b[0].r, b[0].s)
        );
        console.log("proveEquivocation (genesis key, 2 sigs) gas:", g - gasleft());
        assertEq(kh, k0h);
        assertTrue(v1.brokenKey(k0h));
        assertEq(uint8(v1.coin("c3").status), uint8(PrawlRealEscrow.Status.Frozen));
        (bytes32 ec, bytes32 ea, bytes32 eb) = v1.evidence(k0h);
        assertEq(ec, keccak256("c3"));
        assertEq(ea, sha256(mA));
        assertEq(eb, sha256(mB));
        vm.expectRevert(abi.encodeWithSelector(PrawlRealEscrow.NotRedeemable.selector, PrawlRealEscrow.Status.Frozen));
        v1.redeem("c3", a, bobAddr, 0, 0);
    }

    /// The same equivocation is caught automatically when both branches are claimed.
    function test_equivocation_detectedByRedeem() public {
        _depositC3();
        assertTrue(v1.redeem("c3", _branch("bob"), bobAddr, 0, 0));
        assertFalse(v1.redeem("c3", _branch("charlie"), charlieAddr, 0, 0), "second branch exposes the key");
        assertEq(uint8(v1.coin("c3").status), uint8(PrawlRealEscrow.Status.Frozen));
        vm.warp(block.timestamp + WINDOW);
        vm.expectRevert(abi.encodeWithSelector(PrawlRealEscrow.NotRedeemable.selector, PrawlRealEscrow.Status.Frozen));
        v1.finalize("c3");
    }

    /// No false accusations: a malleated signature (r, n-s) on the SAME message, or a key that does not
    /// hold the coin, proves nothing.
    function test_equivocation_noFalsePositives() public {
        _depositC3();
        bytes memory mA = vm.parseJsonBytes(json, ".equivocation.branches.bob.messageHex");
        PrawlRealEscrow.Hop[] memory a = _branch("bob");
        bytes32 sMal = bytes32(N256 - uint256(a[0].s));
        vm.expectRevert(PrawlRealEscrow.SameMessage.selector);
        v1.proveEquivocation(
            "c3", new PrawlRealEscrow.Hop[](0), PrawlRealEscrow.Signed(mA, a[0].r, a[0].s), PrawlRealEscrow.Signed(mA, a[0].r, sMal)
        );
        // malleated tip signature on the same chain: same message => not equivocation, just NotDeeper
        v1.redeem("c3", a, bobAddr, 0, 0);
        a[0].s = sMal;
        vm.expectRevert(abi.encodeWithSelector(PrawlRealEscrow.NotDeeper.selector, 1, 1));
        v1.redeem("c3", a, bobAddr, 0, 0);
        // an outsider's own key signing two messages "about c3" cannot freeze c3
        uint256 mallory = 0xBADBAD;
        bytes memory x1 = "PRAWL-OTK-v1|c3|0.05|0|aa|bb";
        bytes memory x2 = "PRAWL-OTK-v1|c3|0.05|0|aa|cc";
        (bytes32 r1, bytes32 s1) = vm.signP256(mallory, sha256(x1));
        (bytes32 r2, bytes32 s2) = vm.signP256(mallory, sha256(x2));
        vm.expectRevert(abi.encodeWithSelector(PrawlRealEscrow.BadSig.selector, 0));
        v1.proveEquivocation(
            "c3", new PrawlRealEscrow.Hop[](0), PrawlRealEscrow.Signed(x1, r1, s1), PrawlRealEscrow.Signed(x2, r2, s2)
        );
    }

    // ------------------------------------------------------------------ 4. production mode: tip key signs the payout

    struct SwChain {
        uint256[] pk;
        PrawlRealEscrow.Hop[] hops;
        bytes32 prev; // prevHash after the last hop
    }

    /// SYNTHETIC software keys k0 -> k1 -> ... -> kn on coin `id` of escrow `e` (vm.signP256).
    function _swChain(PrawlRealEscrow e, string memory id, uint256 n, uint256 seed) internal returns (SwChain memory c) {
        c.pk = new uint256[](n + 1);
        for (uint256 i = 0; i <= n; i++) c.pk[i] = uint256(keccak256(abi.encode(seed, i))) % N256;
        (uint256 x0, uint256 y0) = vm.publicKeyP256(c.pk[0]);
        vm.prank(alice);
        e.deposit{value: 1 ether}(id, "1", bytes32(x0), bytes32(y0), uint64(block.timestamp + 30 days));
        c.hops = new PrawlRealEscrow.Hop[](n);
        c.prev = e.coin(id).mintHash;
        for (uint256 i = 0; i < n; i++) {
            (uint256 x, uint256 y) = vm.publicKeyP256(c.pk[i + 1]);
            (, bytes32 d) = e.hopDigest(id, i, c.prev, bytes32(x), bytes32(y));
            (bytes32 r, bytes32 s) = vm.signP256(c.pk[i], d);
            c.hops[i] = PrawlRealEscrow.Hop(bytes32(x), bytes32(y), r, s);
            c.prev = sha256(codec.derSig(r, s));
        }
    }

    function _tip(PrawlRealEscrow e, string memory id, SwChain memory c, uint256 n, address payout)
        internal
        returns (bytes32 r, bytes32 s)
    {
        (, bytes32 d) = e.redeemDigest(id, n, c.prev, payout);
        (r, s) = vm.signP256(c.pk[n], d);
    }

    function test_prod_tipAuth_redeems() public {
        SwChain memory c = _swChain(prod, "p1", 2, 1);
        (bytes32 r, bytes32 s) = _tip(prod, "p1", c, 2, daveAddr);
        // wrong payout: the tip signature names Dave
        vm.expectRevert(abi.encodeWithSelector(PrawlRealEscrow.BadSig.selector, 2));
        prod.redeem("p1", c.hops, charlieAddr, r, s);
        assertTrue(prod.redeem("p1", c.hops, daveAddr, r, s));
        vm.warp(block.timestamp + WINDOW);
        prod.finalize("p1");
        assertEq(daveAddr.balance, 1 ether);
    }

    function test_prod_realChainWithoutTipAuth_rejected() public {
        _depositC1(prod, "0.2", 0.2 ether);
        vm.expectRevert(PrawlRealEscrow.TipAuthRequired.selector);
        prod.redeem("c1", _hopsN("dave", 2), daveAddr, 0, 0);
    }

    /// A holder who paid on and then redeems must sign twice: caught in either order.
    function test_prod_paidOnThenRedeem_isEquivocation() public {
        SwChain memory c = _swChain(prod, "p2", 2, 2);
        // k1 paid k2 (hop 1) but also signs a redemption to Bob after only hop 0
        SwChain memory pre = c;
        PrawlRealEscrow.Hop[] memory h1 = new PrawlRealEscrow.Hop[](1);
        h1[0] = c.hops[0];
        pre.prev = sha256(codec.derSig(c.hops[0].r, c.hops[0].s));
        (bytes32 r1, bytes32 s1) = _tip(prod, "p2", pre, 1, bobAddr);
        assertTrue(prod.redeem("p2", h1, bobAddr, r1, s1));
        (bytes32 r2, bytes32 s2) = _tip(prod, "p2", c, 2, daveAddr);
        assertFalse(prod.redeem("p2", c.hops, daveAddr, r2, s2), "k1 signed hop 1 AND a redemption");
        (uint256 x1, uint256 y1) = vm.publicKeyP256(c.pk[1]);
        assertTrue(prod.brokenKey(codec.keyHash(bytes32(x1), bytes32(y1))));
        assertEq(uint8(prod.coin("p2").status), uint8(PrawlRealEscrow.Status.Frozen));
    }

    // ------------------------------------------------------------------ 5. gas table

    function test_gas_table() public {
        _depositC1(v1, "0.2", 0.2 ether);
        PrawlRealEscrow.Hop[] memory h1 = _hopsN("bob", 1);
        PrawlRealEscrow.Hop[] memory h2 = _hopsN("dave", 2);
        uint256 snap = vm.snapshotState();
        uint256 g = gasleft();
        v1.redeem("c1", h1, bobAddr, 0, 0);
        console.log("v1 redeem REAL 1 hop, first claim:", g - gasleft());
        vm.revertToState(snap);
        g = gasleft();
        v1.redeem("c1", h2, daveAddr, 0, 0);
        console.log("v1 redeem REAL 2 hops, first claim:", g - gasleft());
        vm.revertToState(snap);
        v1.redeem("c1", h1, bobAddr, 0, 0);
        g = gasleft();
        v1.redeem("c1", h2, daveAddr, 0, 0);
        console.log("v1 redeem REAL 2 hops, superseding a 1-hop claim:", g - gasleft());
        vm.warp(block.timestamp + WINDOW);
        g = gasleft();
        v1.finalize("c1");
        console.log("finalize:", g - gasleft());
        for (uint256 n = 1; n <= 4; n++) {
            string memory id = string.concat("g", vm.toString(n));
            SwChain memory c = _swChain(prod, id, n, 100 + n);
            (bytes32 r, bytes32 s) = _tip(prod, id, c, n, daveAddr);
            g = gasleft();
            prod.redeem(id, c.hops, daveAddr, r, s);
            console.log("prod redeem SYNTHETIC hops + tip sig, hops =", n, g - gasleft());
        }
    }
}
