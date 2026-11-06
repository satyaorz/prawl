// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SoftKeys} from "./SoftKeys.sol";
import {console} from "forge-std/Test.sol";
import {PrawlEscrowV3} from "../src/PrawlEscrowV3.sol";
import {PrawlV3Codec as V3} from "../src/PrawlV3Codec.sol";

/// @notice Property tests over RANDOM split trees, built and signed inside Foundry with software P-256 keys.
///  Every note is spent exactly once (a random split into 1..4 outputs, each a new key note or a REDEEM
///  output, down to depth 4), so the REDEEM outputs partition the deposit. All of them are then redeemed in a
///  random order.
///   * honest trees: every REDEEM output pays, total paid == deposit, the coin never freezes;
///   * with one equivocating key K (a random note's key signs a second, different spend): every REDEEM output
///     whose path avoids K pays; the paid outputs under K all come from ONE of K's two spends; the coin ends
///     frozen; total paid <= deposit.
///  Tree state lives in storage (each fuzz run starts again from the post-setUp state).
abstract contract FuzzTreeBase is SoftKeys {
    uint256 constant MAX_DEPTH = 4;
    uint256 constant MAX_SPLITS = 7;
    uint256 constant NONE = type(uint256).max;

    PrawlEscrowV3 e;
    PrawlEscrowV3.Header h;
    uint256 rnd;

    // notes
    Key[] nKey;
    uint256[] nValue;
    bytes32[] nId;
    uint256[] nDepth;
    uint256[] nParentSpend; // NONE for genesis
    uint256[] nParentIdx;
    // spends
    uint256[] sNote;
    bytes32[] sR;
    bytes32[] sS;
    mapping(uint256 => V3.Output[]) sOuts;
    mapping(uint256 => uint256[]) sChild; // note index per output, NONE for a REDEEM output
    mapping(uint256 => address[]) sPayout; // payout per REDEEM output
    // redeemable outputs
    uint256[] rSpend;
    uint256[] rIdx;
    // equivocation
    uint256 eqNote = NONE;
    uint256 eqSpendA = NONE;
    uint256 eqSpendB = NONE;

    function setUp() public {
        vm.warp(NOW);
        e = _deployAt(address(0xE5C70), GRACE, MAX_LIFETIME);
    }

    // ------------------------------------------------------------------ tree construction

    function _rand() internal returns (uint256) {
        rnd = uint256(keccak256(abi.encode(rnd)));
        return rnd;
    }

    function _build(uint256 seed, uint256 value, bool withEq) internal {
        rnd = seed;
        Key memory k0 = _key(abi.encode(seed, "k0"));
        h = PrawlEscrowV3.Header(keccak256(abi.encode(seed, "coin")), value, uint64(NOW + 30 days), uint256(k0.x), uint256(k0.y), address(0xA11CE));
        _deposit(e, h);
        _addNote(k0, value, e.genesisNoteId(h.coinId), 0, NONE, 0);
        uint256 splits;
        // pick the equivocating note: decided when notes are processed (the first note at a random position)
        uint256 eqAt = withEq ? _rand() % 3 : NONE;
        for (uint256 n = 0; n < nValue.length; n++) {
            bool split = nDepth[n] < MAX_DEPTH && splits < MAX_SPLITS && (n == 0 || _rand() % 3 != 0);
            uint256 sid = split ? _splitSpend(n) : _redeemSpend(n);
            if (split) splits++;
            if (withEq && eqNote == NONE && (n == eqAt || n + 1 == nValue.length)) {
                eqNote = n;
                eqSpendA = sid;
                eqSpendB = _altSpend(n);
            }
        }
    }

    function _addNote(Key memory k, uint256 v, bytes32 id, uint256 depth, uint256 ps, uint256 pi) internal {
        nKey.push(k);
        nValue.push(v);
        nId.push(id);
        nDepth.push(depth);
        nParentSpend.push(ps);
        nParentIdx.push(pi);
    }

    /// Random split into f outputs (each >= 1 wei); each output is a new key note or a REDEEM output.
    function _splitSpend(uint256 n) internal returns (uint256 sid) {
        uint256 v = nValue[n];
        uint256 f = 1 + _rand() % 4;
        if (f > v) f = v;
        sid = sNote.length;
        sNote.push(n);
        uint256 rest = v;
        for (uint256 j = 0; j < f; j++) {
            uint256 part = j + 1 == f ? rest : 1 + _rand() % (rest - (f - 1 - j));
            rest -= part;
            if (_rand() % 3 == 0 || nDepth[n] + 1 > MAX_DEPTH) {
                address po = address(uint160(uint256(keccak256(abi.encode(rnd, "payout", sid, j)))));
                sOuts[sid].push(V3.Output(part, e.redeemKeyHash(po)));
                sChild[sid].push(NONE);
                sPayout[sid].push(po);
            } else {
                keySeed[sid][j] = abi.encode(rnd, "key", sid, j);
                Key memory k = _key(keySeed[sid][j]);
                sOuts[sid].push(V3.Output(part, k.kh));
                sChild[sid].push(nValue.length + j); // placeholder index, fixed below
                sPayout[sid].push(address(0));
            }
        }
        _sign(sid, n);
        // create the child notes (their ids depend on the signature)
        for (uint256 j = 0; j < f; j++) {
            if (sChild[sid][j] == NONE) {
                rSpend.push(sid);
                rIdx.push(j);
                continue;
            }
            sChild[sid][j] = nValue.length;
            _addNote(
                _key(keySeed[sid][j]), sOuts[sid][j].value, e.childNoteId(sR[sid], sS[sid], j), nDepth[n] + 1, sid, j
            );
        }
    }

    /// Seeds of child-note keys, fixed when the output is created (the note itself is added after signing).
    mapping(uint256 => mapping(uint256 => bytes)) keySeed;

    /// The note's key redeems it: one REDEEM output, or two if the value allows.
    function _redeemSpend(uint256 n) internal returns (uint256 sid) {
        uint256 v = nValue[n];
        sid = sNote.length;
        sNote.push(n);
        uint256 f = v >= 2 && _rand() % 2 == 0 ? 2 : 1;
        uint256 first = f == 2 ? 1 + _rand() % (v - 1) : v;
        for (uint256 j = 0; j < f; j++) {
            address po = address(uint160(uint256(keccak256(abi.encode(rnd, "redeem", sid, j)))));
            sOuts[sid].push(V3.Output(j == 0 ? first : v - first, e.redeemKeyHash(po)));
            sChild[sid].push(NONE);
            sPayout[sid].push(po);
            rSpend.push(sid);
            rIdx.push(j);
        }
        _sign(sid, n);
    }

    /// The equivocation: note n's key signs a SECOND spend, paying a fresh key that redeems everything.
    function _altSpend(uint256 n) internal returns (uint256 sid) {
        sid = sNote.length;
        sNote.push(n);
        Key memory k = _key(abi.encode(rnd, "evil", n));
        keySeed[sid][0] = abi.encode(rnd, "evil", n);
        sOuts[sid].push(V3.Output(nValue[n], k.kh));
        sChild[sid].push(nValue.length);
        sPayout[sid].push(address(0));
        _sign(sid, n);
        _addNote(k, nValue[n], e.childNoteId(sR[sid], sS[sid], 0), nDepth[n] + 1, sid, 0);
        // the main loop spends this child like any other note
    }

    function _sign(uint256 sid, uint256 n) internal {
        (bytes32 r, bytes32 s) = _signSpend(e, h, nDepth[n], nId[n], sOuts[sid], nKey[n].sk);
        sR.push(r);
        sS.push(s);
    }

    // ------------------------------------------------------------------ redemption arguments

    function _redeemArgs(uint256 k)
        internal
        view
        returns (PrawlEscrowV3.Spend[] memory p, PrawlEscrowV3.Redemption memory rd)
    {
        uint256 sid = rSpend[k];
        uint256 note = sNote[sid];
        p = new PrawlEscrowV3.Spend[](nDepth[note]);
        for (uint256 cur = note; nParentSpend[cur] != NONE; cur = sNote[nParentSpend[cur]]) {
            uint256 ps = nParentSpend[cur];
            p[nDepth[cur] - 1] =
                PrawlEscrowV3.Spend(sOuts[ps], nParentIdx[cur], sR[ps], sS[ps], nKey[cur].x, nKey[cur].y);
        }
        rd = PrawlEscrowV3.Redemption(sOuts[sid], rIdx[k], sPayout[sid][rIdx[k]], sR[sid], sS[sid]);
    }

    /// Is spend `sid` (or any spend on its path) made by the equivocating note? Which of K's spends?
    function _branch(uint256 sid) internal view returns (uint256 branch, bool under) {
        if (eqNote == NONE) return (NONE, false);
        if (sNote[sid] == eqNote) return (sid, true);
        for (uint256 cur = sNote[sid]; nParentSpend[cur] != NONE; cur = sNote[nParentSpend[cur]]) {
            uint256 ps = nParentSpend[cur];
            if (sNote[ps] == eqNote) return (ps, true);
        }
        return (NONE, false);
    }

    function _order() internal returns (uint256[] memory ord) {
        ord = new uint256[](rSpend.length);
        for (uint256 i = 0; i < ord.length; i++) ord[i] = i;
        for (uint256 i = ord.length; i > 1; i--) {
            uint256 j = _rand() % i;
            (ord[i - 1], ord[j]) = (ord[j], ord[i - 1]);
        }
    }
}

