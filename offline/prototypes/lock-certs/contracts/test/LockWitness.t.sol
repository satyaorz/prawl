// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";
import "../src/LockWitnessRegistry.sol";

contract LockWitnessTest is Test {
    string json;
    LockWitnessRegistry reg;

    receive() external payable {}

    struct V {
        bytes[] pks;
        bytes[] pops;
        bytes32 nf;
        bytes32 hB;
        bytes32 hC;
        uint256 bmB;
        uint256 bmC;
        bytes sigB;
        bytes sigC;
        uint32 q;
    }

    function setUp() public {
        json = vm.readFile("test/vectors.json");
        reg = new LockWitnessRegistry(vm.parseJsonBytes(json, ".negG2"));
    }

    function load(string memory k) internal view returns (V memory v) {
        v.pks = vm.parseJsonBytesArray(json, string.concat(".", k, ".pks"));
        v.pops = vm.parseJsonBytesArray(json, string.concat(".", k, ".pops"));
        v.nf = vm.parseJsonBytes32(json, string.concat(".", k, ".nf"));
        v.hB = vm.parseJsonBytes32(json, string.concat(".", k, ".hB"));
        v.hC = vm.parseJsonBytes32(json, string.concat(".", k, ".hC"));
        v.bmB = uint256(vm.parseJsonBytes32(json, string.concat(".", k, ".bitmapB")));
        v.bmC = uint256(vm.parseJsonBytes32(json, string.concat(".", k, ".bitmapC")));
        v.sigB = vm.parseJsonBytes(json, string.concat(".", k, ".sigB"));
        v.sigC = vm.parseJsonBytes(json, string.concat(".", k, ".sigC"));
        v.q = uint32(vm.parseJsonUint(json, string.concat(".", k, ".q")));
    }

    function setupCommittee(V memory v) internal {
        for (uint256 i; i < v.pks.length; ++i) {
            uint256 g = gasleft();
            reg.register{value: 1 ether}(v.pks[i], v.pops[i]);
            if (i == 0) console.log("register(pk, PoP) gas (execution):", g - gasleft());
        }
        reg.setCommittee(1, v.pks, v.q);
    }

    function runSlash(string memory k) internal {
        V memory v = load(k);
        setupCommittee(v);
        uint256 g = gasleft();
        assertTrue(reg.verifyCert(1, v.pks, v.nf, v.hB, v.bmB, v.sigB));
        console.log(string.concat(k, " verifyCert gas (execution):"), g - gasleft());
        g = gasleft();
        uint256 total = reg.slashEquivocation(1, v.pks, v.nf, LockWitnessRegistry.Cert(v.hB, v.bmB, v.sigB), LockWitnessRegistry.Cert(v.hC, v.bmC, v.sigC));
        console.log(string.concat(k, " slashEquivocation gas (execution):"), g - gasleft());
        uint256 inter = v.bmB & v.bmC;
        uint256 cnt;
        for (uint256 i; i < v.pks.length; ++i) {
            bool s = reg.isSlashed(keccak256(v.pks[i]));
            assertEq(s, (inter >> i) & 1 == 1);
            if (s) ++cnt;
        }
        assertEq(total, cnt * 1 ether);
        console.log("  slashed witnesses:", cnt);
    }

    function test_Slash_n4() public { runSlash("n4"); }
    function test_Slash_n7() public { runSlash("n7"); }
    function test_Slash_n10() public { runSlash("n10"); }
    function test_Slash_n31() public { runSlash("n31"); }
    function test_Slash_n100() public { runSlash("n100"); }

    /// Framing attempt: claim an honest witness (outside the true signer set) signed cert C.
    function test_FramingRejected() public {
        V memory v = load("n7");
        setupCommittee(v);
        uint256 fakeBm = v.bmC | (1 << 4); // witness 4 signed only B; add it to C's bitmap
        assertFalse(reg.verifyCert(1, v.pks, v.nf, v.hC, fakeBm, v.sigC));
        vm.expectRevert(bytes("certB"));
        reg.slashEquivocation(1, v.pks, v.nf, LockWitnessRegistry.Cert(v.hB, v.bmB, v.sigB), LockWitnessRegistry.Cert(v.hC, fakeBm, v.sigC));
    }

    function test_SubQuorumRejected() public {
        V memory v = load("n4");
        setupCommittee(v);
        // drop one signer from the bitmap: popcount < q
        assertFalse(reg.verifyCert(1, v.pks, v.nf, v.hB, v.bmB & ~uint256(1), v.sigB));
    }

    function test_SameHNotSlashable() public {
        V memory v = load("n4");
        setupCommittee(v);
        vm.expectRevert(bytes("not conflicting"));
        reg.slashEquivocation(1, v.pks, v.nf, LockWitnessRegistry.Cert(v.hB, v.bmB, v.sigB), LockWitnessRegistry.Cert(v.hB, v.bmB, v.sigB));
    }

    function test_WrongMessageRejected() public {
        V memory v = load("n4");
        setupCommittee(v);
        assertFalse(reg.verifyCert(1, v.pks, v.nf, v.hC, v.bmB, v.sigB));
    }

    function test_BadPoPRejected() public {
        V memory v = load("n4");
        vm.expectRevert(bytes("bad PoP"));
        reg.register{value: 1 ether}(v.pks[0], v.pops[1]);
    }
}
