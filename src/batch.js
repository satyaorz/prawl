/**
 * Veil — minimal confidential swap UI.
 *
 * One screen: balances, an encrypted order (direction + amount), done.
 * Funding/wrap happens automatically inside the swap button when the vault
 * balance is short; payouts are credited back to the vault by the keeper;
 * "Withdraw" exits to plain tokens (a public leg by design).
 */

import { BrowserProvider, Contract, Interface, JsonRpcProvider, formatUnits, getAddress, parseUnits, hexlify } from 'ethers';

const SEPOLIA_CHAIN_ID = 11155111n;
const RELAYER_SDK_URL = 'https://cdn.zama.org/relayer-sdk-js/0.4.0/relayer-sdk-js.umd.cjs';
const RELAYER_SDK_INTEGRITY = 'sha384-d7nXd4gIttpUf2+vxutKvSBeTFtLklJGWBRO0X2f5s7gW1kHOETmSaRfFvZ7GWEd';

const $ = (id) => document.getElementById(id);
const el = (id) => {
  const node = $(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node;
};

const engineLog = [];
function appendEngineLog(kind, message) {
  engineLog.unshift({ at: new Date().toISOString(), kind, message });
  if (engineLog.length > 120) engineLog.pop();
  try { localStorage.setItem('veil.batch.engineLog.v2', JSON.stringify(engineLog)); } catch {}
  const list = el('engineLogList');
  list.innerHTML = '';
  for (const entry of engineLog.slice(0, 60)) {
    const row = document.createElement('div');
    row.className = 'engine-log-line';
    const time = document.createElement('span');
    time.className = 'engine-log-time';
    time.textContent = entry.at.slice(11, 19);
    const text = document.createElement('span');
    text.textContent = `${entry.kind}: ${entry.message}`;
    row.append(time, text);
    list.append(row);
  }
}

// ---------------------------------------------------------------------------
// State, providers, wallet
// ---------------------------------------------------------------------------
const state = {
  account: null,
  browserProvider: null,
  readProvider: null,
  fhevm: null,
  config: null,
  direction: 1, // 1 = vUSD→vETH, 2 = vETH→vUSD
  funded: [null, null], // decrypted vault balances in c-units
  pollTimer: null,
};

function readProvider() {
  if (!state.readProvider) {
    state.readProvider = new JsonRpcProvider(new URL('/rpc', window.location.href).href, SEPOLIA_CHAIN_ID, { staticNetwork: true });
  }
  return state.readProvider;
}

function writeProvider() {
  if (!state.account) throw new Error('Connect wallet first.');
  if (!state.browserProvider) state.browserProvider = new BrowserProvider(window.ethereum, 'any');
  return state.browserProvider;
}

function requireConfig() {
  if (!state.config) throw new Error('Deployed stack not loaded yet.');
  return state.config;
}

function batchContract(provider) {
  const config = requireConfig();
  return new Contract(config.batch, new Interface([
    'function VERSION() view returns (uint256)',
    'function currentRound() view returns (uint256)',
    'function lastUpdateTime() view returns (uint256)',
    'function fundedBalance(address,uint8) view returns (bytes32)',
    'function submitOrder(bytes32,bytes,bytes32,bytes)',
    'function exit(uint8,bytes32,bytes)',
    'event OrderSubmitted(uint256 indexed round, address indexed user)',
  ]), provider);
}

function underlyingContract(which, provider) {
  const config = requireConfig();
  return new Contract(which === 'A' ? config.tokenA : config.tokenB, new Interface([
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address,address) view returns (uint256)',
    'function approve(address,uint256) returns (bool)',
  ]), provider);
}

function wrapperContract(which, provider) {
  const config = requireConfig();
  return new Contract(which === 'A' ? config.cTokenA : config.cTokenB, new Interface([
    'function wrap(address,uint256)',
    'function rate() view returns (uint256)',
    'function confidentialTransferAndCall(address,bytes32,bytes,bytes)',
  ]), provider);
}

function shorten(address) {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : '—';
}

function setStatus(text, kind = '') {
  const node = el('status');
  node.textContent = text;
  node.className = `status ${kind}`;
}

