/**
 * Veil — confidential batch swap dapp (FHE + Uniswap v4, Sepolia).
 *
 * Three tabs:
 *   Trade        — wrap, deposit encrypted intents, withdraw pro-rata payouts
 *   Transparency — on-chain round ledger, privacy matrix, raw ciphertext handles
 *   Operator     — deploy the stack, faucet, keeper (close + settle), treasury
 *
 * Everything shown in the Transparency tab is read straight from Sepolia.
 */

import { BrowserProvider, Contract, Interface, JsonRpcProvider, formatUnits, getAddress, parseUnits, hexlify, toBeHex, zeroPadValue } from 'ethers';

const SEPOLIA_CHAIN_ID = 11155111n;
const RELAYER_SDK_URL = 'https://cdn.zama.org/relayer-sdk-js/0.4.0/relayer-sdk-js.umd.cjs';
const RELAYER_SDK_INTEGRITY = 'sha384-d7nXd4gIttpUf2+vxutKvSBeTFtLklJGWBRO0X2f5s7gW1kHOETmSaRfFvZ7GWEd';

const $ = (id) => document.getElementById(id);
const el = (id) => {
  const node = $(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node;
};

// ---------------------------------------------------------------------------
// Engine log — every SDK call, RPC round-trip and tx, newest first.
// ---------------------------------------------------------------------------
const engineLog = [];
function appendEngineLog(kind, message, detail = null) {
  const entry = {
    at: new Date().toISOString(),
    kind,
    message,
    detail: detail ? (typeof detail === 'string' ? detail : JSON.stringify(detail)) : null,
  };
  engineLog.unshift(entry);
  if (engineLog.length > 200) engineLog.pop();
  try { localStorage.setItem('veil.batch.engineLog.v1', JSON.stringify(engineLog)); } catch {}
  renderEngineLog();
}

function renderEngineLog() {
  const list = el('engineLogList');
  list.innerHTML = '';
  for (const entry of engineLog.slice(0, 80)) {
    const row = document.createElement('div');
    row.className = `engine-log-entry kind-${entry.kind}`;
    const head = document.createElement('div');
    head.className = 'engine-log-line';
    const time = document.createElement('span');
    time.className = 'engine-log-time';
    time.textContent = entry.at.slice(11, 23);
    const kind = document.createElement('span');
    kind.className = `pill pill-${entry.kind}`;
    kind.textContent = entry.kind;
    const text = document.createElement('span');
    text.className = 'engine-log-text';
    text.textContent = entry.message;
    head.append(time, kind, text);
    row.append(head);
    if (entry.detail) {
      const pre = document.createElement('pre');
      pre.className = 'engine-log-detail';
      pre.textContent = entry.detail.length > 500 ? `${entry.detail.slice(0, 500)}…` : entry.detail;
      row.append(pre);
    }
    list.append(row);
  }
  el('engineLogCount').textContent = `${engineLog.length} events`;
}

try {
  const restored = JSON.parse(localStorage.getItem('veil.batch.engineLog.v1') || '[]');
  if (Array.isArray(restored)) engineLog.push(...restored.slice(0, 200));
} catch {}
el('clearEngineLog').addEventListener('click', () => {
  engineLog.length = 0;
  localStorage.removeItem('veil.batch.engineLog.v1');
  renderEngineLog();
});

// ---------------------------------------------------------------------------
// Toasts + inline status lines
// ---------------------------------------------------------------------------
function toast(message, kind = 'info') {
  const node = document.createElement('div');
  node.className = `toast toast-${kind}`;
  node.textContent = message;
  el('toastStack').append(node);
  setTimeout(() => node.remove(), 6000);
}

function setStatus(id, message, kind = 'info') {
  const node = el(id);
  node.textContent = message || '';
  node.className = `status ${kind}`;
}

// ---------------------------------------------------------------------------
// Wallet + read-only RPC
// ---------------------------------------------------------------------------
const state = {
  account: null,
  browserProvider: null,
  readProvider: null,
  fhevm: null,
  config: null,       // deployed batch stack (server-persisted)
  direction: 1,       // 1 = A→B, 2 = B→A
  autoKeeperTimer: null,
};
let legacyLogRangeWarningShown = false;

function readProvider() {
  if (!state.readProvider) {
    // ethers v6 rejects relative URLs (UNSUPPORTED_OPERATION) — always absolutize.
    state.readProvider = new JsonRpcProvider(new URL('/rpc', window.location.href).href, SEPOLIA_CHAIN_ID, { staticNetwork: true });
    appendEngineLog('rpc', 'Read-only JSON-RPC provider ready (via /rpc proxy)');
  }
  return state.readProvider;
}

function writeProvider() {
  if (!state.account) throw new Error('Connect MetaMask first.');
  if (!state.browserProvider) state.browserProvider = new BrowserProvider(window.ethereum, 'any');
  return state.browserProvider;
}

async function connectWallet() {
  if (!window.ethereum) {
    toast('MetaMask not detected. Install it to use this demo.', 'error');
    return;
  }
  const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
  // The FHEVM SDK requires EIP-55 checksummed addresses; MetaMask returns lowercase.
  state.account = getAddress(accounts[0]);
  state.browserProvider = new BrowserProvider(window.ethereum, 'any');
  const network = await state.browserProvider.getNetwork();
  appendEngineLog('wallet', `Connected ${state.account} (chainId ${network.chainId})`);
  if (network.chainId !== SEPOLIA_CHAIN_ID) {
    toast('Wrong network — switch MetaMask to Sepolia.', 'error');
    el('chainBadge').textContent = `wrong chain ${network.chainId}`;
    return;
  }
  el('chainBadge').textContent = 'Sepolia ✓';
  el('connectBtn').textContent = shorten(state.account);
  await afterConnect();
}

function shorten(address) {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : '—';
}

window.ethereum?.on?.('accountsChanged', (accounts) => {
  // MetaMask returns lowercase here too — keep it checksummed for the FHEVM SDK.
  state.account = accounts[0] ? getAddress(accounts[0]) : null;
  decryptSig = null;
  state.browserProvider = null;
  if (!state.account) {
    el('connectBtn').textContent = 'Connect wallet';
    el('chainBadge').textContent = '—';
  } else {
    el('connectBtn').textContent = shorten(state.account);
    afterConnect().catch((error) => appendEngineLog('error', `Reconnect failed: ${error.message}`));
  }
});

async function sendTx(label, txRequest) {
  if (!window.ethereum || typeof window.ethereum.request !== 'function') {
    throw new Error('MetaMask (EIP-1193 provider) not available.');
  }
  const from = state.account;
  appendEngineLog('tx', `${label}: requesting signature`, { from, ...txRequest });
  // The raw EIP-1193 provider carries .request; the ethers BrowserProvider
  // wrapper only exposes .send — never mix them up here.
  const hash = await window.ethereum.request({ method: 'eth_sendTransaction', params: [{ from, ...txRequest }] });
  appendEngineLog('tx', `${label}: broadcast ${hash}`);
  const receipt = await readProvider().waitForTransaction(hash);
  if (receipt.status !== 1) throw new Error(`${label} reverted: ${hash}`);
  appendEngineLog('tx', `${label}: mined in block ${receipt.blockNumber} (gas ${receipt.gasUsed})`, { hash });
  return { hash, receipt };
}

// FHEVM input proofs are verified by the coprocessor ASYNCHRONOUSLY — a
// deposit sent within seconds of encrypting can revert on-chain simply
// because the ZK input proof is not yet verified (the identical call then
// succeeds on replay). The reverted tx leaves balances untouched, so a
// time-backed retry is safe and matches the gateway-decrypt retry pattern.
async function sendTxWithInputRetry(label, txRequest, attempts = 6) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await sendTx(label, txRequest);
    } catch (error) {
      lastError = error;
      if (!/reverted/i.test(String(error.message))) throw error;
      appendEngineLog('tx', `${label}: reverted — FHE input proof likely not yet coprocessor-verified; retry ${i + 1}/${attempts - 1} in 12s`);
      await new Promise((r) => setTimeout(r, 12000));
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// FHEVM instance (Zama relayer SDK from CDN, Sepolia config)
// ---------------------------------------------------------------------------
let sdkReady = null;

function loadRelayerSdk() {
  if (window.relayerSDK) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${RELAYER_SDK_URL}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('Relayer SDK script failed to load')));
      return;
    }
    const script = document.createElement('script');
    script.src = RELAYER_SDK_URL;
    script.async = true;
    script.integrity = RELAYER_SDK_INTEGRITY;
    script.crossOrigin = 'anonymous';
    script.addEventListener('load', () => resolve());
    script.addEventListener('error', () => reject(new Error('Relayer SDK script failed to load')));
    document.head.append(script);
  });
}

async function publicKeyCache(aclAddress) {
  // Cache the FHEVM public key/params in localStorage (base64) to skip a
  // gateway round-trip on repeat visits. Same idea as CipherLend's IDB store.
  const key = `veil.batch.fhevmPub.${aclAddress}`;
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw);
  } catch {}
  return null;
}

async function publicKeyCacheSave(aclAddress, value) {
  try {
    localStorage.setItem(`veil.batch.fhevmPub.${aclAddress}`, JSON.stringify(value));
  } catch {}
}

async function getFhevm() {
  if (state.fhevm) return state.fhevm;
  if (!sdkReady) {
    sdkReady = (async () => {
      appendEngineLog('sdk', 'Loading Zama relayer SDK from CDN…');
      await loadRelayerSdk();
      appendEngineLog('sdk', 'Relayer SDK loaded, calling initSDK()');
      const ok = await window.relayerSDK.initSDK();
      if (!ok) throw new Error('relayerSDK.initSDK() failed');
      return true;
    })();
  }
  await sdkReady;
  const sdk = window.relayerSDK;
  const acl = sdk.SepoliaConfig.aclContractAddress;
  appendEngineLog('sdk', `Creating FHEVM instance (Sepolia, ACL ${acl})`);
  const cached = await publicKeyCache(acl);
  const config = {
    ...sdk.SepoliaConfig,
    // MetaMask when present; otherwise the page's read-only RPC proxy so
    // publicDecrypt (transparency) works without any wallet connected.
    network: window.ethereum ?? new URL('/rpc', window.location.href).href,
    publicKey: cached?.publicKey,
    publicParams: cached?.publicParams ?? undefined,
  };
  const instance = await sdk.createInstance(config);
  const pk = instance.getPublicKey();
  const params = instance.getPublicParams(2048);
  await publicKeyCacheSave(acl, {
    publicKey: pk ? { publicKeyId: pk.publicKeyId, publicKey: toB64(pk.publicKey) } : null,
    publicParams: params ? { publicParamsId: params.publicParamsId, publicParams: toB64(params.publicParams) } : null,
  });
  // Restore as real byte arrays for this session.
  if (cached?.publicKey) config.publicKey = { publicKeyId: cached.publicKey.publicKeyId, publicKey: fromB64(cached.publicKey.publicKey) };
  state.fhevm = instance;
  appendEngineLog('sdk', 'FHEVM instance ready — encrypted inputs, userDecrypt and publicDecrypt available');
  return instance;
}

