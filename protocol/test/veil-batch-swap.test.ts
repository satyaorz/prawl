import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import { expect } from "chai";
import { AbiCoder, parseUnits } from "ethers";

import { ERC20Mock, MockBatchSwap, VeilConfidentialWrapper } from "../types";

type Signers = { deployer: HardhatEthersSigner; alice: HardhatEthersSigner; bob: HardhatEthersSigner; reserve: HardhatEthersSigner };

const DIRECTION_A_TO_B = 1;
const DIRECTION_B_TO_A = 2;
const WAD = parseUnits("1", 18);

async function decryptUser(handle: unknown, contract: string, user: HardhatEthersSigner): Promise<bigint> {
  return fhevm.userDecryptEuint(FhevmType.euint64, handle as string, contract, user);
}

describe("VeilBatchSwap", function () {
  let signers: Signers;
  let tokenA: ERC20Mock, tokenB: ERC20Mock;
  let cA: VeilConfidentialWrapper, cB: VeilConfidentialWrapper;
  let batch: MockBatchSwap;
  let batchAddress: string, cAAddress: string, cBAddress: string;

  before(async function () {
    const all: HardhatEthersSigner[] = await ethers.getSigners();
    signers = { deployer: all[0], alice: all[1], bob: all[2], reserve: all[3] };
  });

  beforeEach(async function () {
    if (!fhevm.isMock) throw new Error("This suite runs on the FHEVM mock network only");

    tokenA = (await (await ethers.getContractFactory("ERC20Mock")).deploy("vUSD", "vUSD", 18)) as ERC20Mock;
    tokenB = (await (await ethers.getContractFactory("ERC20Mock")).deploy("vETH", "vETH", 18)) as ERC20Mock;
    cA = (await (await ethers.getContractFactory("VeilConfidentialWrapper")).deploy(await tokenA.getAddress())) as VeilConfidentialWrapper;
    cB = (await (await ethers.getContractFactory("VeilConfidentialWrapper")).deploy(await tokenB.getAddress())) as VeilConfidentialWrapper;
    cAAddress = await cA.getAddress();
    cBAddress = await cB.getAddress();

    const dummy = await signers.deployer.getAddress();
    const poolKey = {
      currency0: BigInt(await tokenA.getAddress()) < BigInt(await tokenB.getAddress())
        ? await tokenA.getAddress() : await tokenB.getAddress(),
      currency1: BigInt(await tokenA.getAddress()) < BigInt(await tokenB.getAddress())
        ? await tokenB.getAddress() : await tokenA.getAddress(),
      fee: 3000,
      tickSpacing: 60,
      hooks: "0x0000000000000000000000000000000000000000",
    };
    batch = (await (await ethers.getContractFactory("MockBatchSwap")).deploy(
      dummy, dummy, cAAddress, cBAddress, poolKey, 1, 2, await signers.deployer.getAddress(), await signers.reserve.getAddress(),
    )) as MockBatchSwap;
    batchAddress = await batch.getAddress();

    // Fund the mock swap reserve with tokenB and approve the batch contract.
    await (await tokenB.mint(await signers.reserve.getAddress(), WAD * 1_000_000_000_000n)).wait();
    await (await tokenB.connect(signers.reserve).approve(batchAddress, WAD * 1_000_000_000_000n)).wait();
    await (await tokenA.mint(await signers.reserve.getAddress(), WAD * 1_000_000_000_000n)).wait();
    await (await tokenA.connect(signers.reserve).approve(batchAddress, WAD * 1_000_000_000_000n)).wait();
  });

  async function wrap(user: HardhatEthersSigner, token: ERC20Mock, cToken: VeilConfidentialWrapper, amount: bigint) {
    // c-tokens are worth `rate()` underlying each; mint enough so balance == amount.
    const rate = await cToken.rate();
    await (await token.mint(user.address, amount * rate)).wait();
    await (await token.connect(user).approve(await cToken.getAddress(), amount * rate)).wait();
    await (await cToken.connect(user).wrap(user.address, amount * rate)).wait();
  }

  async function deposit(user: HardhatEthersSigner, cToken: VeilConfidentialWrapper, direction: number, amount: bigint) {
    await depositRaw(user, cToken, direction, amount, `0x${direction.toString(16).padStart(2, "0")}`);
  }

  async function depositRaw(user: HardhatEthersSigner, cToken: VeilConfidentialWrapper, direction: number, amount: bigint, data: string) {
    const enc = await fhevm.createEncryptedInput(await cToken.getAddress(), user.address).add64(amount).encrypt();
    await (await cToken.connect(user)[
      "confidentialTransferAndCall(address,bytes32,bytes,bytes)"
    ](batchAddress, enc.handles[0], enc.inputProof, data as `0x${string}`)).wait();
  }

  async function settleTwoPhase(
    roundPre: { aToB: bigint; bToA: bigint },
    expectedNet: bigint,
    minSwapOutput = expectedNet === 0n ? 0n : (expectedNet * 95n) / 100n,
  ) {
    const dec = await fhevm.publicDecrypt([roundPre.aToB, roundPre.bToA]);
    const roundId = (await batch.currentRound()) - 1n;
    await (await batch.prepareSettle(roundId, dec.abiEncodedClearValues, dec.decryptionProof, minSwapOutput)).wait();
    if (expectedNet === 0n) {
      await (await batch.executeSettle(roundId, 0n, "0x")).wait();
      return;
    }
    const prepared = await batch.rounds(roundId);
    const dec2 = await fhevm.publicDecrypt([prepared.unwrapHandle]);
    const cleartext = dec2.clearValues[prepared.unwrapHandle];
    await (
      await batch.executeSettle(roundId, cleartext, dec2.decryptionProof)
    ).wait();
  }

  it("refuses deposits with a wrong or missing direction byte", async function () {
    await wrap(signers.alice, tokenA, cA, WAD);
    const before = await decryptUser(await cA.confidentialBalanceOf(signers.alice.address), cAAddress, signers.alice);
    await depositRaw(signers.alice, cA, DIRECTION_B_TO_A, WAD, "0x");
    const after = await decryptUser(await cA.confidentialBalanceOf(signers.alice.address), cAAddress, signers.alice);
    expect(after).to.equal(before); // refunded, nothing accepted
  });

  it("refunds zero-amount deposits without changing confidential balances", async function () {
    await wrap(signers.alice, tokenA, cA, WAD);
    const before = await decryptUser(await cA.confidentialBalanceOf(signers.alice.address), cAAddress, signers.alice);
    await deposit(signers.alice, cA, DIRECTION_A_TO_B, 0n);
    const after = await decryptUser(await cA.confidentialBalanceOf(signers.alice.address), cAAddress, signers.alice);
    expect(after).to.equal(before);
  });

  it("does not divide by zero when a round contains only zero-value attempts", async function () {
    await wrap(signers.alice, tokenA, cA, WAD);
    await wrap(signers.bob, tokenB, cB, WAD);
    await deposit(signers.alice, cA, DIRECTION_A_TO_B, 0n);
    await deposit(signers.bob, cB, DIRECTION_B_TO_A, 0n);
    await ethers.provider.send("evm_increaseTime", [5]);
    await ethers.provider.send("evm_mine", []);
    await (await batch.closeRound()).wait();
    const round = await batch.rounds(1);
    await settleTwoPhase(round, 0n);
    await expect(batch.connect(signers.alice).withdraw(1, DIRECTION_A_TO_B))
      .to.be.revertedWithCustomError(batch, "NothingDeposited");
  });

  it("accepts the uint64 wrapper-supply limit and rejects minting past it", async function () {
    const max = (1n << 64n) - 1n;
    await wrap(signers.alice, tokenA, cA, max);
    await deposit(signers.alice, cA, DIRECTION_A_TO_B, max);
    const position = await decryptUser(await batch.userDeposits(1, DIRECTION_A_TO_B, signers.alice.address), batchAddress, signers.alice);
    expect(position).to.equal(max);
    const rate = await cA.rate();
    await (await tokenA.mint(signers.alice.address, rate)).wait();
    await (await tokenA.connect(signers.alice).approve(cAAddress, rate)).wait();
    await expect(cA.connect(signers.alice).wrap(signers.alice.address, rate))
      .to.be.revertedWithCustomError(cA, "ERC7984TotalSupplyOverflow");
  });

  it("settles a fully-matched round with zero Uniswap leg", async function () {
    await wrap(signers.alice, tokenA, cA, WAD);
    await wrap(signers.bob, tokenB, cB, WAD);
    await deposit(signers.alice, cA, DIRECTION_A_TO_B, WAD);
    await deposit(signers.bob, cB, DIRECTION_B_TO_A, WAD);

    await ethers.provider.send("evm_increaseTime", [5]);
    await ethers.provider.send("evm_mine", []);
    await (await batch.closeRound()).wait();

    const expectedNet = 0n; // fully matched — no AMM leg
    const roundPre = await batch.rounds(1);
    await settleTwoPhase(roundPre, expectedNet);

    const round = await batch.rounds(1);
    expect(round.matched).to.equal(WAD);
    expect(round.netSwapped).to.equal(0n);
    expect(round.aWasSurplus).to.equal(true);

    // Alice withdraws c-tokenB; Bob withdraws c-tokenA.
    await (await batch.connect(signers.alice).withdraw(1, DIRECTION_A_TO_B)).wait();
    await (await batch.connect(signers.bob).withdraw(1, DIRECTION_B_TO_A)).wait();

    const aliceOut = await decryptUser(await cB.confidentialBalanceOf(signers.alice.address), cBAddress, signers.alice);
    const bobOut = await decryptUser(await cA.confidentialBalanceOf(signers.bob.address), cAAddress, signers.bob);
    expect(aliceOut).to.equal(WAD);
    expect(bobOut).to.equal(WAD);
  });

  it("nets a surplus round through the swap leg", async function () {
    const aIn = WAD + WAD / 2n; // 150
    const bIn = WAD; // 100
    await wrap(signers.alice, tokenA, cA, aIn);
    await wrap(signers.bob, tokenB, cB, bIn);
    await deposit(signers.alice, cA, DIRECTION_A_TO_B, aIn);
    await deposit(signers.bob, cB, DIRECTION_B_TO_A, bIn);

    await ethers.provider.send("evm_increaseTime", [5]);
    await ethers.provider.send("evm_mine", []);
    await (await batch.closeRound()).wait();

    const expectedNet = aIn - bIn; // 1:1 mock pool ⇒ output == input
    const roundPre = await batch.rounds(1);
    await settleTwoPhase(roundPre, expectedNet);

    const round = await batch.rounds(1);
    expect(round.matched).to.equal(bIn);
    expect(round.netSwapped).to.equal(aIn - bIn);
    expect(round.aWasSurplus).to.equal(true);
    expect(round.swapOutput).to.equal(aIn - bIn); // 1:1 mock

    await (await batch.connect(signers.alice).withdraw(1, DIRECTION_A_TO_B)).wait();
    await (await batch.connect(signers.bob).withdraw(1, DIRECTION_B_TO_A)).wait();

    // Alice: 150 × (100 matched + 50 swap) / 150 = 150 c-tokenB
    const aliceOut = await decryptUser(await cB.confidentialBalanceOf(signers.alice.address), cBAddress, signers.alice);
    expect(aliceOut).to.equal(aIn);
    // Bob: 100 × 100 / 100 = 100 c-tokenA
    const bobOut = await decryptUser(await cA.confidentialBalanceOf(signers.bob.address), cAAddress, signers.bob);
    expect(bobOut).to.equal(bIn);
  });

  it("reverts settlement when the swap leg under-delivers (slippage guard)", async function () {
    const aIn = WAD + WAD / 2n;
    const bIn = WAD;
    await wrap(signers.alice, tokenA, cA, aIn);
    await wrap(signers.bob, tokenB, cB, bIn);
    await deposit(signers.alice, cA, DIRECTION_A_TO_B, aIn);
    await deposit(signers.bob, cB, DIRECTION_B_TO_A, bIn);
    await ethers.provider.send("evm_increaseTime", [5]);
    await ethers.provider.send("evm_mine", []);
    await (await batch.closeRound()).wait();
    const roundPre = await batch.rounds(1);
    // The 1:1 mock delivers exactly aIn-bIn; demanding more must revert.
    await expect(settleTwoPhase(roundPre, aIn - bIn, aIn - bIn + 1n)).to.be.revertedWithCustomError(
      batch,
      "SlippageExceeded",
    );
  });

  it("allows only the configured settler to commit a swap minimum", async function () {
    await wrap(signers.alice, tokenA, cA, WAD);
    await wrap(signers.bob, tokenB, cB, WAD / 2n);
    await deposit(signers.alice, cA, DIRECTION_A_TO_B, WAD);
    await deposit(signers.bob, cB, DIRECTION_B_TO_A, WAD / 2n);
    await ethers.provider.send("evm_increaseTime", [5]);
    await ethers.provider.send("evm_mine", []);
    await (await batch.closeRound()).wait();
    const round = await batch.rounds(1);
    const dec = await fhevm.publicDecrypt([round.aToB, round.bToA]);
    await expect(batch.connect(signers.alice).prepareSettle(1, dec.abiEncodedClearValues, dec.decryptionProof, WAD / 3n))
      .to.be.revertedWithCustomError(batch, "NotSettler");
    await expect(batch.prepareSettle(1, dec.abiEncodedClearValues, dec.decryptionProof, 0n))
      .to.be.revertedWithCustomError(batch, "MissingSwapMinimum");
    await (await batch.prepareSettle(1, dec.abiEncodedClearValues, dec.decryptionProof, WAD / 3n)).wait();
    expect((await batch.rounds(1)).minSwapOutput).to.equal(WAD / 3n);
  });

  it("blocks early close and under-threshold close", async function () {
    await wrap(signers.alice, tokenA, cA, WAD);
    await deposit(signers.alice, cA, DIRECTION_A_TO_B, WAD);
    await expect(batch.closeRound()).to.be.revertedWithCustomError(batch, "NotEnoughSubmitters");
  });

  it("lets anyone claim a payout in underlying tokens (withdrawForAndUnwrap)", async function () {
    await wrap(signers.alice, tokenA, cA, WAD);
    await wrap(signers.bob, tokenB, cB, WAD);
    await deposit(signers.alice, cA, DIRECTION_A_TO_B, WAD);
    await deposit(signers.bob, cB, DIRECTION_B_TO_A, WAD);

    await ethers.provider.send("evm_increaseTime", [5]);
    await ethers.provider.send("evm_mine", []);
    await (await batch.closeRound()).wait();
    const roundPre = await batch.rounds(1);
    await settleTwoPhase(roundPre, 0n);

    const aliceUnderlyingBefore = await tokenB.balanceOf(signers.alice.address);
    const bobUnderlyingBefore = await tokenA.balanceOf(signers.bob.address);

    // A third party (the deployer/keeper) claims FOR both depositors — the
    // depositors sign nothing.
    const tx = await (await batch.connect(signers.deployer).withdrawForAndUnwrap(1, DIRECTION_A_TO_B, signers.alice.address)).wait();
    await (await batch.connect(signers.deployer).withdrawForAndUnwrap(1, DIRECTION_B_TO_A, signers.bob.address)).wait();

    // Each claim queued an async unwrap request paying the USER underlying.
    const requested = tx.logs
      .map((l) => { try { return cB.interface.parseLog({ topics: [...l.topics], data: l.data }); } catch { return null; } })
      .find((e) => e?.name === "UnwrapRequested");
    expect(requested, "UnwrapRequested event expected").to.not.be.undefined;
    const handle = (requested as unknown as { args: { amount: string } }).args.amount;
    expect(await cB.unwrapRequester(handle)).to.equal(signers.alice.address);

    // Anyone finalizes the request with the gateway proof → underlying moves.
    const dec = await fhevm.publicDecrypt([handle]);
    await (await cB.connect(signers.bob).finalizeUnwrap(handle, dec.clearValues[handle], dec.decryptionProof)).wait();

    const rate = await cB.rate();
    expect(await tokenB.balanceOf(signers.alice.address)).to.equal(aliceUnderlyingBefore + WAD * rate);
    expect(await cB.confidentialBalanceOf(signers.alice.address)).to.equal(0n); // no c-tokens paid

    // Second claim for the same depositor must fail.
    await expect(batch.connect(signers.deployer).withdrawForAndUnwrap(1, DIRECTION_A_TO_B, signers.alice.address))
      .to.be.revertedWithCustomError(batch, "AlreadyWithdrawn");
    void bobUnderlyingBefore;
  });

  it("blocks double withdrawal", async function () {
    await wrap(signers.alice, tokenA, cA, WAD);
    await wrap(signers.bob, tokenB, cB, WAD);
    await deposit(signers.alice, cA, DIRECTION_A_TO_B, WAD);
    await deposit(signers.bob, cB, DIRECTION_B_TO_A, WAD);
    await ethers.provider.send("evm_increaseTime", [5]);
    await ethers.provider.send("evm_mine", []);
    await (await batch.closeRound()).wait();
    const expectedNet = 0n;
    const roundPre = await batch.rounds(1);
    await settleTwoPhase(roundPre, expectedNet);
    await (await batch.connect(signers.alice).withdraw(1, DIRECTION_A_TO_B)).wait();
    await expect(batch.connect(signers.alice).withdraw(1, DIRECTION_A_TO_B)).to.be.revertedWithCustomError(batch, "AlreadyWithdrawn");
  });
});
