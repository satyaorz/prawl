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
  let oracle: any;
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
    oracle = await (await ethers.getContractFactory("MockLotPriceOracle")).deploy(1, 1);
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
      dummy, dummy, cAAddress, cBAddress, poolKey, 1, 2, 3600, await signers.reserve.getAddress(), await oracle.getAddress(), 86400,
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
  async function order(user: HardhatEthersSigner, direction: number, amount: bigint, minOutput = 0n) {
    const enc = await fhevm.createEncryptedInput(batchAddress, user.address).add64(amount).add8(direction).add64(minOutput).encrypt();
    await (await batch.connect(user).submitOrder(enc.handles[0], enc.inputProof, enc.handles[1], enc.inputProof, enc.handles[2], enc.inputProof)).wait();
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
    // Settlement proof verification permits any caller, including an orderer.
    await (await batch.connect(signers.bob).prepareSettle(roundId, dec.abiEncodedClearValues, dec.decryptionProof)).wait();
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

  async function orderArgs(user: HardhatEthersSigner, direction: number, amount: bigint): Promise<[string, string, string, string, string, string]> {
    const enc = await fhevm.createEncryptedInput(batchAddress, user.address).add64(amount).add8(direction).add64(0n).encrypt();
    return [enc.handles[0], enc.inputProof, enc.handles[1], enc.inputProof, enc.handles[2], enc.inputProof];
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

  it("credits large residual shares without overflowing the encrypted product", async function () {
    // 6e9 * 1e10 exceeds uint64 even though each operand and the
    // final shares fit comfortably. The old uint64 multiply lost value.
    const aliceAmount = 6_000n * 10n ** 6n;
    const bobAmount = 4_000n * 10n ** 6n;
    await wrap(signers.alice, tokenA, cA, aliceAmount);
    await fund(signers.alice, cA, aliceAmount);
    await wrap(signers.bob, tokenA, cA, bobAmount);
    await fund(signers.bob, cA, bobAmount);
    await order(signers.alice, DIR_A_TO_B, aliceAmount);
    await order(signers.bob, DIR_A_TO_B, bobAmount);
    await settleAndCredit();
    expect(await fundedBalance(signers.alice, 1)).to.equal(aliceAmount);
    expect(await fundedBalance(signers.bob, 1)).to.equal(bobAmount);
  });

  it("matches and settles at a non-parity lot price without mixing token units", async function () {
    await (await oracle.setPrice(2, 5, (await ethers.provider.getBlock("latest"))!.timestamp)).wait();

    // Alice sells 5 lots (10 A); Bob sells 3 lots (15 B).
    // Three lots match internally; the remaining two use the mock swap.
    await wrap(signers.alice, tokenA, cA, 10n);
    await fund(signers.alice, cA, 10n);
    await wrap(signers.bob, tokenB, cB, 15n);
    await fund(signers.bob, cB, 15n);
    await order(signers.alice, DIR_A_TO_B, 10n);
    await order(signers.bob, DIR_B_TO_A, 15n);
    await settleAndCredit();
    expect(await fundedBalance(signers.alice, 1)).to.equal(25n);
    expect(await fundedBalance(signers.bob, 0)).to.equal(6n);
  });

  it("does not debit an order that is not a whole lot", async function () {
    await (await oracle.setPrice(2, 5, (await ethers.provider.getBlock("latest"))!.timestamp)).wait();
    await wrap(signers.alice, tokenA, cA, 3n);
    await fund(signers.alice, cA, 3n);
    await order(signers.alice, DIR_A_TO_B, 3n);
    expect(await fundedBalance(signers.alice, 0)).to.equal(3n);
  });

  it("does not debit an order whose encrypted minimum exceeds its guaranteed floor", async function () {
    const amount = 10n * 10n ** 6n;
    await wrap(signers.alice, tokenA, cA, amount);
    await fund(signers.alice, cA, amount);
    await order(signers.alice, DIR_A_TO_B, amount, 97n * 10n ** 5n + 1n); // one unit above the 97% floor
    expect(await fundedBalance(signers.alice, 0)).to.equal(amount);
  });

  it("snapshots the oracle quote for the entire round", async function () {
    const amount = 10n * 10n ** 6n;
    await wrap(signers.alice, tokenA, cA, amount);
    await fund(signers.alice, cA, amount);
    await wrap(signers.bob, tokenB, cB, amount);
    await fund(signers.bob, cB, amount);
    await order(signers.alice, DIR_A_TO_B, amount);
    await (await oracle.setPrice(1, 2, (await ethers.provider.getBlock("latest"))!.timestamp)).wait();
    await order(signers.bob, DIR_B_TO_A, amount);
    const price = await batch.roundPrices(1);
    expect(price.lotA).to.equal(1n);
    expect(price.lotB).to.equal(1n);
    await settleAndCredit();
    expect(await fundedBalance(signers.alice, 1)).to.equal(amount);
    expect(await fundedBalance(signers.bob, 0)).to.equal(amount);
  });

  it("rejects stale oracle prices without debiting the user", async function () {
    const amount = 10n * 10n ** 6n;
    await wrap(signers.alice, tokenA, cA, amount);
    await fund(signers.alice, cA, amount);
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    await (await oracle.setPrice(1, 1, now - 86401)).wait();
    await expect(order(signers.alice, DIR_A_TO_B, amount)).to.be.revertedWithCustomError(batch, "StaleOraclePrice");
    expect(await fundedBalance(signers.alice, 0)).to.equal(amount);
  });

  it("prevents settlement at an expired snapshot and permits refund", async function () {
    const amount = 10n * 10n ** 6n;
    await wrap(signers.alice, tokenA, cA, amount);
    await fund(signers.alice, cA, amount);
    await wrap(signers.bob, tokenB, cB, amount);
    await fund(signers.bob, cB, amount);
    await order(signers.alice, DIR_A_TO_B, amount);
    await order(signers.bob, DIR_B_TO_A, amount);
    await ethers.provider.send("evm_increaseTime", [86401]);
    await ethers.provider.send("evm_mine", []);
    await expect(batch.closeRound()).to.be.revertedWithCustomError(batch, "StaleOraclePrice");
    await (await batch.expireRound(1, 0, "0x")).wait();
    await (await batch.refundOrder(1, signers.alice.address)).wait();
    await (await batch.refundOrder(1, signers.bob.address)).wait();
    expect(await fundedBalance(signers.alice, 0)).to.equal(amount);
    expect(await fundedBalance(signers.bob, 1)).to.equal(amount);
  });

  it("meets accepted minimums when the residual executes at the aggregate floor", async function () {
    const amount = 10n * 10n ** 6n;
    for (const user of [signers.alice, signers.bob]) {
      await wrap(user, tokenA, cA, amount);
      await fund(user, cA, amount);
      await order(user, DIR_A_TO_B, amount, 97n * 10n ** 5n); // exactly the 97% floor
    }
    await (await batch.setOutputBps(9700)).wait();
    await settleAndCredit();
    expect(await fundedBalance(signers.alice, 1)).to.equal(97n * 10n ** 5n);
    expect(await fundedBalance(signers.bob, 1)).to.equal(97n * 10n ** 5n);
  });

  /** Two same-direction orders leave a net residual, so settlement burns a residual for unwrap. */
  async function prepareOneSidedRound(amount: bigint) {
    await wrap(signers.alice, tokenA, cA, amount);
    await fund(signers.alice, cA, amount);
    await wrap(signers.bob, tokenA, cA, amount);
    await fund(signers.bob, cA, amount);
    await order(signers.alice, DIR_A_TO_B, amount);
    await order(signers.bob, DIR_A_TO_B, amount);
    await (await batch.closeRound()).wait();
    const closed = await batch.rounds(1);
    const roundProof = await fhevm.publicDecrypt([closed.netEnc, closed.surplusEnc]);
    await (await batch.prepareSettle(1, roundProof.abiEncodedClearValues, roundProof.decryptionProof)).wait();
    const prepared = await batch.rounds(1);
    const unwrapProof = await fhevm.publicDecrypt([prepared.unwrapHandle]);
    return { prepared, cleartext: unwrapProof.clearValues[prepared.unwrapHandle] as bigint, proof: unwrapProof.decryptionProof };
  }

  it("settles even if a third party finalized the unwrap first", async function () {
    const amount = 5n * 10n ** 6n;
    const { prepared, cleartext, proof } = await prepareOneSidedRound(amount);
    // finalizeUnwrap is permissionless and works only once. Someone doing it
    // early must not lock the round.
    await (await cA.connect(signers.bob).finalizeUnwrap(prepared.unwrapHandle, cleartext, proof)).wait();
    await (await batch.executeSettle(1, cleartext, proof)).wait();
    expect((await batch.rounds(1)).executed).to.equal(true);
    for (const u of [signers.alice, signers.bob]) await (await batch.creditOrder(1, u.address)).wait();
    expect(await fundedBalance(signers.alice, 1)).to.equal(amount);
    expect(await fundedBalance(signers.bob, 1)).to.equal(amount);
  });

  it("refunds even if a third party finalized the unwrap first", async function () {
    const amount = 5n * 10n ** 6n;
    const { prepared, cleartext, proof } = await prepareOneSidedRound(amount);
    await (await cA.connect(signers.bob).finalizeUnwrap(prepared.unwrapHandle, cleartext, proof)).wait();
    await ethers.provider.send("evm_increaseTime", [3601]);
    await ethers.provider.send("evm_mine", []);
    await (await batch.expireRound(1, cleartext, proof)).wait();
    await (await batch.refundOrder(1, signers.alice.address)).wait();
    await (await batch.refundOrder(1, signers.bob.address)).wait();
    expect(await fundedBalance(signers.alice, 0)).to.equal(amount);
    expect(await fundedBalance(signers.bob, 0)).to.equal(amount);
  });

  it("refuses to settle when the pool price moved after the snapshot", async function () {
    const now = async () => (await ethers.provider.getBlock("latest"))!.timestamp;
    await (await oracle.setPrice(100, 100, await now())).wait();
    const amount = 10n * 10n ** 6n; // a multiple of both lots
    const { prepared, cleartext, proof } = await prepareOneSidedRound(amount);
    // 3% away from the snapshot: over the 2% bound.
    await (await oracle.setPrice(100, 103, await now())).wait();
    await expect(batch.executeSettle(1, cleartext, proof)).to.be.revertedWithCustomError(batch, "PriceMovedSinceSnapshot");
    // Back within the bound (1%): settles.
    await (await oracle.setPrice(100, 101, await now())).wait();
    await (await batch.executeSettle(1, cleartext, proof)).wait();
    expect((await batch.rounds(1)).executed).to.equal(true);
    void prepared;
  });

  it("does not burn the residual for unwrap when the price already moved", async function () {
    const now = async () => (await ethers.provider.getBlock("latest"))!.timestamp;
    await (await oracle.setPrice(100, 100, await now())).wait();
    const amount = 10n * 10n ** 6n;
    for (const u of [signers.alice, signers.bob]) {
      await wrap(u, tokenA, cA, amount);
      await fund(u, cA, amount);
      await order(u, DIR_A_TO_B, amount);
    }
    await (await batch.closeRound()).wait();
    const closed = await batch.rounds(1);
    const roundProof = await fhevm.publicDecrypt([closed.netEnc, closed.surplusEnc]);
    await (await oracle.setPrice(100, 90, await now())).wait();
    await expect(batch.prepareSettle(1, roundProof.abiEncodedClearValues, roundProof.decryptionProof)).to.be.revertedWithCustomError(batch, "PriceMovedSinceSnapshot");
    expect((await batch.rounds(1)).prepared).to.equal(false);
  });

  it("expires an unfilled open round and refunds without a keeper", async function () {
    const amount = 5n * 10n ** 6n;
    await wrap(signers.alice, tokenA, cA, amount);
    await fund(signers.alice, cA, amount);
    await order(signers.alice, DIR_A_TO_B, amount);
    await expect(batch.expireRound(1, 0, "0x")).to.be.revertedWithCustomError(batch, "RefundTooEarly");
    await ethers.provider.send("evm_increaseTime", [3601]);
    await ethers.provider.send("evm_mine", []);
    await (await batch.connect(signers.bob).expireRound(1, 0, "0x")).wait();
    expect(await batch.currentRound()).to.equal(2n);
    await (await batch.connect(signers.bob).refundOrder(1, signers.alice.address)).wait();
    expect(await fundedBalance(signers.alice, 0)).to.equal(amount);
    await expect(batch.refundOrder(1, signers.alice.address)).to.be.revertedWithCustomError(batch, "AlreadyRefunded");
  });

  it("rewraps a prepared residual before refunding and preserves exit backing", async function () {
    const amount = 5n * 10n ** 6n;
    await wrap(signers.alice, tokenA, cA, amount);
    await fund(signers.alice, cA, amount);
    await wrap(signers.bob, tokenA, cA, amount);
    await fund(signers.bob, cA, amount);
    await order(signers.alice, DIR_A_TO_B, amount);
    await order(signers.bob, DIR_A_TO_B, amount);
    await (await batch.closeRound()).wait();
    const closed = await batch.rounds(1);
    const roundProof = await fhevm.publicDecrypt([closed.netEnc, closed.surplusEnc]);
    await (await batch.prepareSettle(1, roundProof.abiEncodedClearValues, roundProof.decryptionProof)).wait();
    const prepared = await batch.rounds(1);
    const unwrapProof = await fhevm.publicDecrypt([prepared.unwrapHandle]);
    await ethers.provider.send("evm_increaseTime", [3601]);
    await ethers.provider.send("evm_mine", []);
    await (await batch.expireRound(1, unwrapProof.clearValues[prepared.unwrapHandle], unwrapProof.decryptionProof)).wait();
    await (await batch.refundOrder(1, signers.alice.address)).wait();
    await (await batch.refundOrder(1, signers.bob.address)).wait();
    expect(await fundedBalance(signers.alice, 0)).to.equal(amount);
    expect(await fundedBalance(signers.bob, 0)).to.equal(amount);
    await expect(batch.executeSettle(1, 0, "0x")).to.be.revertedWithCustomError(batch, "RoundAlreadySettled");

    const exit = await fhevm.createEncryptedInput(batchAddress, signers.alice.address).add64(amount).encrypt();
    await (await batch.connect(signers.alice).exit(0, exit.handles[0], exit.inputProof)).wait();
    const events = await cA.queryFilter(cA.filters.UnwrapRequested(signers.alice.address));
    const handle = events.at(-1)!.args[1];
    const finalProof = await fhevm.publicDecrypt([handle]);
    await (await cA.finalizeUnwrap(handle, finalProof.clearValues[handle], finalProof.decryptionProof)).wait();
    expect(await tokenA.balanceOf(signers.alice.address)).to.equal(amount * await cA.rate());
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