function toB64(bytes) {
  let binary = '';
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function fromB64(b64) {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// Deployed-stack config (server-persisted, localStorage fallback)
// ---------------------------------------------------------------------------
async function loadConfig() {
  let config = null;
  try {
    const response = await fetch('/batch-config');
    if (response.ok) config = await response.json();
  } catch {}
  if (!config?.deployed) {
    try { config = JSON.parse(localStorage.getItem('veil.batch.config') || 'null'); } catch {}
  }
  state.config = config?.deployed ? config : null;
  if (state.config) {
    try {
      const deployedVersion = await (await batchContract(readProvider())).VERSION();
      state.config.compatible = deployedVersion === 2n;
    } catch {
      state.config.compatible = false;
    }
  }
  renderDeployInfo();
  return state.config;
}

async function saveConfig(config) {
  state.config = config;
  localStorage.setItem('veil.batch.config', JSON.stringify(config));
  try {
    const response = await fetch('/batch-config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(config),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      appendEngineLog('warn', `Server config persist failed: ${body.error || response.status} (kept in localStorage)`);
    } else {
      appendEngineLog('config', 'Deployment published to server — visible to all visitors');
    }
  } catch (error) {
    appendEngineLog('warn', `Server config persist failed: ${error.message}`);
  }
  renderDeployInfo();
}

function renderDeployInfo() {
  const box = el('deployInfo');
  if (!state.config) {
    box.innerHTML = '<span class="muted">No batch stack deployed yet. Deploy below, or trade once someone else has deployed.</span>';
    return;
  }
  if (state.config.compatible === false) {
    box.innerHTML = `<span class="pill pill-warn">Old contract version</span><p>This saved deployment predates the stored slippage bound and zero/overflow deposit checks. Deploy a new batch stack to use the updated contract. Existing c-token balances remain in the old stack.</p><a href="${explorer(state.config.batch)}" target="_blank" rel="noreferrer">Old batch contract ↗</a>`;
    return;
  }
  const c = state.config;
  box.innerHTML = `
    <div class="kv"><span>VeilBatchSwap</span><a href="${explorer(c.batch)}" target="_blank" rel="noreferrer">${shorten(c.batch)}</a></div>
    <div class="kv"><span>c-vUSD (wrapper of vUSD)</span><a href="${explorer(c.cTokenA)}" target="_blank" rel="noreferrer">${shorten(c.cTokenA)}</a></div>
    <div class="kv"><span>c-vETH (wrapper of vETH)</span><a href="${explorer(c.cTokenB)}" target="_blank" rel="noreferrer">${shorten(c.cTokenB)}</a></div>
    <div class="kv"><span>vUSD underlying</span><a href="${explorer(c.tokenA)}" target="_blank" rel="noreferrer">${shorten(c.tokenA)}</a></div>
    <div class="kv"><span>vETH underlying</span><a href="${explorer(c.tokenB)}" target="_blank" rel="noreferrer">${shorten(c.tokenB)}</a></div>
    <div class="kv"><span>Deployed by</span><span>${c.deployedBy ? shorten(c.deployedBy) : 'unknown'} at ${String(c.deployedAt || '').slice(0, 19).replace('T', ' ')}</span></div>`;
}

function explorer(address) {
  return `https://sepolia.etherscan.io/address/${address}`;
}
function explorerTx(hash) {
  return `https://sepolia.etherscan.io/tx/${hash}`;
}

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------
const artifactCache = new Map();

async function artifact(name) {
  if (!artifactCache.has(name)) {
    const response = await fetch(`/protocol-artifacts/${name}.json`);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `Artifact ${name} unavailable (${response.status})`);
    }
    const json = await response.json();
    artifactCache.set(name, json);
    appendEngineLog('rpc', `Loaded artifact ${name} (${json.abi.length} ABI entries)`);
  }
  return artifactCache.get(name);
}

function requireConfig() {
  if (!state.config) throw new Error('Batch stack not deployed yet — use the Operator tab.');
  return state.config;
}

// Deployed stacks differ: older batches return a 12-field rounds() struct
// (no minSwapOutput), newer ones return 13. The artifact ABI matches the
// newest compile, so read adaptively to stay compatible with both.
const ROUNDS_LEGACY_IF = new Interface([
  'function rounds(uint256) view returns (bytes32 aToB, bytes32 bToA, bool closed, bool prepared, bool executed, bool aWasSurplus, uint64 totalAIn, uint64 totalBIn, uint64 matched, uint64 netSwapped, bytes32 unwrapHandle, uint64 swapOutput)',
]);
const roundsLegacyCache = new Map();
async function getRoundInfo(batch, roundId) {
  const address = (await batch.getAddress()).toLowerCase();
  if (roundsLegacyCache.get(address) === false) return batch.rounds(roundId);
  try {
    const r = await batch.rounds(roundId);
    roundsLegacyCache.set(address, false);
    return r;
  } catch (error) {
    if (!/could not decode|missing data|invalid/i.test(String(error.message))) throw error;
    roundsLegacyCache.set(address, true);
    const data = ROUNDS_LEGACY_IF.encodeFunctionData('rounds', [roundId]);
    const res = await readProvider().call({ to: address, data });
    const parsed = ROUNDS_LEGACY_IF.decodeFunctionResult('rounds', res);
    const [aToB, bToA, closed, prepared, executed, aWasSurplus, totalAIn, totalBIn, matched, netSwapped, unwrapHandle, swapOutput] = parsed;
    return { aToB, bToA, closed, prepared, executed, aWasSurplus, totalAIn, totalBIn, matched, netSwapped, unwrapHandle, swapOutput, minSwapOutput: 0n };
  }
}

async function batchContract(signerOrProvider) {
  const config = requireConfig();
  const { abi } = await artifact('VeilBatchSwap');
  return new Contract(config.batch, abi, signerOrProvider);
}

async function wrapperContract(which, signerOrProvider) {
  const config = requireConfig();
  const { abi } = await artifact('VeilConfidentialWrapper');
  const address = which === 'A' ? config.cTokenA : config.cTokenB;
  return new Contract(address, abi, signerOrProvider);
}

function underlyingContract(which, signerOrProvider) {
  const config = requireConfig();
  const abi = [
    'function balanceOf(address) view returns (uint256)',
    'function mint(address to, uint256 amount)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
    'function allowance(address owner, address spender) view returns (uint256)',
  ];
  const address = which === 'A' ? state.config.tokenA : state.config.tokenB;
  return new Contract(address, abi, signerOrProvider);
}

// ---------------------------------------------------------------------------
// Operator: deploy the batch stack through MetaMask
// ---------------------------------------------------------------------------
async function deployStack() {
  if (state.config) {
    const ok = confirm(`A batch stack is already deployed at ${state.config.batch}.\nDeploying a NEW stack orphans the old one (existing rounds and c-token balances become unreachable).\n\nDeploy a fresh stack anyway?`);
    if (!ok) { setStatus('deployStatus', 'Deploy cancelled — existing stack kept.', 'warn'); return; }
  }
  const signer = await writeProvider().getSigner();
  setStatus('deployStatus', 'Compiling artifacts…');
  const [wrapperArt, batchArt] = await Promise.all([artifact('VeilConfidentialWrapper'), artifact('VeilBatchSwap')]);

  // Underlying demo tokens come from the RAILGUN demo pool setup.
  let tokens = null;
  try { tokens = JSON.parse(localStorage.getItem('veil.sepolia.demoPool') || 'null'); } catch {}
  if (!tokens?.usd?.address || !tokens?.eth?.address) {
    throw new Error('Demo tokens not found. Open the main Veil page once and run "Load demo pool" first (deploys vUSD/vETH).');
  }

  const tokenA = tokens.usd.address;
  const tokenB = tokens.eth.address;
  appendEngineLog('deploy', `Deploying batch stack for vUSD ${tokenA} / vETH ${tokenB}`);

  let latestDeploymentBlock = null;
  const deploy = async (label, bytecode, abiEncodedArgs) => {
    setStatus('deployStatus', `Deploying ${label}…`);
    const data = bytecode + abiEncodedArgs.replace(/^0x/i, '');
    const { hash, receipt } = await sendTx(label, { data });
    const address = receipt.contractAddress;
    latestDeploymentBlock = receipt.blockNumber;
    appendEngineLog('deploy', `${label} deployed at ${address}`);
    return address;
  };

  const encodeAddress = (address) => zeroPadValue(address.toLowerCase(), 32);

  const cTokenA = await deploy('c-vUSD wrapper', wrapperArt.bytecode, encodeAddress(tokenA));
  const cTokenB = await deploy('c-vETH wrapper', wrapperArt.bytecode, encodeAddress(tokenB));

  // PoolKey: sorted currencies, zero hooks, fee 3000, spacing 60 (matches the demo pool).
  const [currency0, currency1] = [tokenA, tokenB].map(a => a.toLowerCase()).sort();
  const poolKeyTuple = [currency0, currency1, '0x0000000000000000000000000000000000000000', 3000, 60];
  const poolKeyEncoding = encodeAddress(currency0) + encodeAddress(currency1)
    + encodeAddress('0x0000000000000000000000000000000000000000')
    + zeroPadValue(toBeHex(3000), 32).slice(2) + zeroPadValue(toBeHex(60), 32).slice(2);

  const minRound = Math.max(1, Number(el('cfgMinRound').value || 60));
  const minUsers = Math.max(2, Number(el('cfgMinUsers').value || 2));

  const UNIVERSAL_ROUTER = '0x3a9d48ab9751398bbfa63ad67599bb04e4bdf98b';
  const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

  const batchArgs = encodeAddress(UNIVERSAL_ROUTER) + encodeAddress(PERMIT2)
    + encodeAddress(cTokenA) + encodeAddress(cTokenB)
    + poolKeyEncoding
    + zeroPadValue(toBeHex(minRound), 32).slice(2)
    + zeroPadValue(toBeHex(minUsers), 32).slice(2)
    + encodeAddress(state.account);

  const batch = await deploy('VeilBatchSwap', batchArt.bytecode, batchArgs);

  const config = {
    chainId: 11155111,
    deployed: true,
    protocolVersion: 2,
    batch,
    cTokenA,
    cTokenB,
    tokenA,
    tokenB,
    poolKey: { currency0, currency1, hooks: '0x0000000000000000000000000000000000000000', fee: 3000, tickSpacing: 60 },
    deployedBy: state.account,
    settler: state.account,
    deployedBlock: latestDeploymentBlock,
    deployedAt: new Date().toISOString(),
  };
  await saveConfig(config);
  setStatus('deployStatus', `Deployed ✓ batch ${shorten(batch)} (min round ${minRound}s, min users ${minUsers})`, 'ok');
  toast('Batch stack deployed', 'ok');
  await refreshAll();
}

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------
async function readBalances() {
  const config = requireConfig();
  const provider = state.account ? writeProvider() : readProvider();
  const rows = [];
  for (const which of ['A', 'B']) {
    const underlying = underlyingContract(which, provider);
    const wrapper = await wrapperContract(which, provider);
    const [symbol, decimals] = await Promise.all([underlying.symbol(), underlying.decimals()]);
    const walletBalance = state.account ? await underlying.balanceOf(state.account) : 0n;
    let confidential = null;
    if (state.account) {
      try {
        const handle = await wrapper.confidentialBalanceOf(state.account);
        // A zero handle means the account has never held this c-token —
        // there is nothing to decrypt (the gateway rejects 0x00…0 handles).
        if (handle && handle !== '0x' + '0'.repeat(64) && handle !== 0n) {
          confidential = await userDecryptEuint(handle, await wrapper.getAddress());
        } else {
          confidential = 0n;
        }
      } catch (error) {
        appendEngineLog('warn', `Confidential balance decrypt failed (${which}): ${error.message}`);
      }
    }
    rows.push({ which, symbol, decimals, walletBalance, confidential });
  }
  renderBalances(rows);
  return rows;
}

