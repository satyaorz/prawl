/**
 * End-to-end proof round on the CURRENT deployment: two burner accounts wrap
 * and deposit, then the keeper (running separately) does everything else —
 * close, gateway decryption, prepare, Uniswap swap, and permissionless claims
 * paying UNDERLYING tokens. This script only deposits and then polls for the
 * outcome, proving the user never signs a settle/withdraw/unwrap.
 *
 * Run: node scripts/e2e-round.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { createInstance, SepoliaConfig } from '@zama-fhe/relayer-sdk/node';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
function loadEnvFile(path) {
  try {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  } catch {}
}
loadEnvFile(resolve(root, '.env.local'));
loadEnvFile(resolve(root, 'protocol/.env'));

const RPC = process.env.RPC_URL_SEPOLIA || process.env.SEPOLIA_RPC_URL;
const config = JSON.parse(readFileSync(resolve(root, 'batch-config.json'), 'utf8'));
const provider = new ethers.JsonRpcProvider(RPC, 11155111, { staticNetwork: true });
const alice = new ethers.Wallet(process.env.DEMO_KEY_ALICE, provider);
const bob = new ethers.Wallet(process.env.DEMO_KEY_BOB, provider);
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

const ERC20 = ['function mint(address,uint256)', 'function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function symbol() view returns (string)'];
const WRAP = [...ERC20, 'function wrap(address,uint256)', 'function confidentialTransferAndCall(address,bytes32,bytes,bytes)'];
const BATCH = ['function currentRound() view returns (uint256)', 'function withdrawn(uint256,uint8,address) view returns (bool)'];

const tokenA = new ethers.Contract(config.tokenA, ERC20, provider);
const tokenB = new ethers.Contract(config.tokenB, ERC20, provider);
const cA = new ethers.Contract(config.cTokenA, WRAP, provider);
const cB = new ethers.Contract(config.cTokenB, WRAP, provider);
const batch = new ethers.Contract(config.batch, BATCH, provider);

const AMOUNT = 5n * 10n ** 6n; // 5 c-units each side

async function retry(fn, label, attempts = 6, delayMs = 6000) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (!/timeout|ETIMEDOUT|ECONNRESET|429|rate/i.test(String(e.message))) throw e;
      log(`${label}: transient RPC error — retry ${i + 1}/${attempts - 1}`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw last;
}

async function send(wallet, contract, method, args, label) {
  await retry(async () => {
    const c = contract.connect(wallet);
    const tx = await c[method](...args);
    log(`${label}: ${tx.hash}`);
    const r = await tx.wait(1);
    if (r.status !== 1) throw new Error(`${label} reverted`);
    log(`${label}: ✓ block ${r.blockNumber}`);
  }, label);
}

async function setup(wallet, underlying, wrapper, which) {
  const bal = await underlying.balanceOf(wallet.address);
  if (bal < AMOUNT) {
    await send(wallet, underlying, 'mint', [wallet.address, AMOUNT * 2n], `${which} faucet for ${wallet.address.slice(0, 8)}`);
  }
  // ERC-7984 wrappers expose no balanceOf — just top up unconditionally.
  await send(wallet, underlying, 'approve', [await wrapper.getAddress(), AMOUNT * 2n], `${which} approve`);
  await send(wallet, wrapper, 'wrap', [wallet.address, AMOUNT], `${which} wrap`);
}

async function main() {
  log(`E2E round on batch ${config.batch} (rounds ${config.minRoundDuration}s, threshold ${config.minUsers} users)`);
  const fhevm = await createInstance({ ...SepoliaConfig, network: RPC });
  log('FHEVM ready');

  await setup(alice, tokenA, cA, 'vUSD');
  await setup(bob, tokenB, cB, 'vETH');

  const roundId = Number(await batch.currentRound());
  log(`depositing into round ${roundId}: alice 5 c-vUSD → vETH, bob 5 c-vETH → vUSD`);

  for (const [wallet, wrapper, direction, data] of [
    [alice, cA, 1, '0x01'],
    [bob, cB, 2, '0x02'],
  ]) {
    const wrapperAddress = await wrapper.getAddress();
    const enc = await retry(() => fhevm.createEncryptedInput(wrapperAddress, wallet.address).add64(AMOUNT).encrypt(), `encrypt d${direction}`);
    await send(wallet, wrapper, 'confidentialTransferAndCall', [config.batch, enc.handles[0], enc.inputProof, data], `deposit d${direction} ${wallet.address.slice(0, 8)}`);
  }
  log('both deposits in — keeper now owns the rest (close → decrypt → prepare → swap → claim)');

  const t0 = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 10000));
    const aDone = await retry(() => batch.withdrawn(roundId, 1, alice.address), 'poll');
    const bDone = await retry(() => batch.withdrawn(roundId, 2, bob.address), 'poll');
    const aVeth = ethers.formatUnits(await retry(() => tokenB.balanceOf(alice.address), 'poll'), 18);
    const bVusd = ethers.formatUnits(await retry(() => tokenA.balanceOf(bob.address), 'poll'), 18);
    log(`waiting… alice claimed=${aDone} (vETH ${aVeth}) bob claimed=${bDone} (vUSD ${bVusd}) [${Math.round((Date.now() - t0) / 1000)}s]`);
    if (aDone && bDone) {
      // Wait one more beat for the unwrap finalize (underlying to arrive).
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 10000));
        const aBal = await retry(() => tokenB.balanceOf(alice.address), 'poll');
        const bBal = await retry(() => tokenA.balanceOf(bob.address), 'poll');
        log(`underlying check ${i}: alice vETH ${ethers.formatUnits(aBal, 18)} | bob vUSD ${ethers.formatUnits(bBal, 18)}`);
        if (aBal > 0n && bBal > 0n) break;
      }
      log(`E2E COMPLETE ✓ alice vETH=${ethers.formatUnits(await tokenB.balanceOf(alice.address), 18)} bob vUSD=${ethers.formatUnits(await tokenA.balanceOf(bob.address), 18)} — users signed NOTHING after deposit`);
      return;
    }
    if (Date.now() - t0 > 15 * 60 * 1000) throw new Error('E2E timed out after 15 min');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
