// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {V3Base} from "./V3Base.sol";
import {console} from "forge-std/Test.sol";
import {PrawlEscrowV3} from "../src/PrawlEscrowV3.sol";

/// @notice Generic replay of ANY fixture produced by tools/bundles_to_foundry.py -- synthetic or REAL phone
///  bundles. Nothing here knows the scenario: escrow address, chain id, coins, paths and expectations all
///  come from the fixture.
///
///  REAL phone vectors (coordinator):
///    python tools/bundles_to_foundry.py --in <dir with redeem3_*.json / pay3_*.json> --out fixtures/v3_phone.json \
///        [--depositor 0x<account that sent the deposit>]
///    forge test --offline --match-contract GenericVectorsTest -vv          (V3_FIXTURE=<path> to use another file)
///
///  For every coin: the escrow code is placed at the coin's escrow address (deployCodeTo), the chain id is
///  set to the coin's, and the coin is deposited by its header's depositor. Then, per redemption:
///    * the contract's message bytes must equal the converter's for every spend (byte-for-byte check);
///    * expect = <error>: the call must revert with that error (any arguments);
///    * expect = ok: must pay exactly `amount` to `payout` -- unless the coin has a detected equivocation,
///      in which case "blocked" (false / KeyBroken) is also accepted and reported;
///    * expect = equivocation: paid, or blocked (false / KeyBroken).
///  Finally, from the post-deposit state, every converter-detected equivocation is proven with
///  proveEquivocation and must mark the key broken and freeze the coin.
contract GenericVectorsTest is V3Base {
    uint256 constant G_GRACE = 30 days;
    uint256 constant G_MAX_LIFETIME = 3650 days;

    function test_generic_syntheticFixture() public {
        _runAll("fixtures/v3_synthetic.json");
    }

    function test_generic_phoneFixture() public {
        string memory path = vm.envOr("V3_FIXTURE", string("fixtures/v3_phone.json"));
        if (!vm.exists(path)) {
            console.log("no phone fixture at", path, "- skipped (see contract docs)");
            vm.skip(true);
            return;
        }
        _runAll(path);
    }

    // ------------------------------------------------------------------ runner

    struct Tally {
        uint256 paid;
        uint256 blocked;
        uint256 reverted;
        uint256 msgsChecked;
    }

    function _runAll(string memory path) internal {
        _loadFixture(path);
        string[] memory coins = vm.parseJsonStringArray(fx, ".coinNames");
        uint256 minExp = type(uint256).max;
        for (uint256 i = 0; i < coins.length; i++) {
            uint256 x = _header(coins[i]).expiry;
            if (x < minExp) minExp = x;
        }
        vm.warp(minExp - 1 hours);
        for (uint256 i = 0; i < coins.length; i++) {
            address at = _coinEscrow(coins[i]);
            if (at.code.length == 0) _deployAt(at, G_GRACE, G_MAX_LIFETIME);
            vm.chainId(_coinChainId(coins[i]));
            _deposit(PrawlEscrowV3(at), _header(coins[i]));
        }
        uint256 snap = vm.snapshotState();

        string[] memory names = vm.parseJsonStringArray(fx, ".redeemNames");
        Tally memory t;
        // errors first (they must not change state), then plain redemptions, then equivocation branches
        for (uint256 pass = 0; pass < 3; pass++) {
            for (uint256 i = 0; i < names.length; i++) {
                string memory ex = _expect(names[i]);
                uint256 cls = _eq(ex, "ok") ? 1 : _eq(ex, "equivocation") ? 2 : 0;
                if (cls == pass) _one(names[i], ex, t);
            }
        }
        // invariants: per coin paid <= deposit; escrow balances == deposits - paid
        uint256 owedTotal;
        for (uint256 i = 0; i < coins.length; i++) {
            PrawlEscrowV3.Header memory h = _header(coins[i]);
            (uint128 paid,,) = PrawlEscrowV3(_coinEscrow(coins[i])).coins(h.coinId);
            assertLe(paid, h.value, "paid <= deposit");
            owedTotal += h.value - paid;
        }
        uint256 bal;
        for (uint256 i = 0; i < coins.length; i++) {
            address at = _coinEscrow(coins[i]);
            bool seen;
            for (uint256 j = 0; j < i; j++) if (_coinEscrow(coins[j]) == at) seen = true;
            if (!seen) bal += at.balance;
        }
        assertEq(bal, owedTotal, "escrow balance == deposits - payouts");
        console.log("redemptions paid / blocked by equivocation / reverted as expected:", t.paid, t.blocked, t.reverted);
        console.log("spend messages rebuilt byte-for-byte:", t.msgsChecked);

        // equivocation proofs, from the post-deposit state
        vm.revertToState(snap);
        string[] memory eqs = vm.parseJsonStringArray(fx, ".equivocationNames");
        for (uint256 i = 0; i < eqs.length; i++) {
            string memory b = string.concat(".equivocations.", eqs[i]);
            string memory coin = vm.parseJsonString(fx, string.concat(b, ".coin"));
            PrawlEscrowV3 e = PrawlEscrowV3(_coinEscrow(coin));
            vm.chainId(_coinChainId(coin));
            PrawlEscrowV3.Header memory h = _header(coin);
            bytes32 kh = e.proveEquivocation(h, _path(b), _signed(string.concat(b, ".a")), _signed(string.concat(b, ".b")));
            console.log(string.concat("  proveEquivocation ", eqs[i], ": gas"), _lastGas());
            assertEq(kh, vm.parseJsonBytes32(fx, string.concat(b, ".accusedKeyHash")));
            assertTrue(e.brokenKey(kh));
            (, bool frozen,) = e.coins(h.coinId);
            assertTrue(frozen);
        }
        console.log("equivocations proven:", eqs.length);
    }

    function _one(string memory name, string memory ex, Tally memory t) internal {
        string memory coin = _coinOf(name);
        PrawlEscrowV3 e = PrawlEscrowV3(_coinEscrow(coin));
        vm.chainId(_coinChainId(coin));
        (PrawlEscrowV3.Header memory h, PrawlEscrowV3.Spend[] memory p, PrawlEscrowV3.Redemption memory rd) = _load(name);
        t.msgsChecked += _checkMessages(e, h, name, p.length);
        if (!_eq(ex, "ok") && !_eq(ex, "equivocation")) {
            vm.expectPartialRevert(_sel(ex));
            e.redeem(h, p, rd);
            t.reverted++;
            console.log(string.concat("  ", name, ": reverted as expected (", ex, ")"));
            return;
        }
        uint256 before = rd.payout.balance + e.owed(rd.payout);
        try e.redeem(h, p, rd) returns (bool ok) {
            uint256 g = _lastGas();
            if (ok) {
                assertEq(rd.payout.balance + e.owed(rd.payout) - before, _amount(name), name);
                t.paid++;
                console.log(string.concat("  ", name, ": paid, depth ", vm.toString(p.length), ", execution gas"), g);
                return;
            }
        } catch (bytes memory err) {
            assertEq(bytes4(err), PrawlEscrowV3.KeyBroken.selector, string.concat(name, ": unexpected revert"));
        }
        // not paid: acceptable only as an equivocation outcome
        (, bool frozen,) = e.coins(h.coinId);
        assertTrue(frozen, string.concat(name, ": refused without a frozen coin"));
        assertTrue(_eq(ex, "equivocation") || _coinHasEquivocation(coin), string.concat(name, ": should have paid"));
        t.blocked++;
        console.log(string.concat("  ", name, ": blocked (equivocation in its coin)"));
    }

    function _checkMessages(PrawlEscrowV3 e, PrawlEscrowV3.Header memory h, string memory name, uint256 n)
        internal
        view
        returns (uint256 c)
    {
        string memory base = string.concat(".redeems.", name);
        for (uint256 d = 0; d <= n; d++) {
            string memory b = d < n ? string.concat(base, ".path[", vm.toString(d), "]") : string.concat(base, ".redeem");
            (bytes memory m,) = e.spendMessage(h, d, vm.parseJsonBytes32(fx, string.concat(b, ".noteId")), _outputs(b));
            assertEq(m, vm.parseJsonBytes(fx, string.concat(b, ".message")), string.concat(name, ": message bytes"));
            c++;
        }
    }

    function _coinHasEquivocation(string memory coin) internal view returns (bool) {
        string[] memory eqs = vm.parseJsonStringArray(fx, ".equivocationNames");
        for (uint256 i = 0; i < eqs.length; i++) {
            if (_eq(vm.parseJsonString(fx, string.concat(".equivocations.", eqs[i], ".coin")), coin)) return true;
        }
        return false;
    }
}