function renderBalances(rows) {
  const tbody = el('balanceTable').querySelector('tbody');
  tbody.innerHTML = '';
  for (const row of rows) {
    const tr = document.createElement('tr');
    const conf = row.confidential === null || row.confidential === undefined
      ? '<span class="muted">—</span>'
      : formatUnits(row.confidential, 6);
    tr.innerHTML = `<td>${row.symbol} / c${row.symbol}</td><td>${formatUnits(row.walletBalance, row.decimals)}</td><td>${conf} <span class="muted">(6 dp)</span></td>`;
    tbody.append(tr);
  }
}

// ---------------------------------------------------------------------------
// User decryption (EIP-712 signed, cached per contract set)
// ---------------------------------------------------------------------------
let decryptSig = null;

async function getDecryptSignature(instance) {
  if (decryptSig) return decryptSig;
  const config = requireConfig();
  const signer = await writeProvider().getSigner();
  const keypair = instance.generateKeypair();
  const contractAddresses = [config.batch, config.cTokenA, config.cTokenB];
  const startTimestamp = Math.floor(Date.now() / 1000);
  const durationDays = 365;
  const eip712 = instance.createEIP712(keypair.publicKey, contractAddresses, startTimestamp, durationDays);
  appendEngineLog('sdk', 'Signing FHEVM user-decrypt EIP-712 request (valid 365 days)');
  const signature = await signer.signTypedData(
    eip712.domain,
    { UserDecryptRequestVerification: eip712.types.UserDecryptRequestVerification },
    eip712.message,
  );
  decryptSig = {
    privateKey: keypair.privateKey,
    publicKey: keypair.publicKey,
    signature,
    contractAddresses,
    startTimestamp,
    durationDays,
    userAddress: state.account,
  };
  return decryptSig;
}

async function userDecryptEuint(handle, contractAddress) {
  if (!state.account) throw new Error('Connect wallet to decrypt your own values.');
  const instance = await getFhevm();
  const sig = await getDecryptSignature(instance);
  const results = await instance.userDecrypt(
    [{ handle: hexlify(handle), contractAddress }],
    sig.privateKey,
    sig.publicKey,
    sig.signature,
    sig.contractAddresses,
    sig.userAddress,
    sig.startTimestamp,
    sig.durationDays,
  );
  const value = results[hexlify(handle)];
  appendEngineLog('sdk', `userDecrypt ${String(hexlify(handle)).slice(0, 12)}… → ${value}`);
  return value;
}

// ---------------------------------------------------------------------------
// Wrap / unwrap
// ---------------------------------------------------------------------------
async function wrapTokens() {
  const which = el('wrapToken').value;
  const amount = parseUnits(el('wrapAmount').value || '0', 18);
  if (amount <= 0n) throw new Error('Enter an amount to wrap.');
  const underlying = underlyingContract(which, await writeProvider().getSigner());
  const wrapper = await wrapperContract(which, await writeProvider().getSigner());
  const wrapperAddress = await wrapper.getAddress();
  // Skip the approve when the wrapper already has enough allowance — a
  // reload during the receipt wait used to leave users stuck here.
  const allowance = await underlying.allowance(state.account, wrapperAddress);
  if (allowance < amount) {
    await sendTx(`approve ${which === 'A' ? 'vUSD' : 'vETH'}`, {
      to: await underlying.getAddress(),
      data: underlying.interface.encodeFunctionData('approve', [wrapperAddress, amount]),
    });
  }
  await sendTx(`wrap → c${which === 'A' ? 'vUSD' : 'vETH'}`, {
    to: wrapperAddress,
    data: wrapper.interface.encodeFunctionData('wrap', [state.account, amount]),
  });
  setStatus('wrapStatus', 'Wrapped ✓ confidential balance updated', 'ok');
  await readBalances();
}

async function unwrapTokens() {
  const which = el('wrapToken').value;
  // Unwrap takes an ENCRYPTED amount: we encrypt the c-token amount (6 dp).
  const amount = parseUnits(el('wrapAmount').value || '0', 6);
  if (amount <= 0n) throw new Error('Enter a c-token amount to unwrap.');
  const instance = await getFhevm();
  const wrapper = await wrapperContract(which, await writeProvider().getSigner());
  const wrapperAddress = await wrapper.getAddress();
  // Resume support: an unwrap request that already burned c-tokens is pending
  // finalize — never burn twice for the same intent. Check the chain first
  // (source of truth), then the local record.
  const pendingKey = `veil.batch.pendingUnwrap.${wrapperAddress}`;
  let pending = null;
  try { pending = JSON.parse(localStorage.getItem(pendingKey) || 'null'); } catch {}
  let unwrapHandle;
  const liveHandle = await findPendingUnwrap(wrapper, state.account);
  if (liveHandle) {
    unwrapHandle = liveHandle;
    appendEngineLog('sdk', `Resuming PENDING unwrap request found on-chain: ${unwrapHandle} (c-tokens already burned — finalizing instead of burning again).`);
  } else if (pending?.handle) {
    unwrapHandle = pending.handle;
    appendEngineLog('sdk', `Resuming pending unwrap request ${unwrapHandle} (c-tokens already burned).`);
  } else {
    const enc = await instance.createEncryptedInput(wrapperAddress, state.account).add64(amount).encrypt();
    const { receipt } = await sendTx(`unwrap c${which === 'A' ? 'vUSD' : 'vETH'}`, {
      to: wrapperAddress,
      data: wrapper.interface.encodeFunctionData('unwrap(address,address,bytes32,bytes)', [
        state.account, state.account, enc.handles[0], enc.inputProof,
      ]),
    });
    // The OZ wrapper's unwrap is ASYNCHRONOUS: the request must be finalized
    // with a gateway proof before the underlying tokens actually move.
    unwrapHandle = null;
    for (const log of receipt.logs) {
      try {
        const ev = wrapper.interface.parseLog({ topics: [...log.topics], data: log.data });
        if (ev?.name === 'UnwrapRequested') { unwrapHandle = hexlify(ev.args[1] ?? ev.args.amount); break; }
      } catch {}
    }
    if (!unwrapHandle) throw new Error('UnwrapRequested event not found in receipt.');
    try { localStorage.setItem(pendingKey, JSON.stringify({ handle: unwrapHandle, at: Date.now() })); } catch {}
  }
  setStatus('wrapStatus', 'Unwrap requested — decrypting request for finalize…');
  const dec = await publicDecryptWithRetry(instance, [unwrapHandle], 'unwrap request');
  const cleartext = clearValue(dec, unwrapHandle);
  appendEngineLog('sdk', `Unwrap request ${unwrapHandle} decrypted: ${cleartext}`);
  await sendTx(`finalize unwrap c${which === 'A' ? 'vUSD' : 'vETH'}`, {
    to: wrapperAddress,
    data: wrapper.interface.encodeFunctionData('finalizeUnwrap(bytes32,uint64,bytes)', [unwrapHandle, cleartext, dec.decryptionProof]),
  });
  try { localStorage.removeItem(pendingKey); } catch {}
  setStatus('wrapStatus', 'Unwrapped ✓ underlying tokens transferred', 'ok');
  await readBalances();
}

// ---------------------------------------------------------------------------
// Faucet
// ---------------------------------------------------------------------------
async function faucet() {
  const config = requireConfig();
  const signer = await writeProvider().getSigner();
  for (const which of ['A', 'B']) {
    const token = underlyingContract(which, signer);
    const symbol = await token.symbol();
    await sendTx(`faucet mint ${symbol}`, {
      to: await token.getAddress(),
      data: token.interface.encodeFunctionData('mint', [state.account, parseUnits('10', 18)]),
    });
  }
  setStatus('balanceStatus', 'Faucet minted 10 vUSD + 10 vETH ✓', 'ok');
  await readBalances();
}

