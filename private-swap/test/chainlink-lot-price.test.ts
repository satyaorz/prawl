import { expect } from "chai";
import { ethers } from "hardhat";

describe("ChainlinkLotPriceOracle", function () {
  async function setup() {
    const tokenA = await (await ethers.getContractFactory("ERC20Mock")).deploy("WETH", "WETH", 18);
    const tokenB = await (await ethers.getContractFactory("ERC20Mock")).deploy("Custom", "CUSTOM", 18);
    const feedA = await (await ethers.getContractFactory("MockAggregator")).deploy(8, 2000n * 10n ** 8n);
    const feedB = await (await ethers.getContractFactory("MockAggregator")).deploy(18, 2n * 10n ** 18n);
    const oracle = await (await ethers.getContractFactory("ChainlinkLotPriceOracle")).deploy(
      await tokenA.getAddress(), await tokenB.getAddress(), await feedA.getAddress(), await feedB.getAddress(), 1_000_000, 10,
    );
    return { tokenA, tokenB, feedA, feedB, oracle };
  }

  it("normalizes different feed decimals and uses the older observation timestamp", async function () {
    const { feedA, feedB, oracle } = await setup();
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    await (await feedA.set(2, 2000n * 10n ** 8n, now - 10, 2)).wait();
    await (await feedB.set(2, 2n * 10n ** 18n, now - 5, 2)).wait();
    const [a, b, updated] = await oracle.latestLotPrice();
    expect(a).to.equal(1_000_000n);
    expect(b).to.equal(1_000_000_000n);
    expect(updated).to.equal(BigInt(now - 10));
  });

  it("rejects nonpositive, incomplete, and future feed observations", async function () {
    const { feedA, oracle } = await setup();
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    for (const [round, answer, at, answered] of [[1, 0, now, 1], [2, 1, now, 1], [1, 1, now + 1000, 1]]) {
      await (await feedA.set(round, answer, at, answered)).wait();
      await expect(oracle.latestLotPrice()).to.be.revertedWithCustomError(oracle, "InvalidFeed");
    }
  });

  it("rejects prices that cannot be represented within the rounding bound", async function () {
    const { feedA, feedB, oracle } = await setup();
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    await (await feedA.set(1, 1, now, 1)).wait();
    await (await feedB.set(1, 10n ** 30n, now, 1)).wait();
    await expect(oracle.latestLotPrice()).to.be.revertedWithCustomError(oracle, "InsufficientPrecision");
  });
});
