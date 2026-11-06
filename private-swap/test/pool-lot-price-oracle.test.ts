import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ethers } from "hardhat";
import { expect } from "chai";
import { parseUnits } from "ethers";

/**
 * The prototype's price source is the Uniswap v4 pool the batch settles
 * against — no external feeds. These tests check the conversion from the pool's
 * sqrtPriceX96 into lot sizes expressed in confidential wrapper units.
 */
const ZERO_HOOKS = "0x0000000000000000000000000000000000000000";

describe("PoolLotPriceOracle (price from the v4 pool)", function () {
  let signers: { deployer: HardhatEthersSigner };
  let tokenA: any, tokenB: any, cA: any, cB: any, manager: any, key: any;

  const sqrtPriceForPrice = (price: number) => BigInt(Math.floor(Math.sqrt(price) * 2 ** 96));

  /** Deploy a real PoolManager and initialize a pool at `price` (token1 per token0). */
  async function poolAt(price: number) {
    manager = await (await ethers.getContractFactory("PoolManager")).deploy(signers.deployer.address);
    await manager.waitForDeployment();
    const [addressA, addressB] = [await tokenA.getAddress(), await tokenB.getAddress()];
    key = {
      currency0: BigInt(addressA) < BigInt(addressB) ? addressA : addressB,
      currency1: BigInt(addressA) < BigInt(addressB) ? addressB : addressA,
      fee: 3000,
      tickSpacing: 60,
      hooks: ZERO_HOOKS,
    };
    await (await manager.initialize(
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
      sqrtPriceForPrice(price),
    )).wait();
  }

  async function oracleFor(lotAUnits: bigint) {
    return (await ethers.getContractFactory("PoolLotPriceOracle")).deploy(
      await manager.getAddress(),
      await cA.getAddress(),
      await cB.getAddress(),
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
      lotAUnits,
    );
  }

  const RATE = parseUnits("1", 12); // 18-dp underlying -> 6-dp confidential units
  const CONF_LOT_A = parseUnits("1", 6); // 1 token A per lot, in confidential units

  before(async function () {
    const all: HardhatEthersSigner[] = await ethers.getSigners();
    signers = { deployer: all[0] };
    tokenA = await (await ethers.getContractFactory("ERC20Mock")).deploy("WETH", "WETH", 18);
    tokenB = await (await ethers.getContractFactory("ERC20Mock")).deploy("Prawl", "PRAWL", 18);
    cA = await (await ethers.getContractFactory("VeilConfidentialWrapper")).deploy(await tokenA.getAddress());
    cB = await (await ethers.getContractFactory("VeilConfidentialWrapper")).deploy(await tokenB.getAddress());
    expect(await cA.rate()).to.equal(RATE);
  });

  it("quotes a 1:1 pool as equal confidential lots", async function () {
    await poolAt(1);
    const oracle = await oracleFor(parseUnits("1", 18));
    const [lotA, lotB] = await oracle.latestLotPrice();
    expect(lotA).to.equal(CONF_LOT_A);
    expect(lotB).to.equal(CONF_LOT_A);
  });

  it("quotes a 4:1 pool as one lotA to four lotB", async function () {
    // 1 underlying token0 buys 4 underlying token1.
    await poolAt(4);
    const oracle = await oracleFor(parseUnits("1", 18));
    const [lotA, lotB] = await oracle.latestLotPrice();
    expect(lotA).to.equal(CONF_LOT_A);
    expect(lotB).to.equal(parseUnits("4", 6));
  });

  it("quotes a fractional price", async function () {
    await poolAt(0.25);
    const oracle = await oracleFor(parseUnits("1", 18));
    const [lotA, lotB] = await oracle.latestLotPrice();
    expect(lotA).to.equal(CONF_LOT_A);
    expect(lotB).to.equal(parseUnits("0.25", 6));
  });

  it("scales the lot with the configured lotA size", async function () {
    await poolAt(2);
    const oracle = await oracleFor(parseUnits("10", 18)); // 10 token0 per lot
    const [lotA, lotB] = await oracle.latestLotPrice();
    expect(lotA).to.equal(parseUnits("10", 6));
    expect(lotB).to.equal(parseUnits("20", 6));
  });

  it("reports now as the observation time and rejects an uninitialized pool", async function () {
    await poolAt(1);
    const oracle = await oracleFor(parseUnits("1", 18));
    const [, , updatedAt] = await oracle.latestLotPrice();
    const block = await ethers.provider.getBlock("latest");
    expect(updatedAt).to.equal(BigInt(block!.timestamp));

    const emptyKey = { ...key, fee: 500 };
    const uninitialized = await (await ethers.getContractFactory("PoolLotPriceOracle")).deploy(
      await manager.getAddress(), await cA.getAddress(), await cB.getAddress(),
      [emptyKey.currency0, emptyKey.currency1, emptyKey.fee, emptyKey.tickSpacing, emptyKey.hooks],
      parseUnits("1", 18),
    );
    await expect(uninitialized.latestLotPrice()).to.be.revertedWithCustomError(uninitialized, "InvalidPool");
  });

  it("rejects a lot so small it rounds to zero confidential units", async function () {
    await poolAt(1);
    // 1 wei of underlying / 1e12 rate = 0 confidential units.
    const oracle = await oracleFor(1n);
    await expect(oracle.latestLotPrice()).to.be.revertedWithCustomError(oracle, "InsufficientPrecision");
  });
});