// ---------------------------------------------------------------------------
// Deposit an encrypted intent into the current round
// ---------------------------------------------------------------------------
async function depositIntent() {
  const config = requireConfig();
  const amount = parseUnits(el('depositAmount').value || '0', 6); // c-token units, 6 dp
  if (amount <= 0n) throw new Error('Enter a deposit amount.');
  if (amount > 2n ** 64n - 1n) throw new Error('Amount exceeds euint64 range.');
  const which = state.direction === 1 ? 'A' : 'B';
  const wrapper = await wrapperContract(which, await writeProvider().getSigner());
  const wrapperAddress = await wrapper.getAddress();
  const batchAddress = config.batch;

  // Preflight: a zero confidential balance makes the transfer revert on-chain —
  // block it here with an actionable message instead of burning gas.
  const handle = await wrapper.confidentialBalanceOf(state.account);
  if (!handle || handle === '0x' + '0'.repeat(64) || handle === 0n) {
    throw new Error(`No ${which === 'A' ? 'c-vUSD' : 'c-vETH'} balance — wrap ${which === 'A' ? 'vUSD' : 'vETH'} first (Wrap section above), then deposit.`);
  }
  const available = BigInt(await userDecryptEuint(handle, wrapperAddress));
  if (amount > available) {
    throw new Error(`Insufficient confidential balance: you have ${formatUnits(available, 6)} ${which === 'A' ? 'c-vUSD' : 'c-vETH'} available.`);
  }

  setStatus('depositStatus', 'Encrypting amount client-side…');
  const instance = await getFhevm();
  const enc = await instance.createEncryptedInput(wrapperAddress, state.account).add64(amount).encrypt();
  appendEngineLog('sdk', `Encrypted deposit: handle ${hexlify(enc.handles[0])} (value hidden; ${enc.inputProof.length / 2 - 1}B ZK proof)`);

  const data = state.direction === 1 ? '0x01' : '0x02';
  setStatus('depositStatus', 'Requesting signature…');
  await sendTxWithInputRetry(`deposit ${state.direction === 1 ? 'vUSD→vETH' : 'vETH→vUSD'}`, {
    to: wrapperAddress,
    data: wrapper.interface.encodeFunctionData('confidentialTransferAndCall(address,bytes32,bytes,bytes)', [
      batchAddress, enc.handles[0], enc.inputProof, data,
    ]),
  });
  const afterRows = await readBalances();
  const afterBalance = afterRows.find(row => row.which === which)?.confidential;
  if (afterBalance !== available - amount) {
    setStatus('depositStatus', 'The confidential token wrapper refunded this deposit; no order was added. Check the balance and amount, then retry.', 'error');
    await refreshAll();
    return;
  }
  setStatus('depositStatus', `Deposited into round — amount stays encrypted until close ✓`, 'ok');
  el('depositExplain').innerHTML = `
    <b>What just happened on-chain:</b> a ${state.direction === 1 ? 'c-vUSD' : 'c-vETH'} <code>confidentialTransferAndCall</code> to the batcher.
    The amount ciphertext is owned by the batcher; the deposit event shows <i>your address, the round, and the direction</i> — never the size.
    Refresh <b>Transparency</b> to see it.`;
  await refreshAll();
}

// ---------------------------------------------------------------------------
// Batch lifecycle timeline (renders the round's journey on one screen)
// ---------------------------------------------------------------------------
function timelineStep(index, activeIndex, icon, label, sub) {
  const cls = index < activeIndex ? 'done' : index === activeIndex ? 'active' : 'waiting';
  return `<div class="tl-step ${cls}"><span class="tl-ico">${icon}</span>${label}${sub ? `<br><span style="font-size:10px">${sub}</span>` : ''}</div>`;
}

async function renderTimeline() {
  const host = el('lifecycleTimeline');
  if (!requireConfig() || !state.account) { host.innerHTML = ''; return; }
  try {
    const batch = await batchContract(readProvider());
    const currentRound = Number(await batch.currentRound());
    const round = await getRoundInfo(batch, currentRound);
    const lastRound = currentRound >= 1 ? await getRoundInfo(batch, currentRound - 1) : null;
    const lastExecuted = lastRound && lastRound.executed && lastRound.netSwapped > 0n ? lastRound : null;

    // Stage 0 is always visible: the open batch.
    const stages = [];
    const elapsed = Number(await batch.lastUpdateTime());
    const minDur = Number(requireConfig().minRoundDuration ?? 60);
    const remain = Math.max(0, elapsed + minDur - Math.floor(Date.now() / 1000));
    let users = null;
    try { users = Number(await batch.distinctSubmitters()); } catch { /* getter absent on older stacks */ }
    stages.push(timelineStep(0, round.closed ? 5 : 0, '📥', 'Batch open',
      round.closed ? 'closed' : `${users ?? '—'} traders · closes in ${remain}s`));
    stages.push(timelineStep(1, round.closed ? 5 : 0, '🔒', 'Closed', round.closed ? 'round ' + currentRound : ''));
    stages.push(timelineStep(2, round.closed ? (round.prepared ? 5 : 3) : 0, '🔓', 'Decrypting', round.prepared ? 'totals verified' : 'gateway proof'));
    stages.push(timelineStep(3, round.closed ? (round.executed ? 5 : 4) : 0, '🔁', 'Uniswap swap', lastExecuted ? `last rate ${formatUnits((lastExecuted.swapOutput * 10n ** 18n) / lastExecuted.netSwapped, 18).slice(0, 6)}` : ''));
    const myDone = lastExecuted ? await batch.withdrawn(currentRound - 1, state.direction, state.account) : false;
    stages.push(timelineStep(4, round.executed ? (myDone ? 5 : 4) : 0, '💸', 'Payout', round.executed ? (myDone ? 'withdrawn ✓' : 'withdraw ready') : ''));

    host.innerHTML = stages.join('');
  } catch (error) {
    host.innerHTML = '';
  }
}

// ---------------------------------------------------------------------------
// Live quote: last executed round's realized rate, honest about batching
// ---------------------------------------------------------------------------
async function updateQuote() {
  const line = el('quoteLine');
  if (!requireConfig()) return;
  try {
    const batch = await batchContract(readProvider());
    const currentRound = Number(await batch.currentRound());
    let rate = null;
    for (let roundId = currentRound - 1; roundId >= 1 && rate === null; roundId--) {
      const r = await getRoundInfo(batch, roundId);
      if (r.executed && r.netSwapped > 0n) rate = (r.swapOutput * 10n ** 18n) / r.netSwapped;
    }
    const amount = parseUnits(el('depositAmount').value || '0', 6);
    const youGive = state.direction === 1 ? 'vUSD' : 'vETH';
    const youGet = state.direction === 1 ? 'vETH' : 'vUSD';
    if (rate === null) {
      line.innerHTML = `No batch has executed yet — first settlement sets the rate. Batches settle every ~${requireConfig().minRoundDuration ?? 60}s once ≥${2} traders deposit.`;
      return;
    }
    const estimate = amount > 0n ? ` · <b>≈ ${formatUnits((amount * rate) / 10n ** 18n, 6)} ${youGet}</b>` : '';
    line.innerHTML = `Quote: <b>1 ${youGive} ≈ ${formatUnits(rate, 18).slice(0, 8)} ${youGet}</b>${estimate} <span style="opacity:.75">(last batch rate · ±5% slippage guard · your amount stays encrypted)</span>`;
  } catch (error) {
    // quote is best-effort
  }
}

// ---------------------------------------------------------------------------
// One-click swap: approve + wrap + deposit in ONE signature (EIP-5792)
// with a sequential fallback for wallets without atomic batching.
// ---------------------------------------------------------------------------
function chainIdHex() {
  return toBeHex(requireConfig().chainId ?? 11155111);
}

async function atomicBatchingAvailable() {
  if (!window.ethereum || typeof window.ethereum.request !== 'function') return false;
  try {
    const caps = await window.ethereum.request({ method: 'wallet_getCapabilities', params: [state.account, [chainIdHex()]] });
    const atomic = caps?.[chainIdHex()]?.atomic;
    const status = atomic?.status;
    appendEngineLog('sdk', `EIP-5792 capability probe: atomic.status=${status ?? 'absent'} (supported=${!!atomic?.supported})`);
    return !!atomic && (status === 'ready' || status === 'supported');
  } catch (error) {
    appendEngineLog('sdk', `EIP-5792 not available (${String(error.message).slice(0, 60)}) — using sequential fallback`);
    return false;
  }
}