async function connectWallet() {
  if (!window.ethereum) { setStatus('MetaMask not detected.', 'err'); return; }
  const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
  state.account = getAddress(accounts[0]); // EIP-55 — the FHEVM SDK requires it
  state.browserProvider = new BrowserProvider(window.ethereum, 'any');
  const network = await state.browserProvider.getNetwork();
  if (network.chainId !== SEPOLIA_CHAIN_ID) { setStatus('Wrong network — switch to Sepolia.', 'err'); return; }
  el('connectBtn').textContent = shorten(state.account);
  el('connectBtn').classList.add('ok');
  el('swapBtn').disabled = false;
  appendEngineLog('wallet', `connected ${state.account}`);
  await getFhevm();
  await refreshAll();
  state.pollTimer = state.pollTimer || setInterval(() => refreshAll().catch(() => {}), 10000);
}

window.ethereum?.on?.('accountsChanged', (accounts) => {
  state.account = accounts[0] ? getAddress(accounts[0]) : null;
  state.browserProvider = null;
  state.funded = [null, null];
  el('connectBtn').textContent = state.account ? shorten(state.account) : 'Connect';
  el('connectBtn').classList.toggle('ok', !!state.account);
  if (state.account) refreshAll().catch(() => {});
});

// ---------------------------------------------------------------------------
// Tx helpers (raw EIP-1193; retries ride out async FHE input-proof checks)
// ---------------------------------------------------------------------------
async function sendTx(label, txRequest) {
  const from = state.account;
  appendEngineLog('tx', `${label}: requesting signature`);
  const hash = await window.ethereum.request({ method: 'eth_sendTransaction', params: [{ from, ...txRequest }] });
  appendEngineLog('tx', `${label}: broadcast ${hash}`);
  const receipt = await readProvider().waitForTransaction(hash);
  if (receipt.status !== 1) throw new Error(`${label} reverted: ${hash}`);
  appendEngineLog('tx', `${label}: mined in block ${receipt.blockNumber}`);
  return receipt;
}

async function sendTxWithInputRetry(label, txRequest, attempts = 6) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await sendTx(label, txRequest);
    } catch (error) {
      lastError = error;
      if (!/reverted/i.test(String(error.message))) throw error;
      appendEngineLog('tx', `${label}: reverted — FHE input proof not yet verified; retry ${i + 1}/${attempts - 1} in 12s`);
      setStatus(`Retrying ${label} (FHE input verification pending)…`);
      await new Promise((r) => setTimeout(r, 12000));
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// FHEVM instance (relayer SDK from CDN) + user decryption
// ---------------------------------------------------------------------------
let sdkReady = null;

function loadRelayerSdk() {
  if (window.relayerSDK) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = RELAYER_SDK_URL;
    script.async = true;
    script.integrity = RELAYER_SDK_INTEGRITY;
    script.crossOrigin = 'anonymous';
    script.addEventListener('load', () => resolve());
    script.addEventListener('error', () => reject(new Error('Relayer SDK failed to load')));
    document.head.append(script);
  });
}

async function getFhevm() {
  if (state.fhevm) return state.fhevm;
  if (!sdkReady) {
    sdkReady = (async () => {
      appendEngineLog('sdk', 'loading Zama relayer SDK…');
      await loadRelayerSdk();
      const ok = await window.relayerSDK.initSDK();
      if (!ok) throw new Error('initSDK failed');
      return true;
    })();
  }
  await sdkReady;
  const sdk = window.relayerSDK;
  const instance = await sdk.createInstance({
    ...sdk.SepoliaConfig,
    network: window.ethereum ?? new URL('/rpc', window.location.href).href,
  });
  state.fhevm = instance;
  appendEngineLog('sdk', 'FHEVM instance ready');
  return instance;
}

let decryptSig = null;
async function userDecryptEuint(handle, contractAddress) {
  const instance = await getFhevm();
  if (!decryptSig) {
    const signer = await writeProvider().getSigner();
    const keypair = instance.generateKeypair();
    const config = requireConfig();
    const contractAddresses = [config.batch, config.cTokenA, config.cTokenB];
    const startTimestamp = Math.floor(Date.now() / 1000);
    const durationDays = 365;
    const eip712 = instance.createEIP712(keypair.publicKey, contractAddresses, startTimestamp, durationDays);
    const signature = await signer.signTypedData(
      eip712.domain,
      { UserDecryptRequestVerification: eip712.types.UserDecryptRequestVerification },
      eip712.message,
    );
    decryptSig = { privateKey: keypair.privateKey, publicKey: keypair.publicKey, signature, contractAddresses, startTimestamp, durationDays, userAddress: state.account };
    appendEngineLog('sdk', 'user-decrypt EIP-712 signature cached (365d)');
  }
  const results = await instance.userDecrypt(
    [{ handle: hexlify(handle), contractAddress }],
    decryptSig.privateKey, decryptSig.publicKey, decryptSig.signature,
    decryptSig.contractAddresses, decryptSig.userAddress, decryptSig.startTimestamp, decryptSig.durationDays,
  );
  return results[hexlify(handle)];
}

