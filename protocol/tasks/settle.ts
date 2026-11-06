import { task } from "hardhat/config";
import { createInstance, SepoliaConfig } from "@zama-fhe/relayer-sdk/node";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Settlement operator task. The contract commits the minimum output during
 * prepareSettle; the execute transaction is then safe for any keeper to relay.
 * For this parity-priced demo pool the fallback floor is 95% of the net input.
 *
 *   npx hardhat settle --network sepolia
 */
task("settle", "Close eligible rounds and settle decrypted ones").setAction(async (_args, hre) => {
  const { deployments, ethers } = hre;
  const deployment = await deployments.getOrNull("VeilBatchSwap");
  let batchAddress = deployment?.address;
  if (!batchAddress) {
    try {
      batchAddress = JSON.parse(readFileSync(resolve(process.cwd(), "deployments/sepolia.json"), "utf8")).batch;
    } catch {}
  }
  if (!batchAddress) throw new Error("VeilBatchSwap deployment not found in Hardhat deployments or deployments/sepolia.json.");
  const batch: any = await ethers.getContractAt("VeilBatchSwap", batchAddress);
  const [keeper] = await hre.ethers.getSigners();
  const rpcUrl = process.env.RPC_URL_SEPOLIA || process.env.SEPOLIA_RPC_URL;
  if (!rpcUrl) throw new Error("Set RPC_URL_SEPOLIA or SEPOLIA_RPC_URL for the Zama Sepolia gateway.");
  let fhevm: any;

  const currentRound = Number(await batch.currentRound());
  for (let roundId = currentRound - 1; roundId >= 1; roundId--) {
    let round = await batch.rounds(roundId);
    if (!round.closed || round.executed) continue;
    if (!fhevm) fhevm = await createInstance({ ...SepoliaConfig, network: rpcUrl });

    if (!round.prepared) {
      if ((await batch.settler()).toLowerCase() !== keeper.address.toLowerCase()) {
        throw new Error(`Configured settlement operator is ${await batch.settler()}, but signer is ${keeper.address}.`);
      }
      const handles = [ethers.hexlify(round.aToB), ethers.hexlify(round.bToA)];
      const totals = await fhevm.publicDecrypt(handles);
      const totalA = BigInt(totals.clearValues[handles[0]]);
      const totalB = BigInt(totals.clearValues[handles[1]]);
      const net = totalA >= totalB ? totalA - totalB : totalB - totalA;
      // This project deploys a 1:1 vUSD/vETH demo pool. For other pairs the
      // operator must replace this parity quote with a protected pool quote.
      const minSwapOutput = net === 0n ? 0n : (net * 9500n + 9999n) / 10000n;
      const prepareTx = await batch.connect(keeper).prepareSettle(
        roundId,
        totals.abiEncodedClearValues,
        totals.decryptionProof,
        minSwapOutput,
      );
      await prepareTx.wait();
      console.log(`Prepared round ${roundId}: net ${net}, minimum output ${minSwapOutput}, tx ${prepareTx.hash}`);
      round = await batch.rounds(roundId);
    }

    if (round.netSwapped > 0n) {
      const unwrapHandle = ethers.hexlify(round.unwrapHandle);
      const unwrap = await fhevm.publicDecrypt([unwrapHandle]);
      const cleartext = BigInt(unwrap.clearValues[unwrapHandle]);
      const execTx = await batch.connect(keeper).executeSettle(roundId, cleartext, unwrap.decryptionProof);
      const receipt = await execTx.wait();
      console.log(`Settled round ${roundId}: tx ${execTx.hash}, gas ${receipt?.gasUsed}`);
    } else {
      const execTx = await batch.connect(keeper).executeSettle(roundId, 0, "0x");
      await execTx.wait();
      console.log(`Settled round ${roundId} (fully matched): tx ${execTx.hash}`);
    }
  }

  const lastUpdateTime = Number(await batch.lastUpdateTime());
  const duration = Number(await batch.minRoundDuration());
  const submitters = Number(await batch.minDistinctSubmitters());
  const now = Math.floor(Date.now() / 1000);
  if (now >= lastUpdateTime + duration && Number(await batch.distinctSubmitters()) >= submitters) {
    const tx = await batch.connect(keeper).closeRound();
    await tx.wait();
    console.log(`Closed round ${currentRound}: tx ${tx.hash}`);
  }
});
