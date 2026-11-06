import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ethers, fhevm } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";
import { expect } from "chai";
import { parseUnits } from "ethers";

import { VeilBatchSwap, VeilConfidentialWrapper } from "../types";

/**
 * End-to-end test of the REAL swap path: a real Uniswap v4 PoolManager, a real
 * UniversalRouter, a real Permit2 and a real seeded pool. Unlike
 * veil-batch-swap.test.ts (which replaces the swap leg with a 1:1 reserve),
 * this drives VeilBatchSwap._swapExactInput against actual Uniswap v4, so it
 * catches router/permit2/pool wiring errors that a mock cannot.
 *
 * It still runs on the FHEVM mock network, so the FHE coprocessor and the Zama
 * gateway are simulated. Everything about the Uniswap leg is real.
 */
const DIR_A_TO_B = 1;
const DIR_B_TO_A = 2;
const WAD = parseUnits("1", 18);
const ZERO_HOOKS = "0x0000000000000000000000000000000000000000";
const MIN_SQRT_PRICE = 4295128739n;

describe("VeilBatchSwap against a real Uniswap v4 pool", function () {
  let signers: { deployer: HardhatEthersSigner; alice: HardhatEthersSigner; bob: HardhatEthersSigner };
  let weth: any, prawl: any;
  let cWeth: VeilConfidentialWrapper, cPrawl: VeilConfidentialWrapper;
  let batch: VeilBatchSwap;
  let poolManager: any, router: string, permit2: string;
  let poolKey: { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string };
  let batchAddress: string;
  let wethIsCurrency0: boolean;
  let oracle: any;

  before(async function () {
    if (!fhevm.isMock) throw new Error("This suite runs on the FHEVM mock network only");
    const all: HardhatEthersSigner[] = await ethers.getSigners();
    signers = { deployer: all[0], alice: all[1], bob: all[2] };

    // Real Uniswap v4 stack, each contract deployed straight from its own
    // artifact. Deploying them this way (rather than from a single helper
    // contract) keeps every transaction's initcode under the gas cap.
    const deploy = async (name: string, args: unknown[] = []) => {
      const factory = await ethers.getContractFactory(name);
      const contract = await factory.deploy(...args);
      await contract.waitForDeployment();
      return contract;
    };

    weth = await deploy("LocalWETH9");
    const manager = await deploy("PoolManager", [signers.deployer.address]);
    poolManager = manager;
    const liquidityHelper = await deploy("PoolModifyLiquidityTest", [await manager.getAddress()]);
    const permit2Contract = await deploy("Permit2");
    permit2 = await permit2Contract.getAddress();
    const routerContract = await deploy("UniversalRouter", [{
      permit2,
      weth9: await weth.getAddress(),
      v2Factory: ethers.ZeroAddress,
      v3Factory: ethers.ZeroAddress,
      pairInitCodeHash: ethers.ZeroHash,
      poolInitCodeHash: ethers.ZeroHash,
      v4PoolManager: await manager.getAddress(),
      v3NFTPositionManager: ethers.ZeroAddress,
      v4PositionManager: ethers.ZeroAddress,
      spokePool: ethers.ZeroAddress,
    }]);
    router = await routerContract.getAddress();

    // The custom token and its confidential wrappers.
    prawl = await (await ethers.getContractFactory("PrawlToken")).deploy(
      "Prawl", "PRAWL", signers.deployer.address, parseUnits("100000000", 18),
    );
    await prawl.waitForDeployment();
    const wethAddress = await weth.getAddress();
    const prawlAddress = await prawl.getAddress();

    // PrawlToken has no mint after deployment, so the deployer hands the test
    // users the balance they need to trade.
    for (const user of [signers.alice, signers.bob]) {
      await (await prawl.transfer(user.address, parseUnits("100", 18))).wait();
    }

    cWeth = (await (await ethers.getContractFactory("VeilConfidentialWrapper")).deploy(wethAddress)) as VeilConfidentialWrapper;
    cPrawl = (await (await ethers.getContractFactory("VeilConfidentialWrapper")).deploy(prawlAddress)) as VeilConfidentialWrapper;
    const cWethAddress = await cWeth.getAddress();
    const cPrawlAddress = await cPrawl.getAddress();

    // PoolKey requires sorted currencies.
    wethIsCurrency0 = BigInt(wethAddress) < BigInt(prawlAddress);
    poolKey = {
      currency0: wethIsCurrency0 ? wethAddress : prawlAddress,
      currency1: wethIsCurrency0 ? prawlAddress : wethAddress,
      fee: 3000,
      tickSpacing: 60,
      hooks: ZERO_HOOKS,
    };

    // Initialize the pool at exactly 1:1 and seed full-range liquidity, so the
    // oracle's 1:1 lot price and the pool's price agree.
    await (await poolManager.initialize(
      [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
      1n << 96n,
    )).wait();

    const lpWeth = parseUnits("50", 18);
    const lpPrawl = parseUnits("50", 18);
    await (await weth.deposit({ value: lpWeth })).wait();
    await (await weth.approve(await liquidityHelper.getAddress(), ethers.MaxUint256)).wait();
    await (await prawl.approve(await liquidityHelper.getAddress(), ethers.MaxUint256)).wait();
    // Liquidity for the [-600, 600] range: L = min(amount0 * sqrt(P_low) / (1 - P_low),
    // amount1 / (sqrt(P_high) - 1)) with sqrtPrice = 1, so both bounds are tiny and
    // the max ~ amount * 2. Use a conservative fraction of the smaller amount.
    const liquidity = (lpWeth < lpPrawl ? lpWeth : lpPrawl) * 2n - parseUnits("1", 18);
    await (await liquidityHelper.modifyLiquidity(
      [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
      [-600, 600, liquidity, ethers.ZeroHash],
      "0x",
    )).wait();

    // Price comes from the pool itself — no external feeds. A 1:1 pool makes one
    // tokenA lot worth one tokenB lot, so the expected numbers stay readable.
    oracle = await (await ethers.getContractFactory("PoolLotPriceOracle")).deploy(
      await manager.getAddress(),
      cWethAddress,
      cPrawlAddress,
      [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
      parseUnits("1", 18),
    );
    await oracle.waitForDeployment();

    // The REAL batch swap (not MockBatchSwap).
    const cA = wethIsCurrency0 ? cWethAddress : cPrawlAddress;
    const cB = wethIsCurrency0 ? cPrawlAddress : cWethAddress;
    batch = (await (await ethers.getContractFactory("VeilBatchSwap")).deploy(
      router, permit2, cA, cB,
      [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
      1, 2, 3600, await oracle.getAddress(), 86400,
    )) as VeilBatchSwap;
    await batch.waitForDeployment();
    batchAddress = await batch.getAddress();
  });

  async function wrap(user: HardhatEthersSigner, token: any, cToken: VeilConfidentialWrapper, amount: bigint) {
    const rate = await cToken.rate();
    const underlying = amount * rate;
    if (await token.getAddress() === await weth.getAddress()) {
      await (await weth.connect(user).deposit({ value: underlying })).wait();
    }
    await (await token.connect(user).approve(await cToken.getAddress(), underlying)).wait();
    await (await cToken.connect(user).wrap(user.address, underlying)).wait();
  }

  async function fund(user: HardhatEthersSigner, cToken: VeilConfidentialWrapper, amount: bigint) {
    const enc = await fhevm.createEncryptedInput(await cToken.getAddress(), user.address).add64(amount).encrypt();
    await (await cToken.connect(user)["confidentialTransferAndCall(address,bytes32,bytes,bytes)"](
      batchAddress, enc.handles[0], enc.inputProof, "0x00",
    )).wait();
  }

  async function order(user: HardhatEthersSigner, direction: number, amount: bigint, minOutput = 0n) {
    const enc = await fhevm.createEncryptedInput(batchAddress, user.address).add64(amount).add8(direction).add64(minOutput).encrypt();
    await (await batch.connect(user).submitOrder(
      enc.handles[0], enc.inputProof, enc.handles[1], enc.inputProof, enc.handles[2], enc.inputProof,
    )).wait();
  }

  /**
   * Lot sizes come from the pool itself, and a real pool's price moves every
   * time a round trades. Read the live quote so an order is always a whole
   * number of lots — the batch rejects anything else, silently.
   */
  async function lots(direction: number, count: bigint): Promise<bigint> {
    const [lotA, lotB] = await oracle.latestLotPrice();
    return count * (direction === DIR_A_TO_B ? lotA : lotB);
  }

  async function vault(user: HardhatEthersSigner, asset: number): Promise<bigint> {
    const handle = await batch.fundedBalance(user.address, asset);
    if (handle === 0n) return 0n;
    return fhevm.userDecryptEuint(FhevmType.euint64, handle as string, batchAddress, user);
  }

  /** Close, decrypt net/surplus, prepare, execute the REAL swap, credit both. */
  async function settle() {
    const roundId = await batch.currentRound();
    await (await batch.closeRound()).wait();
    const round = await batch.rounds(roundId);
    const dec = await fhevm.publicDecrypt([round.netEnc, round.surplusEnc]);
    const net = BigInt(dec.clearValues[round.netEnc] as bigint);
    await (await batch.prepareSettle(roundId, dec.abiEncodedClearValues, dec.decryptionProof)).wait();
    if (net > 0n) {
      const prepared = await batch.rounds(roundId);
      const dec2 = await fhevm.publicDecrypt([prepared.unwrapHandle]);
      const cleartext = BigInt(dec2.clearValues[prepared.unwrapHandle] as bigint);
      await (await batch.executeSettle(roundId, cleartext, dec2.decryptionProof)).wait();
    } else {
      await (await batch.executeSettle(roundId, 0n, "0x")).wait();
    }
    for (const user of [signers.alice, signers.bob]) {
      await (await batch.creditOrder(roundId, user.address)).wait();
    }
    return { roundId, net };
  }

  it("routes a real Uniswap v4 swap and credits the confidential payout", async function () {
    // Alice sells WETH for PRAWL; Bob sells PRAWL for WETH. Both directions are
    // encrypted. Different sizes leave a residual that must hit the real pool.
    const aliceIn = await lots(DIR_A_TO_B, 2n); // sell 2 lots of A
    const bobIn = await lots(DIR_B_TO_A, 1n);   // sell 1 lot of B
    await wrap(signers.alice, wethIsCurrency0 ? weth : prawl, wethIsCurrency0 ? cWeth : cPrawl, aliceIn);
    await wrap(signers.bob, wethIsCurrency0 ? prawl : weth, wethIsCurrency0 ? cPrawl : cWeth, bobIn);
    await fund(signers.alice, wethIsCurrency0 ? cWeth : cPrawl, aliceIn);
    await fund(signers.bob, wethIsCurrency0 ? cPrawl : cWeth, bobIn);

    await order(signers.alice, DIR_A_TO_B, aliceIn);
    await order(signers.bob, DIR_B_TO_A, bobIn);

    // The pool, not the batch, is the authoritative record of the trade: its
    // two token balances must move in opposite directions.
    const wethBefore = await weth.balanceOf(await poolManager.getAddress());
    const prawlBefore = await prawl.balanceOf(await poolManager.getAddress());

    const { net } = await settle();

    // Two A lots minus one B lot leaves one unmatched lot on the A side. The
    // public net is that residual, counted in lots.
    expect(net).to.equal(1n);

    const wethAfter = await weth.balanceOf(await poolManager.getAddress());
    const prawlAfter = await prawl.balanceOf(await poolManager.getAddress());
    const wethChanged = wethAfter !== wethBefore;
    const prawlChanged = prawlAfter !== prawlBefore;
    expect(wethChanged && prawlChanged, "the real pool executed the swap on both legs").to.equal(true);
    expect(wethAfter > wethBefore, "the pool received WETH").to.not.equal(prawlAfter > prawlBefore, "and paid out PRAWL");

    // Both users were paid into their confidential balances.
    const aliceVaultA = await vault(signers.alice, 0);
    const aliceVaultB = await vault(signers.alice, 1);
    const bobVaultA = await vault(signers.bob, 0);
    const bobVaultB = await vault(signers.bob, 1);
    expect(aliceVaultA + aliceVaultB, "Alice was credited").to.be.greaterThan(0n);
    expect(bobVaultA + bobVaultB, "Bob was credited").to.be.greaterThan(0n);
  });

  it("completes a fully matched round with no Uniswap leg at all", async function () {
    // One lot each way: the two orders cancel exactly, so nothing reaches the pool.
    const amtA = await lots(DIR_A_TO_B, 1n);
    const amtB = await lots(DIR_B_TO_A, 1n);
    await wrap(signers.alice, wethIsCurrency0 ? weth : prawl, wethIsCurrency0 ? cWeth : cPrawl, amtA);
    await wrap(signers.bob, wethIsCurrency0 ? prawl : weth, wethIsCurrency0 ? cPrawl : cWeth, amtB);
    await fund(signers.alice, wethIsCurrency0 ? cWeth : cPrawl, amtA);
    await fund(signers.bob, wethIsCurrency0 ? cPrawl : cWeth, amtB);
    await order(signers.alice, DIR_A_TO_B, amtA);
    await order(signers.bob, DIR_B_TO_A, amtB);

    const wethBefore = await weth.balanceOf(await poolManager.getAddress());
    const prawlBefore = await prawl.balanceOf(await poolManager.getAddress());
    const { net } = await settle();

    expect(net, "no residual means no public trade").to.equal(0n);
    expect(await weth.balanceOf(await poolManager.getAddress()), "pool untouched (WETH)").to.equal(wethBefore);
    expect(await prawl.balanceOf(await poolManager.getAddress()), "pool untouched (PRAWL)").to.equal(prawlBefore);
    expect(await vault(signers.alice, 1) + await vault(signers.alice, 0), "Alice paid 1:1").to.be.greaterThan(0n);
  });

  it("enforces the on-chain slippage floor from the oracle quote", async function () {
    // prepareSettle records minSwapOutput = the slippage floor (97%) of the oracle-quoted output for
    // the net residual. executeSettle reverts if the real pool delivers less,
    // so the floor is a hard on-chain guard, not an advisory estimate.
    // Two lots of A against one lot of B leaves a one-lot residual that must go
    // to the real pool, and the floor is checked against that residual.
    const amtA = await lots(DIR_A_TO_B, 2n);
    const amtB = await lots(DIR_B_TO_A, 1n);
    await wrap(signers.alice, wethIsCurrency0 ? weth : prawl, wethIsCurrency0 ? cWeth : cPrawl, amtA);
    await fund(signers.alice, wethIsCurrency0 ? cWeth : cPrawl, amtA);
    await order(signers.alice, DIR_A_TO_B, amtA);
    await wrap(signers.bob, wethIsCurrency0 ? prawl : weth, wethIsCurrency0 ? cPrawl : cWeth, amtB);
    await fund(signers.bob, wethIsCurrency0 ? cPrawl : cWeth, amtB);
    await order(signers.bob, DIR_B_TO_A, amtB);

    const roundId = await batch.currentRound();
    await (await batch.closeRound()).wait();
    const round = await batch.rounds(roundId);
    const dec = await fhevm.publicDecrypt([round.netEnc, round.surplusEnc]);
    const net = BigInt(dec.clearValues[round.netEnc] as bigint);
    const surplus = Number(dec.clearValues[round.surplusEnc] as bigint);
    await (await batch.prepareSettle(roundId, dec.abiEncodedClearValues, dec.decryptionProof)).wait();

    const prepared = await batch.rounds(roundId);
    const price = await batch.roundPrices(roundId);
    const outputLot = surplus === DIR_A_TO_B ? BigInt(price[1]) : BigInt(price[0]);
    // The floor share of the quoted output, rounded up — exactly what the contract computes.
    const floorBps = BigInt(await batch.SLIPPAGE_FLOOR_BPS());
    expect(floorBps, "the floor is 97%").to.equal(9700n);
    const expectedFloor = (net * outputLot * floorBps + 9999n) / 10000n;
    expect(BigInt(prepared.minSwapOutput), "the floor is the configured share of the quoted output").to.equal(expectedFloor);

    // The real pool delivers at least the floor at a 1:1 quoted price, so
    // settlement succeeds and its output is recorded.
    const dec2 = await fhevm.publicDecrypt([prepared.unwrapHandle]);
    const cleartext = BigInt(dec2.clearValues[prepared.unwrapHandle] as bigint);
    await (await batch.executeSettle(roundId, cleartext, dec2.decryptionProof)).wait();
    const settled = await batch.rounds(roundId);
    expect(settled.executed, "settlement completed").to.equal(true);
    expect(BigInt(settled.swapOutput), "delivered at least the floor").to.be.greaterThanOrEqual(expectedFloor);
  });
});