async function sendCallsAtomic(label, calls) {
  const params = [{ version: '2.0.0', chainId: chainIdHex(), from: state.account, atomicRequired: true, calls }];
  appendEngineLog('tx', `${label}: ONE signature for ${calls.length} calls (wallet_sendCalls)`, { calls: calls.map((c) => c.to) });
  const raw = await window.ethereum.request({ method: 'wallet_sendCalls', params });
  appendEngineLog('tx', `${label}: wallet_sendCalls returned ${typeof raw}: ${(() => { try { return JSON.stringify(raw).slice(0, 300); } catch { return String(raw); } })()}`);
  // EIP-5792 says the return is a string id, but some wallets (MetaMask
  // included, depending on version) wrap it in an object — normalize.
  const id = typeof raw === 'string' ? raw : raw?.id ?? raw?.batchId ?? raw?.capabilities?.id ?? null;

  // The batch may execute even when the wallet's status API is unusable, so
  // every exit path below falls back to verifying the deposit on-chain.
  const verifyOnChain = async (why) => {
    appendEngineLog('tx', `${label}: ${why} — verifying the deposit on-chain (up to 90s)…`);
    const config = requireConfig();
    const batch = await batchContract(readProvider());
    const roundId = Number(await batch.currentRound());
    const topic = batch.interface.getEvent('DepositSubmitted').topicHash;
    const paddedUser = zeroPadValue(state.account.toLowerCase(), 32);
    const deadline = Date.now() + Number(window.__veilOnChainVerifyMs ?? 90000);
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5000));
      try {
        const head = await readProvider().getBlockNumber();
        const logs = await readProvider().send('eth_getLogs', [{
          fromBlock: '0x' + Math.max(0, head - 200).toString(16),
          toBlock: 'latest',
          address: config.batch,
          topics: [topic, null, null, paddedUser],
        }]);
        if (logs.length > 0) {
          appendEngineLog('tx', `${label}: deposit CONFIRMED on-chain in block ${logs[logs.length - 1].blockNumber} ✓ (wallet status API was unreliable)`);
          return { confirmedOnChain: true };
        }
      } catch (error) {
        appendEngineLog('tx', `${label}: on-chain check error (${String(error.message).slice(0, 50)}) — retrying`);
      }
    }
    throw new Error(`${label}: no deposit found on-chain after ${Math.round((Date.now() - (deadline - Number(window.__veilOnChainVerifyMs ?? 90000))) / 1000)}s (${why}). Check your wallet activity — the batch may have failed or is still pending.`);
  };

  if (!id || typeof id !== 'string') return verifyOnChain(`wallet returned no usable batch id (${typeof raw})`);
  appendEngineLog('tx', `${label}: batch id ${id} — polling status…`);
  const deadline = Date.now() + 180000;
  let pollErrors = 0;
  for (;;) {
    if (Date.now() > deadline) return verifyOnChain(`batch ${id} still pending after 3 min`);
    await new Promise((r) => setTimeout(r, 2000));
    let status;
    try {
      status = await window.ethereum.request({ method: 'wallet_getCallsStatus', params: [id] });
      pollErrors = 0;
    } catch (error) {
      pollErrors += 1;
      appendEngineLog('tx', `${label}: status poll error (${String(error.message).slice(0, 50)}) — retrying`);
      if (pollErrors >= 10) return verifyOnChain('wallet status API unusable');
      continue;
    }
    const st = status?.status;
    const confirmed = st === 200 || st === 'CONFIRMED';
    const failed = st === 600 || st === 500 || st === 'REVERTED' || st === 'OFFCHAIN_FAILURE';
    if (confirmed) {
      const receipt = status.receipts?.[status.receipts.length - 1];
      appendEngineLog('tx', `${label}: batch CONFIRMED in block ${receipt?.blockNumber ?? '?'} ✓`, { id });
      return { id, receipt };
    }
    if (failed) throw new Error(`${label}: batch reverted (id ${id})`);
  }
}

async function oneClickSwap() {
  const config = requireConfig();
  const cAmount = parseUnits(el('depositAmount').value || '0', 6); // c-token units, 6 dp
  if (cAmount <= 0n) throw new Error('Enter an amount to swap.');
  if (cAmount > 2n ** 64n - 1n) throw new Error('Amount exceeds euint64 range.');
  const which = state.direction === 1 ? 'A' : 'B';
  const underlying = underlyingContract(which, await writeProvider().getSigner());
  const wrapper = await wrapperContract(which, await writeProvider().getSigner());
  const wrapperAddress = await wrapper.getAddress();
  const underlyingAddress = await underlying.getAddress();
  const symbol = which === 'A' ? 'vUSD' : 'vETH';
  // Underlying amounts are 18 dp — NEVER reuse the 6 dp c-token amount here
  // (that bug wrapped 0.00000000001 vUSD instead of 10).
  const rate = BigInt(await wrapper.rate()); // underlying wei per c-token unit
  const uAmount = cAmount * rate; // e.g. 10e6 c-units × 1e12 = 10 vUSD (18 dp)

  // Need the underlying tokens to wrap: mint on demand (testnet faucet).
  let have = BigInt(await underlying.balanceOf(state.account));
  const calls = [];
  if (have < uAmount) {
    calls.push({ to: underlyingAddress, data: underlying.interface.encodeFunctionData('mint', [state.account, uAmount * 2n]), value: '0x0' });
    appendEngineLog('tx', `One-click: insufficient ${symbol} — faucet mint included in the batch`);
    have = uAmount * 2n;
  }
  calls.push({ to: underlyingAddress, data: underlying.interface.encodeFunctionData('approve', [wrapperAddress, uAmount]), value: '0x0' });
  calls.push({ to: wrapperAddress, data: wrapper.interface.encodeFunctionData('wrap', [state.account, uAmount]), value: '0x0' });

  // Encrypt client-side — the FHE input binds to the wrapper address, which is
  // exactly why we batch at the wallet level (msg.sender stays the user) and
  // not through a Multicall contract.
  setStatus('depositStatus', 'Encrypting amount client-side…');
  const instance = await getFhevm();
  const enc = await instance.createEncryptedInput(wrapperAddress, state.account).add64(cAmount).encrypt();
  appendEngineLog('sdk', `Encrypted deposit: handle ${hexlify(enc.handles[0])} (${enc.inputProof.length / 2 - 1}B ZK proof)`);
  const data = state.direction === 1 ? '0x01' : '0x02';
  calls.push({
    to: wrapperAddress,
    data: wrapper.interface.encodeFunctionData('confidentialTransferAndCall(address,bytes32,bytes,bytes)', [
      config.batch, enc.handles[0], enc.inputProof, data,
    ]),
    value: '0x0',
  });

  const label = `One-click swap ${formatUnits(cAmount, 6)} c${symbol} → batch`;
  let mode = 'sequential';
  // EIP-5792 atomic batching is EXPERIMENTAL here: under MetaMask's 7702
  // delegation we observed a valid encrypted deposit being rejected by the
  // batch's FHE acceptance check (refunded), which silently loses the wrap.
  // Until that is root-caused, sequential signing is the default — every step
  // of it is proven on this deployment. Set window.veilAtomicBatching = true
  // to opt back in.
  if (window.veilAtomicBatching === true && await atomicBatchingAvailable()) {
    mode = 'atomic';
    await sendCallsAtomic(label, calls);
  } else {
    setStatus('depositStatus', 'Wallet lacks atomic batching — signing sequentially…');
    for (let i = 0; i < calls.length; i++) {
      const kind = i === 0 && calls.length === 4 ? `faucet mint ${symbol}` : i === (calls[0].to === underlyingAddress && calls.length === 4 ? 1 : 0) ? `approve ${symbol}` : i === calls.length - 1 ? 'deposit (encrypted)' : `wrap ${symbol}`;
      const req = { to: calls[i].to, data: calls[i].data };
      if (i === calls.length - 1) await sendTxWithInputRetry(`one-click ${kind}`, req);
      else await sendTx(`one-click ${kind}`, req);
    }
  }
  setStatus('depositStatus', `Deposited into round ${mode === 'atomic' ? 'in ONE signature ⚡' : '(sequential mode)'} — encrypted until close ✓`, 'ok');
  el('depositExplain').innerHTML = `<b>One-click swap:</b> ${calls.length} calls${mode === 'atomic' ? ' executed atomically via EIP-5792 <code>wallet_sendCalls</code>' : ' executed sequentially'} — faucet (if needed), approve, wrap, encrypted deposit. Your amount never appears in the clear on-chain.`;
  await refreshAll();
}

// ---------------------------------------------------------------------------
// My positions + withdraw
// ---------------------------------------------------------------------------
async function loadPositions() {
  const config = requireConfig();
  const tbody = el('positionsTable').querySelector('tbody');
  tbody.innerHTML = '';
  if (!state.account) {
    tbody.innerHTML = '<tr><td colspan="5" class="muted">Connect wallet…</td></tr>';
    return;
  }
  const batch = await batchContract(readProvider());
  const currentRound = Number(await batch.currentRound());
  const rows = [];
  for (let roundId = 1; roundId <= currentRound; roundId += 1) {
    for (const direction of [1, 2]) {
      const handle = await batch.userDeposits(roundId, direction, state.account);
      if (handle === 0n || handle === '0x0000000000000000000000000000000000000000000000000000000000000000') continue;
      let amount = null;
      try {
        amount = await userDecryptEuint(handle, config.batch);
      } catch (error) {
        appendEngineLog('warn', `Position decrypt failed r${roundId}d${direction}: ${error.message}`);
      }
      if (amount === 0n) continue;
      const withdrawn = await batch.withdrawn(roundId, direction, state.account);
      const round = await getRoundInfo(batch, roundId);
      rows.push({ roundId, direction, amount, withdrawn, round });
    }
  }
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="muted">No deposits yet.</td></tr>';
    return;
  }
  for (const row of rows) {
    const tr = document.createElement('tr');
    const status = row.withdrawn
      ? '<span class="pill pill-ok">withdrawn</span>'
      : row.round.executed
        ? '<span class="pill pill-ok">settled — claim</span>'
        : row.round.closed
          ? '<span class="pill pill-warn">closed, awaiting settle</span>'
          : '<span class="pill pill-info">open</span>';
    tr.innerHTML = `
      <td>${row.roundId}</td>
      <td>${row.direction === 1 ? 'vUSD→vETH' : 'vETH→vUSD'}</td>
      <td>${row.amount === null ? '<span class="muted">encrypted</span>' : formatUnits(row.amount, 6)}</td>
      <td>${status}</td>
      <td>${row.round.executed && !row.withdrawn ? `<button class="btn btn-small" data-withdraw="${row.roundId}:${row.direction}">Withdraw</button>` : ''}</td>`;
    tbody.append(tr);
  }
  tbody.querySelectorAll('[data-withdraw]').forEach((button) => {
    button.addEventListener('click', () => withdraw(button.dataset.withdraw).catch((error) => {
      setStatus('positionsStatus', error.message, 'error');
      appendEngineLog('error', `Withdraw failed: ${error.message}`);
    }));
  });
}

async function withdraw(key) {
  const [roundId, direction] = key.split(':').map(Number);
  const batch = await batchContract(await writeProvider().getSigner());
  await sendTx(`withdraw round ${roundId}`, {
    to: requireConfig().batch,
    data: batch.interface.encodeFunctionData('withdraw', [roundId, direction]),
  });
  setStatus('positionsStatus', `Withdrew pro-rata payout from round ${roundId} ✓`, 'ok');
  await refreshAll();
}

