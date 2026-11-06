/**
 * Veil keeper — a continuous state machine that drives every permissionless
 * step of the batch lifecycle so users never wait on an operator:
 *
 *   1. close eligible rounds          (threshold: time + distinct submitters)
 *   2. decrypt round totals           (gateway, with retry/backoff)
 *   3. prepareSettle                  (verifies proof, opens async unwrap)
 *   4. decrypt unwrap request         (second gateway proof)
 *   5. executeSettle                  (Uniswap v4 swap of the net leg)
 *   6. withdrawForAndUnwrap           (after the T2 redeploy; feature-detected)
 *   7. finalize pending unwrap requests for ALL users (permissionless)
 *
 * Everything here is callable by anyone — the keeper is just the party that
 * is always online. Run:  node scripts/keeper.mjs   (loop interval: KEEPER_INTERVAL_MS)
 */
import { readFileSync, writeFileSync } from 'node:fs';
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
// Alchemy's free tier caps eth_getLogs at a 10-block range — event scans go
// to a public full node instead.
const LOGS_RPC = process.env.LOGS_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';
const INTERVAL = Number(process.env.KEEPER_INTERVAL_MS || 8000);
const config = JSON.parse(readFileSync(resolve(root, 'batch-config.json'), 'utf8'));
if (!config?.deployed) throw new Error('No deployment found — run scripts/deploy-stack.mjs first.');

const provider = new ethers.JsonRpcProvider(RPC, 11155111, { staticNetwork: true });
const logsProvider = new ethers.JsonRpcProvider(LOGS_RPC, 11155111, { staticNetwork: true });
const keeper = new ethers.Wallet(process.env.PROTOCOL_PRIVATE_KEY, provider);
const log = (...args) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args);

const ERC20 = ['function mint(address,uint256)', 'function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function symbol() view returns (string)'];
const WRAPPER_ABI = [
  ...ERC20,
  'function wrap(address to, uint256 underlyingAmount)',
  'function confidentialTransferAndCall(address to, bytes32 encryptedAmount, bytes inputProof, bytes data)',
  'function unwrap(address from, address to, bytes32 encryptedAmount, bytes calldata inputProof)',
  'function finalizeUnwrap(bytes32 unwrapAmount, uint64 unwrapAmountCleartext, bytes calldata decryptionProof)',
  'function unwrapRequester(bytes32) view returns (address)',
  'function confidentialBalanceOf(address) view returns (bytes32)',
  'function rate() view returns (uint256)',
  'event UnwrapRequested(address indexed receiver, bytes32 amount)',
];
const BATCH_ABI = [
  'function currentRound() view returns (uint256)',
  'function rounds(uint256) view returns (bytes32 aToB, bytes32 bToA, bytes32 netEnc, bytes32 surplusEnc, bool closed, bool prepared, bool executed, uint64 netSwapped, uint8 surplusSide, uint256 minSwapOutput, bytes32 unwrapHandle, uint64 swapOutput)',
  'function distinctSubmitters() view returns (uint256)',
  'function lastUpdateTime() view returns (uint256)',
  'function closeRound()',
  'function submitOrder(bytes32,bytes,bytes32,bytes)',
  'function prepareSettle(uint256 roundId, bytes clearValues, bytes decryptionProof)',
  'function executeSettle(uint256 roundId, uint64 unwrapCleartext, bytes decryptionProof)',
  'function creditOrder(uint256 roundId, address user)',
  'event OrderSubmitted(uint256 indexed round, address indexed user)',
  'event OrderCredited(uint256 indexed round, address indexed user)',
  'event DepositSubmitted(uint256 indexed round, uint8 indexed direction, address indexed user)',
  'event RoundPrepared(uint256 indexed round, uint64 matched, uint64 net, bytes32 unwrapHandle)',
  'event UnwrapRequested(address indexed receiver, bytes32 amount)',
];

