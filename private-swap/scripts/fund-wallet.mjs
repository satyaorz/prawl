/**
 * Give a wallet's public account what it needs for the swap demo: Sepolia ETH
 * for gas, WETH (and optionally PRAWL) from the deployer.
 *
 * Usage: node scripts/fund-wallet.mjs <0xAddress> [ethAmount=0.01] [wethAmount=0.0005] [prawlAmount=0]
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const f of [".env.local", ".env"]) {
  try {
    for (const line of readFileSync(resolve(root, f), "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
    }
  } catch {}
}
const [to, eth = "0.01", weth = "0.0005", prawl = "0"] = process.argv.slice(2);
if (!ethers.isAddress(to)) throw new Error("Usage: fund-wallet.mjs <0xAddress> [eth] [weth] [prawl]");
const manifest = JSON.parse(readFileSync(resolve(root, process.env.PRAWL_DEPLOYMENTS_DIR ?? "deployments", "manifest.json"), "utf8"));
const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL, manifest.chainId, { staticNetwork: true });
const deployer = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
const erc20 = ["function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"];
const send = async (label, fn) => {
  const tx = await fn();
  await tx.wait();
  console.log(`${label}: ${tx.hash}`);
};
if (Number(eth) > 0) await send(`${eth} ETH`, () => deployer.sendTransaction({ to, value: ethers.parseEther(eth) }));
for (const [symbol, token, amount] of [["WETH", manifest.tokenB, weth], ["PRAWL", manifest.tokenA, prawl]]) {
  if (Number(amount) <= 0) continue;
  const c = new ethers.Contract(token, erc20, deployer);
  await new Promise((r) => setTimeout(r, 4000)); // let the public node see the previous transaction's nonce
  await send(`${amount} ${symbol}`, () => c.transfer(to, ethers.parseEther(amount)));
}