// ---------------------------------------------------------------------------
// Transparency: privacy matrix
// ---------------------------------------------------------------------------
function renderPrivacyMatrix() {
  const config = state.config;
  const rows = [
    ['Your deposit amount', 'Private · FHE', 'euint64 ciphertext in userDeposits[round][direction][you]', 'Only you (userDecrypt with your EIP-712 signature). The batcher computes on ciphertexts.', 'Raw handle shown in Round detail; decryptable only with your key'],
    ['Aggregate round totals', 'Public after close', 'rounds[round].aToB / bToA → makePubliclyDecryptable at closeRound()', 'Anyone, via the Zama Gateway', 'publicDecrypt of the handles below; proof verified on-chain by FHE.checkSignatures'],
    ['Matched / net / AMM output', 'Public after settle', 'RoundSettled event + rounds[round] storage', 'Anyone', 'Emit + Etherscan event log'],
    ['That you attempted to participate, and direction', 'Public', 'DepositSubmitted(round, direction, you) event', 'Anyone', 'Etherscan event log'],
    ['Individual amounts inside the aggregate', 'Private · FHE', 'Netting and pro-rata calculations use ciphertexts', 'The depositor can decrypt their own balance; the settlement operator sees aggregate totals after close', 'No on-chain method publishes an individual amount'],
    ['Your payout amount', 'Private until you claim', 'euint64 share computed under encryption at withdraw()', 'Only you', 'userDecrypt of your c-token balance'],
    ['Settlement decryption proofs', 'Public', 'prepareSettle + executeSettle calldata', 'Anyone', 'FHE.checkSignatures reverts on forgery — a settled round implies valid proofs'],
    ['Keeper gas identity', 'Public', 'settlement tx `from`', 'Anyone', 'Etherscan tx sender'],
    ['Uniswap leg', 'Public', 'Universal Router swap of the net residual only', 'Anyone (this is the design: hide sizes in the crowd, not the trade)', 'Router tx trace'],
  ];
  const tbody = el('privacyMatrixBody');
  tbody.innerHTML = '';
  for (const [data, visibility, where, who, verify] of rows) {
    const tr = document.createElement('tr');
    const cls = visibility.includes('Private') ? 'pill-ok' : visibility.includes('after') ? 'pill-warn' : 'pill-info';
    tr.innerHTML = `<td><b>${data}</b></td><td><span class="pill ${cls}">${visibility}</span></td><td class="mono">${where}</td><td>${who}</td><td>${verify}</td>`;
    tbody.append(tr);
  }
  if (config) {
    const head = el('privacyMatrix').closest('.card').querySelector('p');
    head.innerHTML = `Stack live at <a href="${explorer(config.batch)}" target="_blank" rel="noreferrer">${shorten(config.batch)}</a>. Every row below is verifiable on Sepolia. "Private · FHE" fields exist only as ciphertext handles; "Public after close" fields become decryptable by anyone through the Zama Gateway once the round is closed — by design, not by accident.`;
  }
}

// ---------------------------------------------------------------------------
// Transparency: round ledger + event feed (pure on-chain reads)
// ---------------------------------------------------------------------------
async function loadLedger() {
  if (!state.config) return;
  const batch = await batchContract(readProvider());
  const currentRound = Number(await batch.currentRound());
  el('statRound').textContent = String(currentRound);
  const minRoundSeconds = Number(await batch.minRoundDuration());
  const minUsers = Number(await batch.minDistinctSubmitters());
  el('statUsersHint').textContent = `minimum submitter addresses ${minUsers}; no privacy guarantee`;
  el('statCountdownHint').textContent = `min round duration ${minRoundSeconds}s`;

  const logs = await readBatchLogs(state.config.batch, state.config.deployedBlock);
  const iface = batch.interface;
  const events = [];
  for (const log of logs) {
    try {
      const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
      events.push({ ...parsed, blockNumber: log.blockNumber, txHash: log.transactionHash });
    } catch {}
  }
  events.sort((a, b) => a.blockNumber - b.blockNumber);
  appendEngineLog('rpc', `Fetched ${logs.length} batcher events from Sepolia`);

  renderEventFeed(events);
  renderRoundLedger(events, currentRound, minRoundSeconds);
}

async function readBatchLogs(address, deploymentBlock) {
  const provider = readProvider();
  const head = await provider.getBlockNumber();
  const hasDeploymentBlock = deploymentBlock != null && Number.isSafeInteger(Number(deploymentBlock)) && Number(deploymentBlock) >= 0;
  const from = hasDeploymentBlock ? Number(deploymentBlock) : Math.max(0, head - 4999);
  if (!hasDeploymentBlock && !legacyLogRangeWarningShown) {
    legacyLogRangeWarningShown = true;
    appendEngineLog('warn', 'This deployment record has no creation block; scanning only the latest 5,000 blocks. Redeploy/publish config to enable complete history.');
  }
  const logs = [];
  for (let start = from; start <= head; start += 4000) {
    const end = Math.min(head, start + 3999);
    logs.push(...await provider.getLogs({ address, fromBlock: start, toBlock: end }));
  }
  return logs;
}

function renderEventFeed(events) {
  const tbody = el('eventFeed').querySelector('tbody');
  tbody.innerHTML = '';
  const recent = [...events].reverse().slice(0, 25);
  if (!recent.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="muted">No events yet.</td></tr>';
    return;
  }
  for (const event of recent) {
    const tr = document.createElement('tr');
    let detail = '';
    if (event.fragment.name === 'DepositSubmitted') detail = `${shorten(event.args.user)} → ${event.args.direction === 1n ? 'vUSD→vETH' : 'vETH→vUSD'} (attempt)`;
    if (event.fragment.name === 'RoundClosed') detail = `totals now publicly decryptable`;
    if (event.fragment.name === 'RoundSettled') detail = `matched ${event.args.matched} · net ${event.args.netSwapped} · out ${event.args.swapOutput}`;
    tr.innerHTML = `<td><span class="pill ${event.fragment.name === 'RoundSettled' ? 'pill-ok' : event.fragment.name === 'RoundClosed' ? 'pill-warn' : 'pill-info'}">${event.fragment.name}</span></td><td>${event.args.round?.toString() ?? '—'}</td><td>${detail}</td><td><a href="${explorerTx(event.txHash)}" target="_blank" rel="noreferrer">${shorten(event.txHash)}</a></td>`;
    tbody.append(tr);
  }
}

function renderRoundLedger(events, currentRound, minRoundSeconds) {
  const tbody = el('roundLedger').querySelector('tbody');
  tbody.innerHTML = '';
  if (currentRound === 1 && !events.some(e => e.fragment.name === 'DepositSubmitted')) {
    tbody.innerHTML = '<tr><td colspan="8" class="muted">No rounds yet — round 1 opens at the first deposit.</td></tr>';
    return;
  }
  const depositsByRound = new Map();
  for (const event of events) {
    if (event.fragment.name !== 'DepositSubmitted') continue;
    const key = event.args.round.toString();
    depositsByRound.set(key, (depositsByRound.get(key) || 0) + 1);
  }
  const settled = new Map();
  for (const event of events) {
    if (event.fragment.name === 'RoundSettled') settled.set(event.args.round.toString(), event.args);
  }
  const closed = new Set(events.filter(e => e.fragment.name === 'RoundClosed').map(e => e.args.round.toString()));

  for (let roundId = 1; roundId <= currentRound; roundId += 1) {
    const key = String(roundId);
    const tr = document.createElement('tr');
    const settle = settled.get(key);
    const deposits = depositsByRound.get(key) || 0;
    const state_ = settle ? '<span class="pill pill-ok">settled</span>' : closed.has(key) ? '<span class="pill pill-warn">closed</span>' : deposits ? '<span class="pill pill-info">open</span>' : '<span class="muted">—</span>';
    tr.innerHTML = `
      <td>${roundId}</td>
      <td>${deposits}</td>
      <td>${closed.has(key) ? '✓' : '—'}</td>
      <td>${settle ? '✓' : '—'}</td>
      <td>${settle ? settle.matched.toString() : '—'}</td>
      <td>${settle ? settle.netSwapped.toString() : '—'}</td>
      <td>${settle ? settle.swapOutput.toString() : '—'}</td>
      <td>${settle ? (settle.aWasSurplus ? 'vUSD' : 'vETH') : state_}</td>`;
    tbody.append(tr);
  }
}

// ---------------------------------------------------------------------------
// Transparency: round detail — raw handles + public decryption
// ---------------------------------------------------------------------------
// The gateway keys clearValues by the exact handle string it was given; look
// the value up tolerantly (case variants) and surface decrypt errors instead
// of printing "undefined".
function fmtClearValue(publicTotals, handle) {
  if (!publicTotals) return '<span class="muted">closed round required</span>';
  if (publicTotals.error) return `<span class="muted">decrypt failed: ${publicTotals.error}</span>`;
  for (const key of [handle, handle.toLowerCase(), handle.toUpperCase()]) {
    if (publicTotals[key] !== undefined) return String(publicTotals[key]);
  }
  return '<span class="muted">not yet decrypted</span>';
}

async function loadRoundDetail() {
  const box = el('roundDetail');
  if (!state.config) {
    box.innerHTML = '<span class="muted">Deploy the stack first.</span>';
    return;
  }
  const roundId = Number(el('detailRound').value || 1);
  const batch = await batchContract(readProvider());
  const round = await getRoundInfo(batch, roundId);
  const handleA = hexlify(round.aToB);
  const handleB = hexlify(round.bToA);

  let publicTotals = null;
  if (round.closed) {
    try {
      const instance = await getFhevm();
      const dec = await instance.publicDecrypt([handleA, handleB]);
      publicTotals = dec.clearValues;
      appendEngineLog('sdk', `publicDecrypt round ${roundId}: aToB=${dec.clearValues[handleA]} bToA=${dec.clearValues[handleB]} (proof ${dec.decryptionProof.slice(0, 18)}…)`);
    } catch (error) {
      publicTotals = { error: error.message };
      appendEngineLog('warn', `publicDecrypt round ${roundId} failed: ${error.message}`);
    }
  }

  const rows = [
    ['closed', String(round.closed)],
    ['executed', String(round.executed)],
    ['aWasSurplus', String(round.aWasSurplus)],
    ['totalAIn (clear, post-settle)', round.totalAIn.toString()],
    ['totalBIn', round.totalBIn.toString()],
    ['matched', round.matched.toString()],
    ['netSwapped', round.netSwapped.toString()],
    ['swapOutput', round.swapOutput.toString()],
    ['ciphertext handle aToB', `<span class="mono">${handleA}</span>`],
    ['ciphertext handle bToA', `<span class="mono">${handleB}</span>`],
    ['decrypted aToB (sum of A→B intents)', fmtClearValue(publicTotals, handleA)],
    ['decrypted bToA', fmtClearValue(publicTotals, handleB)],
  ];
  box.innerHTML = rows.map(([k, v]) => `<div class="kv"><span>${k}</span><span>${v}</span></div>`).join('');
}

