import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import { expect } from "chai";
import { parseUnits } from "ethers";

import { ERC20Mock, MockBatchSwap, VeilConfidentialWrapper } from "../types";

type Signers = { deployer: HardhatEthersSigner; alice: HardhatEthersSigner; bob: HardhatEthersSigner; reserve: HardhatEthersSigner };

const DIR_A_TO_B = 1;
const DIR_B_TO_A = 2;
const WAD = parseUnits("1", 18);

async function decryptUser(handle: unknown, contract: string, user: HardhatEthersSigner): Promise<bigint> {
  return fhevm.userDecryptEuint(FhevmType.euint64, handle as string, contract, user);
}

describe("VeilBatchSwap v3 (confidential orders)", function () {
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

    // 1:1 mock swap reserve.
    await (await tokenB.mint(await signers.reserve.getAddress(), WAD * 1_000_000_000_000n)).wait();
    await (await tokenB.connect(signers.reserve).approve(batchAddress, WAD * 1_000_000_000_000n)).wait();
    await (await tokenA.mint(await signers.reserve.getAddress(), WAD * 1_000_000_000_000n)).wait();
    await (await tokenA.connect(signers.reserve).approve(batchAddress, WAD * 1_000_000_000_000n)).wait();
  });

  async function wrap(user: HardhatEthersSigner, token: ERC20Mock, cToken: VeilConfidentialWrapper, amount: bigint) {
    const rate = await cToken.rate();
    await (await token.mint(user.address, amount * rate)).wait();
    await (await token.connect(user).approve(await cToken.getAddress(), amount * rate)).wait();
    await (await cToken.connect(user).wrap(user.address, amount * rate)).wait();
  }

  /** Fund the confidential vault balance (public funding leg, data 0x00). */
  async function fund(user: HardhatEthersSigner, cToken: VeilConfidentialWrapper, amount: bigint) {
    const enc = await fhevm.createEncryptedInput(await cToken.getAddress(), user.address).add64(amount).encrypt();
    await (await cToken.connect(user)[
      "confidentialTransferAndCall(address,bytes32,bytes,bytes)"
    ](batchAddress, enc.handles[0], enc.inputProof, "0x00")).wait();
  }

  /** Submit an order with ENCRYPTED direction and amount (one input, one proof). */
  async function order(user: HardhatEthersSigner, direction: number, amount: bigint) {
    const enc = await fhevm.createEncryptedInput(batchAddress, user.address).add64(amount).add8(direction).encrypt();
    await (await batch.connect(user).submitOrder(enc.handles[0], enc.inputProof, enc.handles[1], enc.inputProof)).wait();
  }

  async function fundedBalance(user: HardhatEthersSigner, asset: number): Promise<bigint> {
    const handle = await batch.fundedBalance(user.address, asset);
    if (handle === 0n) return 0n;
    return decryptUser(handle, batchAddress, user);
  }

  /** Close, decrypt ONLY (net, surplus), prepare, execute, credit both. */
  async function settleAndCredit() {
    const roundId = await batch.currentRound(); // the round being closed
    await (await batch.closeRound()).wait();
    const round = await batch.rounds(roundId);
    const dec = await fhevm.publicDecrypt([round.netEnc, round.surplusEnc]);
    const net = dec.clearValues[round.netEnc];
    const surplus = dec.clearValues[round.surplusEnc];
    await (await batch.prepareSettle(roundId, dec.abiEncodedClearValues, dec.decryptionProof)).wait();
    if (net > 0n) {
      const prepared = await batch.rounds(roundId);
      const dec2 = await fhevm.publicDecrypt([prepared.unwrapHandle]);
      const cleartext = dec2.clearValues[prepared.unwrapHandle];
      await (await batch.executeSettle(roundId, cleartext, dec2.decryptionProof)).wait();
    } else {
      await (await batch.executeSettle(roundId, 0n, "0x")).wait();
    }
    void surplus;
    for (const u of [signers.alice, signers.bob]) {
      await (await batch.creditOrder(roundId, u.address)).wait();
    }
    return roundId;
  }

  it("funding credits an encrypted balance the user can decrypt", async function () {
    await wrap(signers.alice, tokenA, cA, 10n * 10n ** 6n);
    await fund(signers.alice, cA, 10n * 10n ** 6n);
    expect(await fundedBalance(signers.alice, 0)).to.equal(10n * 10n ** 6n);
    expect(await fundedBalance(signers.alice, 1)).to.equal(0n);
  });

  it("order events carry no direction or amount", async function () {
    await wrap(signers.alice, tokenA, cA, 5n * 10n ** 6n);
    await fund(signers.alice, cA, 5n * 10n ** 6n);
    await (await batch.connect(signers.alice).submitOrder(
      ...(await orderArgs(signers.alice, DIR_A_TO_B, 5n * 10n ** 6n)),
    )).wait();
    const events = await batch.queryFilter(batch.filters.OrderSubmitted());
    expect(events.length).to.equal(1);
    expect(events[0].fragment.inputs.map((i) => i.name).sort()).to.deep.equal(["round", "user"]);
  });

  async function orderArgs(user: HardhatEthersSigner, direction: number, amount: bigint): Promise<[string, string, string, string]> {
    const enc = await fhevm.createEncryptedInput(batchAddress, user.address).add64(amount).add8(direction).encrypt();
    return [enc.handles[0], enc.inputProof, enc.handles[1], enc.inputProof];
  }

  it("encrypted direction debits the correct funded side", async function () {
    await wrap(signers.alice, tokenA, cA, 5n * 10n ** 6n);
    await fund(signers.alice, cA, 5n * 10n ** 6n);
    await (await batch.connect(signers.alice).submitOrder(
      ...(await orderArgs(signers.alice, DIR_A_TO_B, 3n * 10n ** 6n)),
    )).wait();
    expect(await fundedBalance(signers.alice, 0)).to.equal(2n * 10n ** 6n);
    expect(await fundedBalance(signers.alice, 1)).to.equal(0n);
  });

  it("underfunded orders are silently zeroed, balances preserved", async function () {
    await wrap(signers.alice, tokenA, cA, 3n * 10n ** 6n);
    await fund(signers.alice, cA, 3n * 10n ** 6n);
    await (await batch.connect(signers.alice).submitOrder(
      ...(await orderArgs(signers.alice, DIR_A_TO_B, 5n * 10n ** 6n)),
    )).wait();
    expect(await fundedBalance(signers.alice, 0)).to.equal(3n * 10n ** 6n);
    // The zeroed order still participates but matches nothing.
    await wrap(signers.bob, tokenB, cB, 4n * 10n ** 6n);
    await fund(signers.bob, cB, 4n * 10n ** 6n);
    await (await batch.connect(signers.bob).submitOrder(
      ...(await orderArgs(signers.bob, DIR_B_TO_A, 4n * 10n ** 6n)),
    )).wait();
    const roundId = await settleAndCredit();
    expect(await fundedBalance(signers.alice, 1)).to.equal(0n);
    expect(await fundedBalance(signers.bob, 0)).to.equal(4n * 10n ** 6n); // fully matched 1:1
    void roundId;
  });

  it("two-sided round: matched 1:1, surplus share via public net, credited confidentially", async function () {
    await wrap(signers.alice, tokenA, cA, 5n * 10n ** 6n);
    await fund(signers.alice, cA, 5n * 10n ** 6n);
    await wrap(signers.bob, tokenB, cB, 3n * 10n ** 6n);
    await fund(signers.bob, cB, 3n * 10n ** 6n);
    await order(signers.alice, DIR_A_TO_B, 5n * 10n ** 6n);
    await order(signers.bob, DIR_B_TO_A, 3n * 10n ** 6n);

    await settleAndCredit();

    // 1:1 mock swap: alice (surplus, sold 5) gets 3 matched + 2 residual → 5 cB.
    // bob (deficit, sold 3) gets 3 matched → 3 cA.
    expect(await fundedBalance(signers.alice, 1)).to.equal(5n * 10n ** 6n);
    expect(await fundedBalance(signers.alice, 0)).to.equal(0n);
    expect(await fundedBalance(signers.bob, 0)).to.equal(3n * 10n ** 6n);
    expect(await fundedBalance(signers.bob, 1)).to.equal(0n);
  });

  it("fully matched round pays both sides 1:1 with no swap leg", async function () {
    await wrap(signers.alice, tokenA, cA, 4n * 10n ** 6n);
    await fund(signers.alice, cA, 4n * 10n ** 6n);
    await wrap(signers.bob, tokenB, cB, 4n * 10n ** 6n);
    await fund(signers.bob, cB, 4n * 10n ** 6n);
    await order(signers.alice, DIR_A_TO_B, 4n * 10n ** 6n);
    await order(signers.bob, DIR_B_TO_A, 4n * 10n ** 6n);
    await settleAndCredit();
    expect(await fundedBalance(signers.alice, 1)).to.equal(4n * 10n ** 6n);
    expect(await fundedBalance(signers.bob, 0)).to.equal(4n * 10n ** 6n);
  });

  it("creditOrder is permissionless but single-credit", async function () {
    await wrap(signers.alice, tokenA, cA, 4n * 10n ** 6n);
    await fund(signers.alice, cA, 4n * 10n ** 6n);
    await wrap(signers.bob, tokenB, cB, 4n * 10n ** 6n);
    await fund(signers.bob, cB, 4n * 10n ** 6n);
    await order(signers.alice, DIR_A_TO_B, 4n * 10n ** 6n);
    await order(signers.bob, DIR_B_TO_A, 4n * 10n ** 6n);
    const roundId = await settleAndCredit();
    await expect(batch.creditOrder(roundId, signers.alice.address)).to.be.revertedWithCustomError(batch, "AlreadyCredited");
    expect(await fundedBalance(signers.alice, 1)).to.equal(4n * 10n ** 6n);
  });

  it("exit unwraps the funded balance to plain tokens (public leg by design)", async function () {
    await wrap(signers.alice, tokenA, cA, 6n * 10n ** 6n);
    await fund(signers.alice, cA, 6n * 10n ** 6n);
    const rate = await cA.rate();
    const before = await tokenA.balanceOf(signers.alice.address);
    const enc = await fhevm.createEncryptedInput(batchAddress, signers.alice.address).add64(2n * 10n ** 6n).encrypt();
    await (await batch.connect(signers.alice).exit(0, enc.handles[0], enc.inputProof)).wait();
    // async unwrap: finalize the pending request
    const wAbi = ["event UnwrapRequested(address indexed receiver, bytes32 amount)"];
    const w = new ethers.Contract(cAAddress, wAbi, signers.alice);
    const reqs = await w.queryFilter(w.filters.UnwrapRequested());
    expect(reqs.length).to.equal(1);
    const handle = (reqs[0].args as unknown as { amount: string }).amount;
    const dec = await fhevm.publicDecrypt([handle]);
    await (await cA.finalizeUnwrap(handle, dec.clearValues[handle], dec.decryptionProof)).wait();
    expect(await tokenA.balanceOf(signers.alice.address)).to.equal(before + 2n * 10n ** 6n * rate);
    expect(await fundedBalance(signers.alice, 0)).to.equal(4n * 10n ** 6n);
  });

  it("one order per user per round", async function () {
    await wrap(signers.alice, tokenA, cA, 5n * 10n ** 6n);
    await fund(signers.alice, cA, 5n * 10n ** 6n);
    await order(signers.alice, DIR_A_TO_B, 1n * 10n ** 6n);
    await expect(order(signers.alice, DIR_A_TO_B, 1n * 10n ** 6n)).to.be.revertedWithCustomError(batch, "OrderAlreadySubmitted");
  });
});
