// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {V3Base} from "./V3Base.sol";
import {console} from "forge-std/Test.sol";
import {PrawlEscrowV31} from "../src/PrawlEscrowV31.sol";

/// @notice Execution gas of the escrow's entry points (callee-side `_lastGas()`, i.e. without
///  the 21k base cost and calldata; the anvil receipts in tools/anvil_receipts.sh give full transaction gas).
///  Vectors: SYNTHETIC gas_d<D>_f<F> coins (D spends of fan-out F, then a one-output REDEEM spend).
///  Writes logs/gas_forge.md.
contract GasTest is V3Base {
    address constant ESCROW = address(0xE5C70);
    PrawlEscrowV31 e;
    string table;

    function setUp() public {
        vm.warp(NOW);
        _loadFixture("fixtures/v3_synthetic.json");
        e = _deployAt(ESCROW, GRACE, MAX_LIFETIME);
    }

    function _measure(string memory name) internal returns (uint256 g, uint256 cd) {
        (PrawlEscrowV31.Header memory h, PrawlEscrowV31.Spend[] memory p, PrawlEscrowV31.Redemption memory rd) = _load(name);
        cd = abi.encodeCall(PrawlEscrowV31.redeem, (h, p, rd)).length;
        assertTrue(e.redeem(h, p, rd), name);
        g = _lastGas();
        assertLt(g, TX_CAP, "under the EIP-7825 per-transaction cap");
    }

    function _row(string memory label, uint256 d, uint256 f, uint256 sigs, uint256 g, uint256 cd) internal {
        table = string.concat(
            table, "| ", label, " | ", vm.toString(d), " | ", vm.toString(f), " | ", vm.toString(sigs), " | ",
            vm.toString(g), " | ", vm.toString(cd), " |\n"
        );
        console.log(string.concat(label, " depth=", vm.toString(d), " fanout=", vm.toString(f), " gas=", vm.toString(g), " calldataB=", vm.toString(cd)));
    }

    function test_gas_redeemMatrix() public {
        table = "| redemption | path spends D | fan-out F | P256VERIFY calls | lastCallGas (execution; full tx when isolated) | calldata B |\n|---|---:|---:|---:|---:|---:|\n";
        // deposit cost
        PrawlEscrowV31.Header memory h0 = _header("gas_d0_f2");
        vm.deal(h0.depositor, h0.value);
        vm.prank(h0.depositor);
        e.deposit{value: h0.value}(h0.coinId, h0.expiry, h0.k0x, h0.k0y);
        uint256 gDep = _lastGas();
        (uint256 g, uint256 cd) = _measure("gas_d0_f2");
        _row("first (cold), genesis note redeems itself", 0, 1, 1, g, cd);
        uint256[5] memory ds = [uint256(1), 2, 3, 8, 16];
        uint256[2] memory fs = [uint256(2), 4];
        uint256 g8;
        uint256 g16;
        for (uint256 i = 0; i < ds.length; i++) {
            for (uint256 j = 0; j < fs.length; j++) {
                if (ds[i] > 3 && fs[j] == 4) continue;
                string memory c = string.concat("gas_d", vm.toString(ds[i]), "_f", vm.toString(fs[j]));
                _depositCoin(e, c);
                (g, cd) = _measure(c);
                _row("first (cold): every key on the path is new", ds[i], fs[j], ds[i] + 1, g, cd);
                if (ds[i] == 8) g8 = g;
                if (ds[i] == 16) g16 = g;
                (g, cd) = _measure(string.concat(c, "_sib"));
                _row("sibling (warm): path keys already recorded", ds[i], fs[j], ds[i] + 1, g, cd);
            }
        }
        uint256 perHop = (g16 - g8) / 8;
        table = string.concat(
            table, "\ndeposit: ", vm.toString(gDep), " (lastCallGas)\n",
            "marginal cost per extra path spend (cold, fan-out 2), (d16 - d8) / 8: ", vm.toString(perHop), "\n",
            "DERIVED: deepest cold redemption under 2^24 (ignoring calldata) ~ ", vm.toString((TX_CAP - 21000 - g16) / perHop + 16), " spends\n"
        );
        console.log("deposit gas:", gDep);
        console.log("marginal per cold path spend (f=2):", perHop);
        vm.writeFile("logs/gas_forge.md", table);
    }

    function test_gas_equivocationAndReclaim() public {
        PrawlEscrowV31.Header memory h = _depositCoin(e, "eq");
        string memory b = string.concat(".equivocations.", _equivFor("eq"));
        PrawlEscrowV31.Spend[] memory p = _path(b);
        PrawlEscrowV31.Signed memory sa = _signed(string.concat(b, ".a"));
        PrawlEscrowV31.Signed memory sb = _signed(string.concat(b, ".b"));
        e.proveEquivocation(h, p, sa, sb);
        uint256 gProve = _lastGas();
        // detection through redeem: first branch, then the conflicting one
        PrawlEscrowV31.Header memory h0 = _depositCoin(e, "eq0");
        (PrawlEscrowV31.Header memory hh, PrawlEscrowV31.Spend[] memory pp, PrawlEscrowV31.Redemption memory rd) = _load("eq0_yan1");
        assertTrue(e.redeem(hh, pp, rd));
        (hh, pp, rd) = _load("eq0_yan2");
        assertFalse(e.redeem(hh, pp, rd));
        uint256 gDetect = _lastGas();
        vm.warp(uint256(h0.expiry) + GRACE);
        e.reclaim(h);
        uint256 gReclaim = _lastGas();
        console.log("proveEquivocation (accused at depth 1, prefix of 1 spend):", gProve);
        console.log("redeem that detects an equivocation (genesis key, depth 1):", gDetect);
        console.log("reclaim (frozen coin -> sink):", gReclaim);
        vm.writeFile(
            "logs/gas_forge_misc.md",
            string.concat(
                "proveEquivocation (accused at depth 1): ", vm.toString(gProve), "\n",
                "redeem detecting an equivocation (genesis, depth 1): ", vm.toString(gDetect), "\n",
                "reclaim (frozen coin -> sink): ", vm.toString(gReclaim), "\n"
            )
        );
        assertLt(gProve, TX_CAP);
    }
}