// ---------------------------------------------------------------------------
// Operator: keeper — close + settle
// ---------------------------------------------------------------------------
async function closeRound() {
  const batch = await batchContract(await writeProvider().getSigner());
  await sendTx('closeRound', { to: requireConfig().batch, data: batch.interface.encodeFunctionData('closeRound', []) });
  setStatus('keeperStatus', 'Round closed ✓ encrypted totals are now publicly decryptable', 'ok');
  await refreshAll();
}

// The unwrap handle written by prepareSettle. Read it from the RoundPrepared
// event in the receipt when available (MetaMask's RPC can lag our proxy by a
// block, which made a plain re-read return the pre-prepare state); otherwise
// poll the round state until it appears.
async function recoverUnwrapHandle(batch, roundId, prepareReceipt) {
  // Primary source: the RoundPrepared event emitted by our own prepareSettle
  // receipt — immune to read-after-write lag on the user's MetaMask RPC.
  if (prepareReceipt) {
    for (const log of prepareReceipt.logs) {
      try {
        const ev = batch.interface.parseLog({ topics: [...log.topics], data: log.data });
        if (ev?.name === 'RoundPrepared' && ev.args.roundId === BigInt(roundId) && ev.args.unwrapHandle !== 0n) {
          appendEngineLog('sdk', `Unwrap handle from RoundPrepared event: ${hexlify(ev.args.unwrapHandle)}`);
          return hexlify(ev.args.unwrapHandle);
        }
      } catch {}
    }
  }
  // Fallback: poll the round state on the read provider (handles resumed
  // settlements where the receipt is not in hand).
  const readBatch = await batchContract(readProvider());
  for (let attempt = 0; attempt < 10; attempt++) {
    const round = await getRoundInfo(readBatch, roundId);
    if (round.prepared && round.unwrapHandle !== 0n) return hexlify(round.unwrapHandle);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Unwrap handle for round ${roundId} not found on-chain after retries.`);
}

// Find the account's live (un-finalized) unwrap request on a wrapper by
// scanning UnwrapRequested events and checking which handles are still
// registered. This recovers requests whose local record was lost.
async function findPendingUnwrap(wrapper, account) {
  const topic = wrapper.interface.getEvent('UnwrapRequested').topicHash;
  const padded = zeroPadValue(account.toLowerCase(), 32);
  let logs = [];
  try {
    logs = await readProvider().getLogs({ address: await wrapper.getAddress(), fromBlock: 0, toBlock: 'latest', topics: [topic, padded] });
  } catch (error) {
    const head = await readProvider().getBlockNumber();
    const from = '0x' + Math.max(0, head - 20000).toString(16);
    logs = await readProvider().getLogs({ address: await wrapper.getAddress(), fromBlock: from, toBlock: 'latest', topics: [topic, padded] });
  }
  for (const log of logs.reverse()) {
    try {
      const ev = wrapper.interface.parseLog({ topics: [...log.topics], data: log.data });
      const handle = hexlify(ev.args[1] ?? ev.args.amount);
      const requester = await wrapper.unwrapRequester(handle);
      if (requester !== '0x0000000000000000000000000000000000000000') return handle;
    } catch {}
  }
  return null;
}

// publicDecrypt right after a tx often hits the gateway before the handle is
// decryptable ("not allowed for public decryption") — retry with backoff.
async function publicDecryptWithRetry(instance, handles, label = 'decrypt', attempts = 8, delayMs = 4000) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await instance.publicDecrypt(handles);
    } catch (error) {
      lastError = error;
      if (i < attempts - 1) {
        appendEngineLog('sdk', `${label}: gateway not ready — retry ${i + 1}/${attempts - 1} in ${delayMs / 1000}s (${String(error.message).slice(0, 70)}…)`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

// Gateway clearValues are keyed by the handle string — look it up tolerantly
// and never let `undefined` reach the settlement math.
function clearValue(dec, handle) {
  for (const key of [handle, handle.toLowerCase(), handle.toUpperCase()]) {
    if (dec.clearValues?.[key] !== undefined) return BigInt(dec.clearValues[key]);
  }
  throw new Error(`Gateway clearValues missing handle ${String(handle).slice(0, 18)}…`);
}

async function settleRound() {
  const config = requireConfig();
  const batch = await batchContract(await writeProvider().getSigner());
  const roundId = Number(await batch.currentRound()) - 1;
  if (roundId < 1) throw new Error('No closed round to settle.');
  const round = await getRoundInfo(batch, roundId);
  if (!round.closed) throw new Error(`Round ${roundId} is not closed yet — close it first.`);
  if (round.executed) throw new Error(`Round ${roundId} is already settled.`);
  if (!round.prepared) {
    const settler = await batch.settler();
    if (settler.toLowerCase() !== state.account.toLowerCase()) {
      throw new Error(`Only the configured settlement operator (${shorten(settler)}) can commit the output minimum. Connect that account to prepare this round.`);
    }
  }

  const instance = await getFhevm();
  const handleA = hexlify(round.aToB);
  const handleB = hexlify(round.bToA);

  // Phase 1: verify the decrypted totals and open the async unwrap request.
  // Resumable: if a previous attempt already prepared the round, skip straight
  // to phase 2 (re-sending prepareSettle would revert with RoundAlreadySettled).
  let prepareReceipt = null;
  let totalA, totalB;
  let totalsDecryption;
  if (!round.prepared) {
    setStatus('keeperStatus', 'Phase 1/2 — verifying totals and opening unwrap request…');
    const dec = await publicDecryptWithRetry(instance, [handleA, handleB], `round ${roundId} totals`);
    appendEngineLog('sdk', `Gateway decryption for round ${roundId}: aToB=${clearValue(dec, handleA)} bToA=${clearValue(dec, handleB)}`, { proof: dec.decryptionProof });
    totalsDecryption = dec;
    totalA = clearValue(dec, handleA);
    totalB = clearValue(dec, handleB);
  } else {
    appendEngineLog('sdk', `Round ${roundId} already prepared — resuming at phase 2.`);
    const fresh = await getRoundInfo(batch, roundId);
    totalA = fresh.totalAIn;
    totalB = fresh.totalBIn;
  }

  const net = totalA >= totalB ? totalA - totalB : totalB - totalA;

  // Slippage guard: anchor to the latest realized rate, with a parity-based
  // 5% floor for the first round of this 1:1 demo pool.
  let minSwapOutput = 0n;
  for (let prev = roundId - 1; prev >= 1; prev--) {
    const r = await getRoundInfo(batch, prev);
    if (r.executed && r.netSwapped > 0n) {
      const rate18 = (r.swapOutput * 10n ** 18n) / r.netSwapped;
      minSwapOutput = (net * rate18 * 9500n + (10000n * 10n ** 18n - 1n)) / (10000n * 10n ** 18n);
      appendEngineLog('sdk', `Slippage guard anchored to round ${prev}: realized rate ${(Number(rate18) / 1e18).toFixed(6)} → minSwapOutput ${minSwapOutput}`);
      break;
    }
  }
  if (round.prepared) {
    minSwapOutput = round.minSwapOutput;
  } else if (net > 0n && minSwapOutput === 0n) {
    minSwapOutput = (net * 9500n + 9999n) / 10000n;
    appendEngineLog('warn', `No prior swap rate; using the demo pool's 5% first-round minimum (${minSwapOutput}).`);
  }

  if (!round.prepared) {
    ({ receipt: prepareReceipt } = await sendTx(`prepareSettle ${roundId}`, {
      to: config.batch,
      data: batch.interface.encodeFunctionData('prepareSettle', [roundId, totalsDecryption.abiEncodedClearValues, totalsDecryption.decryptionProof, minSwapOutput]),
    }));
  }

  // Phase 2: finalize the unwrap (second gateway proof), swap the net leg.
  if (net > 0n) {
    setStatus('keeperStatus', 'Phase 2/2 — finalizing unwrap and executing the swap leg…');
    const unwrapHandle = await recoverUnwrapHandle(batch, roundId, prepareReceipt);
    const dec2 = await publicDecryptWithRetry(instance, [unwrapHandle], 'unwrap request');
    appendEngineLog('sdk', `Unwrap request decrypted: ${clearValue(dec2, unwrapHandle)}`, { proof: dec2.decryptionProof });
    await sendTx(`executeSettle ${roundId}`, {
      to: config.batch,
      data: batch.interface.encodeFunctionData('executeSettle', [roundId, clearValue(dec2, unwrapHandle), dec2.decryptionProof]),
    });
  } else {
    setStatus('keeperStatus', 'Phase 2/2 — fully matched round, no swap leg…');
    await sendTx(`executeSettle ${roundId}`, {
      to: config.batch,
      data: batch.interface.encodeFunctionData('executeSettle', [roundId, 0, '0x']),
    });
  }

  setStatus('keeperStatus', `Round ${roundId} settled ✓ matched ${totalA < totalB ? totalA : totalB} netted internally, ${net} swapped`, 'ok');
  el('keeperExplain').innerHTML = `
    <b>Settlement trail:</b> the configured operator committed the minimum after <code>prepareSettle</code> checked the gateway proof over the
    encrypted totals and opened the confidential unwrap request; <code>executeSettle</code> finalized the unwrap with a
    second gateway proof, swapped only the net residual on Uniswap v4 and wrapped the output back. Anyone can relay
    <code>publicDecrypt([${handleA.slice(0, 10)}…, ${handleB.slice(0, 10)}…])</code> and compare the clear values
    against the <code>RoundSettled</code> event.`;
  await refreshAll();
}

