// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {V3Base} from "./V3Base.sol";
import {PrawlEscrowV31} from "../src/PrawlEscrowV31.sol";
import {PrawlV3Codec as V3} from "../src/PrawlV3Codec.sol";
import {PrawlCodec} from "../src/PrawlCodec.sol";

/// @notice The contract rebuilds the v3 message bytes exactly as the independent Python reference
///  (tools/prawl_v3.py) wrote them, for every spend of every vector; and the storage layout is the one the
///  light-client deposit proof relies on.
contract CodecTest is V3Base {
    address constant ESCROW = address(0xE5C70);
    PrawlEscrowV31 e;

    function setUp() public {
        vm.warp(NOW);
        _loadFixture("fixtures/v3_synthetic.json");
        e = _deployAt(ESCROW, GRACE, MAX_LIFETIME);
    }

    /// Every path spend and every REDEEM spend of every synthetic vector: message bytes, digest, note ids.
    function test_messages_matchPythonByteForByte() public view {
        string[] memory names = vm.parseJsonStringArray(fx, ".redeemNames");
        uint256 checked;
        for (uint256 i = 0; i < names.length; i++) {
            string memory base = string.concat(".redeems.", names[i]);
            PrawlEscrowV31.Header memory h = _header(_coinOf(names[i]));
            uint256 n = vm.parseJsonUint(fx, string.concat(base, ".nPath"));
            bytes32 noteId = e.genesisNoteId(h.coinId);
            for (uint256 d = 0; d <= n; d++) {
                string memory b = d < n ? string.concat(base, ".path[", vm.toString(d), "]") : string.concat(base, ".redeem");
                assertEq(noteId, vm.parseJsonBytes32(fx, string.concat(b, ".noteId")), "note id chain");
                (bytes memory m, bytes32 dg) = e.spendMessage(h, d, noteId, _outputs(b));
                assertEq(m, vm.parseJsonBytes(fx, string.concat(b, ".message")), string.concat("message ", names[i]));
                assertEq(dg, vm.parseJsonBytes32(fx, string.concat(b, ".digest")));
                if (d < n) {
                    noteId = e.childNoteId(
                        vm.parseJsonBytes32(fx, string.concat(b, ".r")),
                        vm.parseJsonBytes32(fx, string.concat(b, ".s")),
                        vm.parseJsonUint(fx, string.concat(b, ".index"))
                    );
                }
                checked++;
            }
        }
        assertGt(checked, 100);
    }

    /// A concrete message, spelled out (Charlie's REDEEM in the split tree).
    function test_message_literal() public view {
        PrawlEscrowV31.Header memory h = _header("tree");
        (bytes memory m,) = e.spendMessage(
            h,
            2,
            vm.parseJsonBytes32(fx, ".redeems.tree_charlie.redeem.noteId"),
            _outputs(".redeems.tree_charlie.redeem")
        );
        assertEq(
            string(m),
            string.concat(
                "PRAWL-OTK-v3|31337|00000000000000000000000000000000000e5c70|",
                "e4a06a5bb3494a2542ff84a172de0bd12ad21566ef0b95bb757af44d7f72991f|1796558400|2|",
                "5f6bd2f1d3219239a7da71638d97728eacbe39e02230e18f7bdeb8c2416b66de|",
                "3017032e9f874448da57bc261661c454268ac45a678f401b788738f2c9797a54"
            )
        );
    }

    function test_redeemKeyHash_and_spkiHash() public view {
        // REDEEM output key = sha256hex("PRAWL-REDEEM|31337|<escrow40>|<payout40>")
        address payout = vm.parseJsonAddress(fx, ".redeems.tree_charlie.payout");
        bytes32 want = sha256(
            abi.encodePacked("PRAWL-REDEEM|31337|00000000000000000000000000000000000e5c70|", PrawlCodec.hexAddr(payout))
        );
        assertEq(e.redeemKeyHash(payout), want);
        assertEq(vm.parseJsonBytes32(fx, ".redeems.tree_charlie.redeem.keyHashes[0]"), want);
        // k0 key hash = sha256(SPKI DER) from (x, y)
        PrawlEscrowV31.Header memory h = _header("tree");
        assertEq(e.keyHash(bytes32(h.k0x), bytes32(h.k0y)), vm.parseJsonBytes32(fx, ".coins.tree.k0Hash"));
    }

    function test_hexBytes_and_outputsHash_edgeCases() public view {
        // DER of a signature with small r and s (short INTEGERs) and with high bits (0x00 padding)
        assertEq(V3.hexBytes(hex""), "");
        assertEq(V3.hexBytes(hex"00ff10"), "00ff10");
        assertEq(V3.hexBytes(hex"000102030405060708090a0b0c0d0e0f10"), "000102030405060708090a0b0c0d0e0f10");
        V3.Output[] memory o = new V3.Output[](2);
        o[0] = V3.Output(type(uint256).max, bytes32(uint256(1)));
        o[1] = V3.Output(0, bytes32(type(uint256).max));
        bytes32 want = sha256(
            abi.encodePacked(
                "115792089237316195423570985008687907853269984665640564039457584007913129639935:",
                "0000000000000000000000000000000000000000000000000000000000000001;0:",
                "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
            )
        );
        assertEq(e.outputsHash(o), want);
    }

    /// The assembly fast paths in PrawlV3Codec produce exactly the bytes of the (copied, unmodified) PrawlCodec
    /// reference functions. The fast result is computed FIRST, so a wrong free-memory pointer would let the
    /// reference allocation overwrite it and the comparison would fail.
    function testFuzz_fastCodec_equalsReference(uint256 v, address a, address b, bytes32 r, bytes32 s, uint8 zr, uint8 zs)
        public
        pure
    {
        bytes memory fd = V3.dec(v);
        assertEq(fd, PrawlCodec.dec(v));
        bytes memory fa = V3.hexAddr(a);
        assertEq(fa, PrawlCodec.hexAddr(a));
        // exercise short INTEGERs (leading zero bytes) as well as 0x00 padding (high bit set)
        r = zr % 33 == 32 ? bytes32(0) : bytes32(uint256(r) >> (8 * (zr % 33)));
        s = zs % 33 == 32 ? bytes32(0) : bytes32(uint256(s) >> (8 * (zs % 33)));
        bytes memory fs = V3.derSig(r, s);
        assertEq(fs, PrawlCodec.derSig(r, s));
        bytes32 ft = V3.redeemTarget(v, a, b);
        assertEq(ft, PrawlCodec.redeemTarget(v, a, b));
        assertEq(V3.dec(0), "0");
    }

    // ------------------------------------------------------------------ storage layout (light-client deposit proof)

    /// `deposits` is storage slot 0: the value at keccak256(abi.encode(coinId, uint256(0))) is the commitment
    /// keccak256(abi.encode(value, expiry, k0x, k0y, depositor)).
    function test_storage_depositsIsSlot0() public {
        PrawlEscrowV31.Header memory h = _depositCoin(e, "tree");
        bytes32 slot = keccak256(abi.encode(h.coinId, uint256(0)));
        bytes32 want = keccak256(abi.encode(h.value, h.expiry, h.k0x, h.k0y, h.depositor));
        assertEq(vm.load(address(e), slot), want, "deposits[coinId] lives at keccak(coinId, 0)");
        assertEq(e.deposits(h.coinId), want);
        assertEq(e.commitment(h.value, h.expiry, h.k0x, h.k0y, h.depositor), want);
        // nothing else moved into slot 0 itself
        assertEq(vm.load(address(e), bytes32(uint256(0))), bytes32(0));
    }

    /// `coins` is slot 1: paid in the low 128 bits, frozen at byte 16, closed at byte 17.
    function test_storage_coinStateIsSlot1() public {
        PrawlEscrowV31.Header memory h = _depositCoin(e, "tree");
        assertTrue(_redeem(e, "tree_charlie"));
        bytes32 w = vm.load(address(e), keccak256(abi.encode(h.coinId, uint256(1))));
        assertEq(uint256(w) & type(uint128).max, 0.1 ether, "paid");
        assertEq((uint256(w) >> 128) & 0xff, 0, "frozen");
        (uint128 paid, bool frozen, bool closed) = e.coins(h.coinId);
        assertEq(paid, 0.1 ether);
        assertFalse(frozen);
        assertFalse(closed);
    }

    /// The layout also holds per `forge inspect` (checked by run_all.sh); here: slot 2 is firstMsg.
    function test_storage_firstMsgIsSlot2() public {
        PrawlEscrowV31.Header memory h = _depositCoin(e, "tree");
        assertTrue(_redeem(e, "tree_charlie"));
        bytes32 k0 = e.keyHash(bytes32(h.k0x), bytes32(h.k0y));
        assertEq(
            vm.load(address(e), keccak256(abi.encode(k0, uint256(2)))),
            vm.parseJsonBytes32(fx, ".redeems.tree_charlie.path[0].digest")
        );
    }
}
