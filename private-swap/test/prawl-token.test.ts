import { expect } from "chai";
import { ethers } from "hardhat";

describe("PrawlToken", () => {
  it("mints a fixed 18-decimal supply to the configured holder", async () => {
    const [, holder, recipient] = await ethers.getSigners();
    const token = await (await ethers.getContractFactory("PrawlToken")).deploy("Prawl Token", "PRAWL", holder.address, 1000n);
    expect(await token.decimals()).to.equal(18);
    expect(await token.totalSupply()).to.equal(1000n);
    await (await token.connect(holder).transfer(recipient.address, 20n)).wait();
    expect(await token.balanceOf(recipient.address)).to.equal(20n);
    expect(await token.totalSupply()).to.equal(1000n);
  });

  it("rejects empty metadata and an invalid initial supply", async () => {
    const [holder] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("PrawlToken");
    await expect(factory.deploy("", "PRAWL", holder.address, 1)).to.be.revertedWith("empty metadata");
    await expect(factory.deploy("Prawl", "PRAWL", ethers.ZeroAddress, 1)).to.be.revertedWith("invalid initial supply");
    await expect(factory.deploy("Prawl", "PRAWL", holder.address, 0)).to.be.revertedWith("invalid initial supply");
  });
});