// ---------------------------------------------------------------------------
// Config + balances
// ---------------------------------------------------------------------------
async function loadConfig() {
  let config = null;
  try {
    const response = await fetch('/batch-config');
    if (response.ok) config = await response.json();
  } catch {}
  state.config = config?.deployed ? config : null;
  if (state.config) {
    try {
      const version = await (await batchContract(readProvider())).VERSION();
      state.config.compatible = version === 3n;
    } catch { state.config.compatible = false; }
  }
  if (!state.config) setStatus('No deployed stack found — run the deploy script.', 'err');
  else if (!state.config.compatible) setStatus('Deployed contract is an older version — redeploy required.', 'err');
}

async function refreshAll() {
  if (!state.config) return;
  await readBalances();
  await renderRoundLine();
}

async function readBalances() {
  const config = requireConfig();
  if (state.account) {
    const signer = await writeProvider().getSigner();
    const a = underlyingContract('A', signer);
    const b = underlyingContract('B', signer);
    el('balA').textContent = `${formatUnits(await a.balanceOf(state.account), 18)} vUSD`;
    el('balB').textContent = `${formatUnits(await b.balanceOf(state.account), 18)} vETH`;
    const batch = batchContract(readProvider());
    for (const [asset, nodeId] of [[0, 'balCA'], [1, 'balCB']]) {
      try {
        const handle = await batch.fundedBalance(state.account, asset);
        const value = handle === 0n ? 0n : await userDecryptEuint(handle, config.batch);
        state.funded[asset] = value;
        el(nodeId).textContent = formatUnits(value, 6);
      } catch (error) {
        appendEngineLog('sdk', `vault balance ${asset}: ${String(error.message).slice(0, 60)}`);
      }
    }
  }
}

async function renderRoundLine() {
  const batch = batchContract(readProvider());
  const current = Number(await batch.currentRound());
  const round = current - 1;
  if (round < 1) { el('roundLine').textContent = `batch round ${current} open`; return; }
  const r = await (await batchContract(readProvider())).rounds(round);
  const lastUpdate = Number(await batch.lastUpdateTime());
  const duration = Number(state.config.minRoundDuration ?? 60);
  const closesIn = Math.max(0, lastUpdate + duration - Math.floor(Date.now() / 1000));
  const state_ = r.executed ? 'settled — payouts credited' : r.prepared ? 'swapping on Uniswap…' : r.closed ? 'decrypting totals…' : `open — closes in ${closesIn}s`;
  el('roundLine').textContent = `round ${round}: ${state_}`;
}

// ---------------------------------------------------------------------------
// Private swap — auto-fund if needed, then submit the encrypted order
// ---------------------------------------------------------------------------
async function privateSwap() {
  const config = requireConfig();
  if (!state.account) { setStatus('Connect wallet first.', 'err'); return; }
  const amount = parseUnits(el('amount').value || '0', 6);
  if (amount <= 0n) { setStatus('Enter an amount.', 'err'); return; }
  el('swapBtn').disabled = true;
  try {
    const which = state.direction === 1 ? 'A' : 'B'; // asset being sold
    const asset = which === 'A' ? 0 : 1;
    const have = state.funded[asset] ?? 0n;
    if (have < amount) {
      setStatus('Funding your confidential balance…');
      await fundVault(which, amount);
    }
    setStatus('Encrypting order (direction + amount)…');
    const instance = await getFhevm();
    const enc = await instance.createEncryptedInput(config.batch, state.account).add64(amount).add8(state.direction).encrypt();
    setStatus('Submitting encrypted order…');
    await sendTxWithInputRetry('encrypted order', {
      to: config.batch,
      data: batchContract(await writeProvider().getSigner()).interface.encodeFunctionData('submitOrder', [enc.handles[0], enc.inputProof, enc.handles[1], enc.inputProof]),
    });
    el('amount').value = '';
    setStatus('Order submitted ✓ — the batch settles automatically and your payout lands in your vault balance.', 'ok');
    appendEngineLog('flow', `order submitted (direction and amount encrypted)`);
    await refreshAll();
  } catch (error) {
    setStatus(String(error.message?.shortMessage || error.message).slice(0, 160), 'err');
    appendEngineLog('error', String(error.message?.shortMessage || error.message).slice(0, 160));
  } finally {
    el('swapBtn').disabled = false;
  }
}