async function keeperTick() {
  if (!state.config || !state.account) return;
  const batch = await batchContract(readProvider());
  const currentRound = Number(await batch.currentRound());
  const closedRound = currentRound - 1;
  if (closedRound >= 1) {
    const round = await getRoundInfo(batch, closedRound);
    if (round.closed && !round.executed) {
      await settleRound();
      return;
    }
  }
  // try closing when eligible
  const lastUpdate = Number(await batch.lastUpdateTime());
  const minRound = Number(await batch.minRoundDuration());
  const elapsed = Math.floor(Date.now() / 1000) - lastUpdate;
  if (elapsed >= minRound) {
    try {
      await closeRound();
    } catch (error) {
      appendEngineLog('keeper', `Close attempt rejected (expected if thresholds unmet): ${short(error.message)}`);
    }
  }
}

function short(message) {
  return String(message).slice(0, 140);
}

function setAutoKeeper(enabled) {
  if (state.autoKeeperTimer) {
    clearInterval(state.autoKeeperTimer);
    state.autoKeeperTimer = null;
  }
  if (enabled) {
    state.autoKeeperTimer = setInterval(() => keeperTick().catch((error) => {
      appendEngineLog('keeper', `Auto-keeper: ${short(error.message)}`);
    }), 15000);
    appendEngineLog('keeper', 'Auto-keeper started (15s interval)');
  } else {
    appendEngineLog('keeper', 'Auto-keeper stopped');
  }
}

// ---------------------------------------------------------------------------
// Operator: treasury + config
// ---------------------------------------------------------------------------
async function loadTreasury() {
  const tbody = el('treasuryTable').querySelector('tbody');
  const config = state.config;
  if (!config) {
    tbody.innerHTML = '<tr><td colspan="2" class="muted">Deploy the stack first.</td></tr>';
    return;
  }
  const provider = readProvider();
  const rows = [];
  for (const which of ['A', 'B']) {
    const underlying = underlyingContract(which, provider);
    const wrapper = await wrapperContract(which, provider);
    const symbol = await underlying.symbol();
    const underlyingBalance = await underlying.balanceOf(config.batch);
    const confHandle = await wrapper.confidentialBalanceOf(config.batch);
    rows.push([`${symbol} (underlying in batcher)`, formatUnits(underlyingBalance, 18)]);
    rows.push([`c${symbol} float (encrypted handle)`, `<span class="mono">${hexlify(confHandle).slice(0, 26)}…</span>`]);
  }
  const ethBalance = await provider.getBalance(config.batch);
  rows.push(['ETH (gas dust)', formatUnits(ethBalance, 18)]);
  tbody.innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
}

async function loadConfigTable() {
  const tbody = el('configTable').querySelector('tbody');
  const config = state.config;
  if (!config) {
    tbody.innerHTML = '<tr><td colspan="2" class="muted">Deploy the stack first.</td></tr>';
    return;
  }
  const batch = await batchContract(readProvider());
  const [minRound, minUsers, currentRound, router, permit2, cA, cB, settler] = await Promise.all([
    batch.minRoundDuration(), batch.minDistinctSubmitters(), batch.currentRound(), batch.router(), batch.permit2(), batch.cTokenA(), batch.cTokenB(), batch.settler(),
  ]);
  const rows = [
    ['minRoundDuration', `${minRound.toString()}s`],
    ['minimum distinct submitter addresses (not anonymity)', minUsers.toString()],
    ['settlement operator (sets output minimum)', `<a href="${explorer(settler)}" target="_blank" rel="noreferrer">${shorten(settler)}</a>`],
    ['currentRound', currentRound.toString()],
    ['Uniswap v4 Universal Router', `<a href="${explorer(router)}" target="_blank" rel="noreferrer">${shorten(router)}</a>`],
    ['Permit2', `<a href="${explorer(permit2)}" target="_blank" rel="noreferrer">${shorten(permit2)}</a>`],
    ['cTokenA / cTokenB', `<a href="${explorer(cA)}" target="_blank" rel="noreferrer">${shorten(cA)}</a> / <a href="${explorer(cB)}" target="_blank" rel="noreferrer">${shorten(cB)}</a>`],
    ['poolKey (fee/tickSpacing)', `${config.poolKey?.fee ?? '—'} / ${config.poolKey?.tickSpacing ?? '—'}`],
  ];
  tbody.innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
}

// ---------------------------------------------------------------------------
// Countdown + global refresh
// ---------------------------------------------------------------------------
async function refreshStats() {
  if (!state.config) return;
  const batch = await batchContract(readProvider());
  const currentRound = Number(await batch.currentRound());
  const lastUpdate = Number(await batch.lastUpdateTime());
  const minRound = Number(await batch.minRoundDuration());
  const minUsers = Number(await batch.minDistinctSubmitters());
  const elapsed = Math.floor(Date.now() / 1000) - lastUpdate;
  const remaining = Math.max(0, minRound - elapsed);
  el('statCountdown').textContent = currentRound === 1 && lastUpdate === 0 ? '—' : `${remaining}s`;
  el('statRoundHint').textContent = `round ${currentRound}`;
  // distinct users is private-ish (internal counter) — expose what the chain exposes:
  const logs = await readBatchLogs(state.config.batch, state.config.deployedBlock);
  const iface = batch.interface;
  const depositsThisRound = logs.filter((log) => {
    try {
      const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
      return parsed.fragment.name === 'DepositSubmitted' && parsed.args.round.toString() === String(currentRound);
    } catch { return false; }
  });
  const unique = new Set(depositsThisRound.map((log) => log.topics[3].toLowerCase())).size;
  el('statUsers').textContent = String(unique);
  el('statUsersHint').textContent = `minimum distinct submitter addresses ${minUsers}; not an anonymity guarantee`;
}

async function refreshAll() {
  renderPrivacyMatrix();
  if (!state.config) {
    renderDeployInfo();
    return;
  }
  if (state.config.compatible === false) {
    renderDeployInfo();
    return;
  }
  await Promise.allSettled([
    refreshStats(),
    loadLedger(),
    renderTimeline(),
    updateQuote(),
    loadRoundDetail(),
    loadPositions(),
    loadTreasury(),
    loadConfigTable(),
  ]);
  if (state.account) readBalances().catch((error) => appendEngineLog('warn', `Balance refresh: ${error.message}`));
}

async function afterConnect() {
  el('chainBadge').textContent = 'Sepolia ✓';
  await loadConfig();
  await refreshAll();
}

// ---------------------------------------------------------------------------
// Tabs + event wiring
// ---------------------------------------------------------------------------
document.querySelectorAll('#tabs .tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('#tabs .tab').forEach(t => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('hidden', p.id !== `panel-${tab.dataset.tab}`));
  });
});

el('connectBtn').addEventListener('click', () => connectWallet().catch((error) => {
  appendEngineLog('error', `Connect failed: ${error.message}`);
  toast(error.message, 'error');
}));
el('deployBtn').addEventListener('click', () => deployStack().catch((error) => {
  setStatus('deployStatus', error.message, 'error');
  appendEngineLog('error', `Deploy failed: ${error.message}`);
}));
el('loadConfigBtn').addEventListener('click', () => loadConfig().then(refreshAll).catch((error) => toast(error.message, 'error')));
el('faucetBtn').addEventListener('click', () => faucet().catch((error) => {
  setStatus('balanceStatus', error.message, 'error');
  appendEngineLog('error', `Faucet failed: ${error.message}`);
}));
el('refreshBalancesBtn').addEventListener('click', () => readBalances().catch((error) => setStatus('balanceStatus', error.message, 'error')));
el('wrapBtn').addEventListener('click', () => wrapTokens().catch((error) => {
  setStatus('wrapStatus', error.message, 'error');
  appendEngineLog('error', `Wrap failed: ${error.message}`);
}));
el('unwrapBtn').addEventListener('click', () => unwrapTokens().catch((error) => {
  setStatus('wrapStatus', error.message, 'error');
  appendEngineLog('error', `Unwrap failed: ${error.message}`);
}));
el('depositAmount').addEventListener('input', () => updateQuote().catch(() => {}));
el('oneClickBtn').addEventListener('click', () => oneClickSwap().catch((error) => {
  console.error(error);
  setStatus('depositStatus', error.message || String(error), 'error');
  appendEngineLog('error', `one-click swap failed: ${error.message}`);
}));
setInterval(() => { renderTimeline().catch(() => {}); updateQuote().catch(() => {}); }, 10000);

el('depositBtn').addEventListener('click', () => depositIntent().catch((error) => {
  setStatus('depositStatus', error.message, 'error');
  appendEngineLog('error', `Deposit failed: ${error.message}`);
}));
el('maxDepositBtn').addEventListener('click', async () => {
  try {
    const rows = await readBalances();
    const row = rows.find(r => (state.direction === 1 ? r.which === 'A' : r.which === 'B'));
    if (row?.confidential !== null && row?.confidential !== undefined) {
      el('depositAmount').value = formatUnits(row.confidential, 6);
    } else {
      setStatus('depositStatus', 'Decrypt your confidential balance first (connect + sign).', 'error');
    }
  } catch (error) {
    setStatus('depositStatus', error.message, 'error');
  }
});
document.querySelectorAll('#directionToggle .dir-btn').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('#directionToggle .dir-btn').forEach(b => b.classList.toggle('active', b === button));
    state.direction = Number(button.dataset.direction);
    updateQuote().catch(() => {});
  });
});
el('closeRoundBtn').addEventListener('click', () => closeRound().catch((error) => {
  setStatus('keeperStatus', error.message, 'error');
  appendEngineLog('error', `Close failed: ${error.message}`);
}));
el('settleRoundBtn').addEventListener('click', () => settleRound().catch((error) => {
  setStatus('keeperStatus', error.message, 'error');
  appendEngineLog('error', `Settle failed: ${error.message}`);
}));
el('autoKeeper').addEventListener('change', (event) => setAutoKeeper(event.target.checked));
el('loadRoundBtn').addEventListener('click', () => loadRoundDetail().catch((error) => {
  appendEngineLog('error', `Round detail failed: ${error.message}`);
  el('roundDetail').innerHTML = `<span class="mono">${error.message}</span>`;
}));
el('refreshTreasuryBtn').addEventListener('click', () => refreshAll().catch((error) => toast(error.message, 'error')));

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
renderEngineLog();
renderPrivacyMatrix();
loadConfig()
  .then(() => refreshAll())
  .then(() => appendEngineLog('boot', 'Batch swap dapp ready — trade, transparency and operator tabs live'))
  .catch((error) => appendEngineLog('error', `Boot failed: ${error.message}`));
