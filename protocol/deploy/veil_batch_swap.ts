import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

/**
 * Deploys the Veil batch-swap stack on Sepolia:
 *   c-vUSD, c-vETH (confidential wrappers of the demo tokens)
 *   VeilBatchSwap   (round-based FHE batcher with internal netting)
 *
 * Env:
 *   VEIL_TOKEN_A (vUSD), VEIL_TOKEN_B (vETH) — deployed by the main app's pool-setup
 *   UNI_POOL_MANAGER_SEPOLIA, UNI_UNIVERSAL_ROUTER_SEPOLIA, PERMIT2_SEPOLIA
 *   VEIL_POOL_FEE (default 3000), VEIL_TICK_SPACING (default 60)
 *   VEIL_MIN_ROUND_SECONDS (default 600), VEIL_MIN_USERS (default 3)
 */
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deploy, getOrNull } = hre.deployments;
  const { deployer } = await hre.getNamedAccounts();

  const tokenA = process.env.VEIL_TOKEN_A;
  const tokenB = process.env.VEIL_TOKEN_B;
  if (!tokenA || !tokenB) throw new Error("Set VEIL_TOKEN_A / VEIL_TOKEN_B (vUSD, vETH addresses)");
  const poolManager = process.env.UNI_POOL_MANAGER_SEPOLIA || "0xE03A1074c86CFeDd5C142C4F04F1a1536e203543";
  const universalRouter = process.env.UNI_UNIVERSAL_ROUTER_SEPOLIA || "0x3a9d48ab9751398bbfa63ad67599bb04e4bdf98b";
  const permit2 = process.env.PERMIT2_SEPOLIA || "0x000000000022D473030F116dDEE9F6B43aC78BA3";
  const fee = Number(process.env.VEIL_POOL_FEE || 3000);
  const tickSpacing = Number(process.env.VEIL_TICK_SPACING || 60);
  const minRoundSeconds = Number(process.env.VEIL_MIN_ROUND_SECONDS || 600);
  const minUsers = Number(process.env.VEIL_MIN_USERS || 3);

  const sortTokens = (a: string, b: string) =>
    BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  const [currency0, currency1] = sortTokens(tokenA, tokenB);
  const poolKey = {
    currency0,
    currency1,
    fee,
    tickSpacing,
    hooks: "0x0000000000000000000000000000000000000000",
  };

  const cA = await deploy("VeilConfidentialWrapper", { from: deployer, args: [tokenA], log: true });
  const cB = await deploy("VeilConfidentialWrapper", { from: deployer, args: [tokenB], log: true });
  console.log(`c-tokenA (${tokenA}): ${cA.address}`);
  console.log(`c-tokenB (${tokenB}): ${cB.address}`);

  const batch = await deploy("VeilBatchSwap", {
    from: deployer,
    args: [universalRouter, permit2, cA.address, cB.address, poolKey, minRoundSeconds, minUsers, deployer],
    log: true,
  });
  console.log(`VeilBatchSwap: ${batch.address}`);
  console.log(`PoolKey: ${currency0} / ${currency1} fee=${fee} spacing=${tickSpacing}`);
};

func.id = "veil_batch_swap";
func.tags = ["VeilBatchSwap"];
export default func;