/** Wrap underlying → c-tokens and move them into the batch vault (public leg). */
async function fundVault(which, cAmount) {
  const config = requireConfig();
  const signer = await writeProvider().getSigner();
  const wrapper = wrapperContract(which, signer);
  const wrapperAddress = await wrapper.getAddress();
  const underlying = underlyingContract(which, signer);
  const rate = await wrapper.rate();
  const uAmount = cAmount * rate;
  const balance = await underlying.balanceOf(state.account);
  if (balance < uAmount) {
    // testnet faucet — the deployed mocks expose mint to anyone
    setStatus(`Minting testnet ${which === 'A' ? 'vUSD' : 'vETH'}…`);
    await sendTx(`faucet ${which === 'A' ? 'vUSD' : 'vETH'}`, {
      to: await underlying.getAddress(),
      data: underlying.interface.encodeFunctionData('mint', [state.account, uAmount * 2n - balance]),
    });
  }
  const allowance = await underlying.allowance(state.account, wrapperAddress);
  if (allowance < uAmount) {
    await sendTx(`approve ${which === 'A' ? 'vUSD' : 'vETH'}`, {
      to: await underlying.getAddress(),
      data: underlying.interface.encodeFunctionData('approve', [wrapperAddress, uAmount * 10n]),
    });
  }
  await sendTx(`wrap ${which === 'A' ? 'vUSD' : 'vETH'}`, {
    to: wrapperAddress,
    data: wrapper.interface.encodeFunctionData('wrap', [state.account, uAmount]),
  });
  const enc = await getFhevm().then((i) => i.createEncryptedInput(wrapperAddress, state.account).add64(cAmount).encrypt());
  await sendTxWithInputRetry('fund vault', {
    to: wrapperAddress,
    data: wrapper.interface.encodeFunctionData('confidentialTransferAndCall', [config.batch, enc.handles[0], enc.inputProof, '0x00']),
  });
  appendEngineLog('flow', `vault funded (public funding leg — amount visible by design)`);
}

/** Exit: unwrap the whole vault balance of one asset to plain tokens. */
async function exitVault(asset) {
  const config = requireConfig();
  const have = state.funded[asset];
  if (!state.account) { setStatus('Connect wallet first.', 'err'); return; }
  if (!have || have === 0n) { setStatus('Nothing in the vault for this token.', 'err'); return; }
  try {
    setStatus('Requesting withdrawal…');
    const instance = await getFhevm();
    const enc = await instance.createEncryptedInput(config.batch, state.account).add64(have).encrypt();
    await sendTxWithInputRetry('withdraw', {
      to: config.batch,
      data: batchContract(await writeProvider().getSigner()).interface.encodeFunctionData('exit', [asset, enc.handles[0], enc.inputProof]),
    });
    setStatus('Withdrawal queued — plain tokens arrive after the unwrap finalizes (a minute or two).', 'ok');
    await refreshAll();
  } catch (error) {
    setStatus(String(error.message?.shortMessage || error.message).slice(0, 160), 'err');
  }
}

// ---------------------------------------------------------------------------
// Wire-up
// ---------------------------------------------------------------------------
el('connectBtn').addEventListener('click', () => connectWallet().catch((e) => setStatus(String(e.message).slice(0, 160), 'err')));
el('swapBtn').addEventListener('click', privateSwap);
el('exitA').addEventListener('click', () => exitVault(0));
el('exitB').addEventListener('click', () => exitVault(1));
el('dirAB').addEventListener('click', () => { state.direction = 1; el('dirAB').classList.add('on'); el('dirBA').classList.remove('on'); });
el('dirBA').addEventListener('click', () => { state.direction = 2; el('dirBA').classList.add('on'); el('dirAB').classList.remove('on'); });

loadConfig()
  .then(() => { if (state.config?.compatible) setStatus('Connect your wallet to swap privately.'); })
  .catch((error) => setStatus(String(error.message).slice(0, 160), 'err'));
appendEngineLog('boot', 'Veil minimal UI loaded');