/// @notice Not a property: prints what the generator produces, to show the fuzz trees are non-trivial.
contract FuzzTreeStats is FuzzTreeBase {
    function test_treeStats() public {
        uint256 runs = 40;
        uint256 notes;
        uint256 redeems;
        uint256 maxD;
        uint256 maxFan;
        uint256 snap = vm.snapshotState();
        for (uint256 i = 0; i < runs; i++) {
            _build(uint256(keccak256(abi.encode("stats", i))), 1 ether, i % 2 == 1);
            notes += nValue.length;
            redeems += rSpend.length;
            for (uint256 n = 0; n < nDepth.length; n++) if (nDepth[n] > maxD) maxD = nDepth[n];
            for (uint256 s = 0; s < sNote.length; s++) if (sOuts[s].length > maxFan) maxFan = sOuts[s].length;
            vm.revertToState(snap);
        }
        console.log("random trees: avg notes x100 =", notes * 100 / runs);
        console.log("              avg REDEEM outputs x100 =", redeems * 100 / runs);
        console.log("              max note depth =", maxD, " max fan-out =", maxFan);
        assertGt(redeems, runs * 3);
        assertEq(maxD, MAX_DEPTH);
    }
}

contract FuzzTreeTest is FuzzTreeBase {
    // ------------------------------------------------------------------ properties

    function testFuzz_randomTree_honest_allPaid(uint256 seed, uint96 value) public {
        _build(seed, bound(value, 1, 1e24), false);
        uint256 total;
        uint256[] memory ord = _order();
        for (uint256 i = 0; i < ord.length; i++) {
            uint256 k = ord[i];
            address po = sPayout[rSpend[k]][rIdx[k]];
            uint256 amt = sOuts[rSpend[k]][rIdx[k]].value;
            uint256 before = po.balance;
            (PrawlEscrowV3.Spend[] memory p, PrawlEscrowV3.Redemption memory rd) = _redeemArgs(k);
            assertTrue(e.redeem(h, p, rd), "every honest REDEEM output pays");
            assertEq(po.balance - before, amt);
            total += amt;
        }
        (uint128 paid, bool frozen,) = e.coins(h.coinId);
        assertEq(total, h.value, "REDEEM outputs partition the deposit");
        assertEq(paid, h.value);
        assertFalse(frozen);
        assertEq(address(e).balance, 0);
    }

    function testFuzz_randomTree_oneEquivocation(uint256 seed, uint96 value) public {
        _build(seed, bound(value, 1, 1e24), true);
        uint256 total;
        bool paidA;
        bool paidB;
        uint256[] memory ord = _order();
        for (uint256 i = 0; i < ord.length; i++) {
            uint256 k = ord[i];
            (uint256 branch, bool under) = _branch(rSpend[k]);
            (PrawlEscrowV3.Spend[] memory p, PrawlEscrowV3.Redemption memory rd) = _redeemArgs(k);
            try e.redeem(h, p, rd) returns (bool ok) {
                if (ok) {
                    total += sOuts[rSpend[k]][rIdx[k]].value;
                    if (under) {
                        if (branch == eqSpendA) paidA = true;
                        else paidB = true;
                    }
                } else {
                    assertTrue(under, "only a path through K can be refused");
                }
            } catch (bytes memory err) {
                assertTrue(under, "only a path through K can revert");
                assertEq(bytes4(err), PrawlEscrowV3.KeyBroken.selector, "refused as KeyBroken");
            }
            if (!under) {
                (uint128 pd,,) = e.coins(h.coinId);
                assertGe(pd, sOuts[rSpend[k]][rIdx[k]].value);
            }
        }
        assertFalse(paidA && paidB, "outputs of BOTH of K's spends were paid");
        (uint128 paid, bool frozen,) = e.coins(h.coinId);
        assertEq(paid, total);
        assertLe(total, h.value, "total paid <= deposit");
        assertTrue(frozen, "both branches were submitted: the coin must be frozen");
        assertTrue(e.brokenKey(nKey[eqNote].kh));
        // every output not under K was paid: total >= deposit - value(K's note)
        assertGe(total + nValue[eqNote], h.value);
        assertEq(address(e).balance, h.value - total);
    }
}