const POOL_MANAGER = new ethers.Contract(
  config.poolManager ?? '0xE03A1074c86CFeDd5C142C4F04F1a1536e203543',
  ['function getSlot0(bytes32) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)'],
  provider,
);

const batch = new ethers.Contract(config.batch, BATCH_ABI, keeper);
const readBatch = new ethers.Contract(config.batch, BATCH_ABI, provider);

const wrappers = [config.cTokenA, config.cTokenB].map((a) => new ethers.Contract(a, WRAPPER_ABI, keeper));
const wrapperReads = [config.cTokenA, config.cTokenB].map((a) => new ethers.Contract(a, WRAPPER_ABI, provider));

let fhevm;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

async function waitTx(contract, method, args, label) {
  const tx = await contract[method](...args);
  log(`${label}: ${tx.hash}`);
  const receipt = await tx.wait(1);
  if (receipt.status !== 1) throw new Error(`${label} reverted`);
  log(`${label}: ✓ block ${receipt.blockNumber} gas=${receipt.gasUsed}`);
  return receipt;
}

async function publicDecryptRetry(handles, label, attempts = 8, delayMs = 4000) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fhevm.publicDecrypt(handles);
    } catch (error) {
      lastError = error;
      if (i < attempts - 1) {
        log(`${label}: gateway not ready — retry ${i + 1}/${attempts - 1} in ${delayMs / 1000}s`);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastError;
}

function clearValue(dec, handle) {
  for (const key of [handle, handle.toLowerCase(), handle.toUpperCase()]) {
    if (dec.clearValues?.[key] !== undefined) return BigInt(dec.clearValues[key]);
  }
  throw new Error(`clearValues missing handle ${String(handle).slice(0, 18)}…`);
}

// Slippage guard: anchor to the most recent executed round's realized rate
// (same surplus direction only — the rate's units differ per direction), or
// for the first leg in a direction, the live Uniswap v4 pool price with a
// 10% tolerance. minOut=0 reverts on-chain (MissingSwapMinimum) whenever the
// net leg is >0, so "no anchor" must never produce 0.
async function anchoredMinSwapOutput(roundId, net, aSurplus) {
  for (let prev = roundId - 1; prev >= 1; prev--) {
    const r = await getRound(prev);
    if (r.executed && r.netSwapped > 0n && Boolean(r.aWasSurplus) === aSurplus) {
      const rate18 = (r.swapOutput * 10n ** 18n) / r.netSwapped;
      const minOut = (net * rate18 * 9500n) / (10000n * 10n ** 18n);
      log(`slippage guard: round ${prev} rate ${(Number(rate18) / 1e18).toFixed(6)} → minSwapOutput ${minOut}`);
      return minOut;
    }
  }
  // This v4 deployment's getSlot0 reverts on external calls, so the first leg
  // in a direction uses a conservative 90%-of-net floor (the demo pool is
  // seeded ~1:1; realized fees+slippage measured ~3%). Later legs anchor to
  // the realized rate at 95%.
  const minOut = (net * 9000n) / 10000n;
  log(`slippage guard: first leg in this direction — conservative 90% floor → minSwapOutput ${minOut}`);
  return minOut;
}

async function getRound(roundId) {
  return readBatch.rounds(roundId);
}

// --- state machine steps -----------------------------------------------------

// minRoundDuration/minDistinctSubmitters are immutables — no getters on the
// deployed contract. Read the duration from the deploy config (fallback 60s)
// and let closeRound itself enforce the submitter threshold.
const MIN_ROUND_SECONDS = Number(config.minRoundDuration ?? 60);
async function maybeCloseRound() {
  const currentRound = Number(await readBatch.currentRound());
  const round = await getRound(currentRound);
  if (round.closed) return false;
  const lastUpdate = Number(await readBatch.lastUpdateTime());
  const now = Math.floor(Date.now() / 1000);
  if (now < lastUpdate + MIN_ROUND_SECONDS) return false;
  let users = null;
  try { users = Number(await readBatch.distinctSubmitters()); } catch { /* getter absent on older deployments */ }
  if (users !== null && users < 2) {
    log(`round ${currentRound}: ${users} submitters, waiting`);
    return false;
  }
  try {
    await waitTx(batch, 'closeRound', [], `closeRound ${currentRound}`);
    return true;
  } catch (error) {
    log(`closeRound ${currentRound} not eligible yet (${String(error.message?.shortMessage || error.message).slice(0, 60)})`);
    return false;
  }
}

async function maybePrepareSettle(roundId) {
  const round = await getRound(roundId);
  if (!round.closed || round.prepared || round.executed) return false;
  const handleNet = ethers.hexlify(round.netEnc);
  const handleSurplus = ethers.hexlify(round.surplusEnc);
  const dec = await publicDecryptRetry([handleNet, handleSurplus], `round ${roundId} net+surplus`);
  const net = clearValue(dec, handleNet);
  const surplus = Number(clearValue(dec, handleSurplus));
  log(`round ${roundId} public disclosures: net=${net} surplusSide=${surplus} (totals stay encrypted)`);
  await waitTx(batch, 'prepareSettle', [roundId, dec.abiEncodedClearValues, dec.decryptionProof], `prepareSettle ${roundId}`);
  return true;
}

async function maybeExecuteSettle(roundId) {
  const round = await getRound(roundId);
  if (!round.prepared || round.executed) return false;
  const net = round.netSwapped;
  if (net > 0n) {
    // Prefer the RoundPrepared event (immune to read-after-write lag), fall
    // back to the stored handle.
    let unwrapHandle = ethers.hexlify(round.unwrapHandle);
    if (unwrapHandle === ethers.ZeroHash) {
      const logs = await logsProvider.send('eth_getLogs', [{
        fromBlock: '0x' + Math.max(0, (await provider.getBlockNumber()) - 5000).toString(16),
        toBlock: 'latest',
        address: config.batch,
        topics: [batch.interface.getEvent('RoundPrepared').topicHash, ethers.zeroPadValue(ethers.toBeHex(roundId), 32)],
      }]);
      for (const raw of logs.reverse()) {
        const ev = batch.interface.parseLog({ topics: [...raw.topics], data: raw.data });
        if (ev.name === 'RoundPrepared' && ev.args.unwrapHandle !== ethers.ZeroHash) { unwrapHandle = ev.args.unwrapHandle; break; }
      }
    }
    if (unwrapHandle === ethers.ZeroHash) throw new Error(`unwrap handle for round ${roundId} not found`);
    const dec2 = await publicDecryptRetry([unwrapHandle], 'unwrap request');
    const cleartext = clearValue(dec2, unwrapHandle);
    log(`round ${roundId} unwrap request decrypted: ${cleartext}`);
    await waitTx(batch, 'executeSettle', [roundId, cleartext, dec2.decryptionProof], `executeSettle ${roundId}`);
  } else {
    await waitTx(batch, 'executeSettle', [roundId, 0n, '0x'], `executeSettle ${roundId} (fully matched)`);
  }
  return true;
}

// v3: payouts credit confidential vault balances — permissionless creditOrder
// for every orderer of a settled round (found via OrderSubmitted events).
async function maybeCreditOrders(roundId) {
  if (!batch.interface.hasFunction('creditOrder')) return false;
  const round = await getRound(roundId);
  if (!round.executed) return false;
  const head = await provider.getBlockNumber();
  const fromBlock = '0x' + Math.max(0, head - 5000).toString(16);
  const logs = await logsProvider.send('eth_getLogs', [{
    fromBlock,
    toBlock: 'latest',
    address: config.batch,
    topics: [
      batch.interface.getEvent('OrderSubmitted').topicHash,
      ethers.zeroPadValue(ethers.toBeHex(roundId), 32),
    ],
  }]);
  const users = [...new Set(logs.map((l) => ethers.getAddress('0x' + l.topics[2].slice(26))))];
  let credited = 0;
  for (const user of users) {
    try {
      await waitTx(batch, 'creditOrder', [roundId, user], `creditOrder r${roundId} ${user.slice(0, 8)}`);
      credited++;
    } catch (error) {
      const msg = String(error.message?.shortMessage || error.message);
      if (!/AlreadyCredited|NoOrder/.test(msg)) log(`credit ${user.slice(0, 8)} failed: ${msg.slice(0, 90)}`);
    }
  }
  return credited > 0;
}

// Finalize ANY user's pending unwrap request — permissionless by design.
async function finalizePendingUnwraps() {
  const head = await provider.getBlockNumber();
  const fromBlock = '0x' + Math.max(0, head - 5000).toString(16);
  let finalized = 0;
  for (let i = 0; i < wrappers.length; i++) {
    const wrapper = wrappers[i];
    const readWrapper = wrapperReads[i];
    const logs = await logsProvider.send('eth_getLogs', [{
      fromBlock,
      toBlock: 'latest',
      address: await readWrapper.getAddress(),
      topics: [wrapper.interface.getEvent('UnwrapRequested').topicHash],
    }]);
    const handles = [...new Set(logs.map((l) => '0x' + l.data.slice(2, 66)))];
    for (const handle of handles) {
      try {
        const requester = await readWrapper.unwrapRequester(handle);
        if (requester === ZERO_ADDRESS) continue; // already finalized
        const dec = await publicDecryptRetry([handle], `unwrap ${handle.slice(0, 10)}…`, 3, 5000);
        const cleartext = clearValue(dec, handle);
        await waitTx(wrapper, 'finalizeUnwrap', [handle, cleartext, dec.decryptionProof], `finalizeUnwrap ${handle.slice(0, 10)}… → ${requester.slice(0, 8)}`);
        finalized++;
      } catch (error) {
        log(`finalize ${handle.slice(0, 10)}… failed: ${String(error.message).slice(0, 90)}`);
      }
    }
  }
  return finalized;
}

// ---------------------------------------------------------------------------
// Liquidity bot: when a single trader has waited out the round window, the
// keeper deposits a small counter-amount in BOTH directions so every user
// round completes (matched internally, net leg swaps on Uniswap). The bot's
// deposits are public in Transparency — labeled as the keeper address.
// ---------------------------------------------------------------------------
const BOT_C_UNITS = 1n * 10n ** 6n; // 1 c-unit per bot order
const BOT_FUND_FILE = new URL('./bot-funded.json', import.meta.url);

// Fund the bot's confidential vault balance ONCE (public leg — the bot is the
// keeper address and its funding is labeled as such). Later orders draw on the
// funded balance without revealing sizes.
async function botEnsureFunded() {
  let funded;
  try { funded = JSON.parse(readFileSync(BOT_FUND_FILE, 'utf8')); } catch { funded = {}; }
  if (funded.batch === config.batch) return;
  for (const [which, wrapper, readWrapper] of [['A', wrappers[0], wrapperReads[0]], ['B', wrappers[1], wrapperReads[1]]]) {
    const underlying = new ethers.Contract(
      which === 'A' ? config.tokenA : config.tokenB,
      ['function mint(address,uint256)', 'function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)'],
      keeper,
    );
    const wrapperAddress = await wrapper.getAddress();
    const uAmount = 200n * 10n ** 6n; // 200 c-units of funding, plenty for the demo
    if (BigInt(await underlying.balanceOf(keeper.address)) < uAmount) {
      await waitTx(underlying, 'mint', [keeper.address, uAmount * 2n], `bot faucet ${which === 'A' ? 'vUSD' : 'vETH'}`);
    }
    if (BigInt(await underlying.allowance(keeper.address, wrapperAddress)) < uAmount) {
      await waitTx(underlying, 'approve', [wrapperAddress, uAmount * 10n], `bot approve ${which === 'A' ? 'vUSD' : 'vETH'}`);
    }
    await waitTx(wrapper, 'wrap', [keeper.address, uAmount], `bot wrap ${which === 'A' ? 'vUSD' : 'vETH'}`);
    // fund: transfer c-tokens to the batch with data 0x00
    const rate = BigInt(await readWrapper.rate());
    const enc2 = await fhevm.createEncryptedInput(wrapperAddress, keeper.address).add64(uAmount / rate).encrypt();
    await waitTx(wrapper, 'confidentialTransferAndCall', [config.batch, enc2.handles[0], enc2.inputProof, '0x00'], `bot fund ${which === 'A' ? 'vUSD' : 'vETH'}`);
  }
  writeFileSync(BOT_FUND_FILE, JSON.stringify({ batch: config.batch, at: new Date().toISOString() }));
  log('liquidity bot: confidential funding complete (200 c-units each side)');
}

// The bot cannot know which side needs liquidity (directions are encrypted!),
// so it submits ONE order in a random direction. Either way the round
// completes for the waiting trader: opposite → matched 1:1 internally;
// same → both join the net leg swapped on Uniswap.
async function botOrder() {
  await botEnsureFunded();
  const dir = Math.random() < 0.5 ? 1 : 2;
  const enc = await fhevm.createEncryptedInput(config.batch, keeper.address).add64(BOT_C_UNITS).add8(dir).encrypt();
  await waitTx(batch, 'submitOrder', [enc.handles[0], enc.inputProof, enc.handles[1], enc.inputProof], `bot order (encrypted dir=${dir})`);
}

async function maybeCounterparty() {
  const currentRound = Number(await readBatch.currentRound());
  const round = await getRound(currentRound);
  if (round.closed) return false;
  const lastUpdate = Number(await readBatch.lastUpdateTime());
  const now = Math.floor(Date.now() / 1000);
  if (now < lastUpdate + MIN_ROUND_SECONDS) return false;
  let users = null;
  try { users = Number(await readBatch.distinctSubmitters()); } catch { /* getter absent on older stacks */ }
  if (users === null || users !== 1) return false; // nobody waiting, or threshold already met
  log(`liquidity bot: 1 trader waited out round ${currentRound} — submitting encrypted counter-order`);
  await botOrder();
  return true;
}

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const currentRound = Number(await readBatch.currentRound());
    for (const [label, step] of [
      ['close', () => maybeCloseRound()],
      ['prepare', () => maybePrepareSettle(currentRound - 1)],
      ['execute', () => maybeExecuteSettle(currentRound - 1)],
      ['credit', () => maybeCreditOrders(currentRound - 1)],
      ['finalize-unwraps', () => finalizePendingUnwraps()],
      ['liquidity-bot', () => maybeCounterparty()],
    ]) {
      if (currentRound - 1 < 1 && label !== 'close' && label !== 'finalize-unwraps' && label !== 'liquidity-bot') continue;
      try { await step(); } catch (error) {
        log(`${label}: ${String(error.message?.shortMessage || error.message || error).slice(0, 120)}`);
      }
    }
  } catch (error) {
    log(`tick error: ${String(error.message?.message || error.message || error).slice(0, 160)}`);
  } finally {
    ticking = false;
  }
}

async function main() {
  log(`keeper ${keeper.address} starting — batch ${config.batch}`);
  log(`tx RPC: ${RPC.slice(0, 40)}… | logs RPC: ${LOGS_RPC}`);
  for (let attempt = 1; ; attempt++) {
    try {
      fhevm = await createInstance({ ...SepoliaConfig, network: RPC });
      break;
    } catch (error) {
      log(`FHEVM instance attempt ${attempt} failed (${String(error.message).slice(0, 60)}) — retrying in 5s`);
      if (attempt >= 10) throw error;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  log('FHEVM instance ready');
  for (;;) {
    await tick();
    await new Promise((r) => setTimeout(r, INTERVAL));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
