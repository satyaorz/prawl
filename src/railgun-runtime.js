import * as snarkjs from '../libhelp/node_modules/snarkjs/build/browser.esm.js';
import Level from 'level-js';
import { WakuBroadcasterClient, BroadcasterTransaction } from '@veil/waku-client';
import {
  ChainType,
  EVMGasType,
  NetworkName,
  NETWORK_CONFIG,
  TXIDVersion,
  calculateGasPrice,
} from '@railgun-community/shared-models';
import {
  ArtifactStore,
  calculateBroadcasterFeeERC20Amount,
  createRailgunWallet,
  gasEstimateForUnprovenCrossContractCalls,
  generateCrossContractCallsProof,
  getEngine,
  getFallbackProviderForNetwork,
  loadProvider,
  loadWalletByID,
  populateProvedCrossContractCalls,
  refreshBalances,
  startRailgunEngine,
  awaitWalletScan,
} from '@railgun-community/wallet';
import { Mnemonic, MINIMUM_RELAY_ADAPT_CROSS_CONTRACT_CALLS_GAS_LIMIT_V2 } from '@railgun-community/engine';
import { computeFeeReserve, sizeSwapInput } from './fee-sizing.js';

const DB_NAME = 'veil-railgun-wallet-v1';
const ARTIFACT_DB = 'veil-railgun-artifacts-v1';
// RAILGUN permits only spaces, digits, and lowercase letters here (max 16 chars).
const WALLET_SOURCE = 'veilwallet';
const CHAIN = { type: ChainType.EVM, id: 11155111 };
const NETWORK = NetworkName.EthereumSepolia;
const POI_NODE_URLS = ['https://ppoi.fdi.network'];

let initialized = false;
let initializationPromise;
let broadcasterStatus = 'Not started';
const activeWalletScans = new Map();

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
  });
}

function openArtifactDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(ARTIFACT_DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('files')) {
        request.result.createObjectStore('files');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open artifact storage.'));
  });
}

const artifactStore = {
  async get(path) {
    const db = await openArtifactDatabase();
    try {
      const transaction = db.transaction('files', 'readonly');
      const value = await requestResult(transaction.objectStore('files').get(path));
      if (value == null) throw new Error(`Artifact not found: ${path}`);
      return value;
    } finally {
      db.close();
    }
  },
  async store(_directory, path, item) {
    const db = await openArtifactDatabase();
    try {
      const transaction = db.transaction('files', 'readwrite');
      const value = item instanceof Uint8Array ? item.slice().buffer : item;
      await requestResult(transaction.objectStore('files').put(value, path));
    } finally {
      db.close();
    }
  },
  async exists(path) {
    const db = await openArtifactDatabase();
    try {
      const transaction = db.transaction('files', 'readonly');
      const value = await requestResult(transaction.objectStore('files').getKey(path));
      return value != null;
    } finally {
      db.close();
    }
  },
};

function rpcUrl() {
  return new URL('/rpc', window.location.origin).toString();
}

export function engineLog(level, message) {
  const line = `[${new Date().toLocaleTimeString()}] [${level}] ${message}`;
  (level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log)(line);
  try {
    const entries = JSON.parse(localStorage.getItem('veil.engineLog.v1') || '[]');
    entries.push(line);
    localStorage.setItem('veil.engineLog.v1', JSON.stringify(entries.slice(-400)));
  } catch {}
  document.dispatchEvent(new CustomEvent('veil-engine-log', { detail: line }));
}

function providerConfig() {
  return {
    chainId: CHAIN.id,
    providers: [{
      provider: rpcUrl(),
      priority: 1,
      weight: 2,
      stallTimeout: 5000,
      // Tiny batches make a first Sepolia wallet scan take hours. Alchemy
      // supports much larger eth_getLogs ranges; keep this moderate for RPCs.
      maxLogsPerBatch: 1000,
    }],
  };
}

export async function initializeRailgun(onBroadcasterStatus = () => {}) {
  if (initialized) return { chain: CHAIN, networkName: NETWORK, broadcasterStatus };
  if (initializationPromise) return initializationPromise;

  initializationPromise = (async () => {
    if (!window.indexedDB) throw new Error('This browser does not support IndexedDB, required for private wallet storage.');
    engineLog('INFO', 'Starting RAILGUN engine: IndexedDB wallet store, hash-checked IPFS artifacts, POI node https://ppoi.fdi.network.');
    const db = new Level(DB_NAME);
    // The engine requires an ArtifactStore class instance (it checks instanceof in
    // setArtifactStore during proof loading); a plain object will crash engine start.
    const store = new ArtifactStore(
      async path => {
        try {
          return await artifactStore.get(path);
        } catch (error) {
          engineLog('INFO', `Artifact cache miss: ${path}`);
          return null;
        }
      },
      async (directory, path, item) => {
        await artifactStore.store(directory, path, item);
        engineLog('INFO', `Artifact stored: ${path} (${item?.byteLength ?? item?.length ?? '?'} bytes)`);
      },
      async path => artifactStore.exists(path),
    );
    await startRailgunEngine(
      WALLET_SOURCE,
      db,
      false,
      store,
      false,
      false,
      POI_NODE_URLS,
    );
    getEngine().prover.setSnarkJSGroth16(snarkjs.groth16);

    await loadProvider(providerConfig(), NETWORK, 15_000);

    const { chain } = NETWORK_CONFIG[NETWORK];
    try {
      if (!WakuBroadcasterClient?.start) throw new Error('RAILGUN Waku web client is not installed yet.');
      // Empty signer disables the package's optional trusted-fee allowlist;
      // individual broadcaster fee messages are still signature-verified.
      broadcasterStatus = 'Connecting';
      onBroadcasterStatus(broadcasterStatus);
      engineLog('INFO', 'Connecting to the Waku broadcaster network (Sepolia relay set)…');
      Promise.resolve(WakuBroadcasterClient.start(chain, { trustedFeeSigner: '' }, (_reportedChain, status) => {
        const nextStatus = String(status);
        if (nextStatus === broadcasterStatus) return;
        broadcasterStatus = nextStatus;
        onBroadcasterStatus(broadcasterStatus);
        engineLog('INFO', `Broadcaster network status: ${status}`);
      })).catch(error => {
        broadcasterStatus = 'Unavailable';
        onBroadcasterStatus(broadcasterStatus);
        engineLog('ERROR', `RAILGUN Waku broadcaster startup failed: ${error?.message || error}`);
      });
    } catch (error) {
      broadcasterStatus = 'Unavailable';
      onBroadcasterStatus(broadcasterStatus);
      // Engine setup remains useful for wallet creation and deposits even if Waku is down.
      engineLog('ERROR', `RAILGUN Waku broadcaster startup failed: ${error?.message || error}`);
    }
    engineLog('INFO', 'RAILGUN engine started. Proof artifacts load on first proof from hash-checked IPFS gateways.');

    initialized = true;
    return { chain, networkName: NETWORK, broadcasterStatus };
  })();

  try {
    return await initializationPromise;
  } catch (error) {
    initializationPromise = undefined;
    throw error;
  }
}

export async function createPrivateWallet(encryptionKey, mnemonic) {
  await initializeRailgun();
  engineLog('INFO', 'Creating encrypted RAILGUN wallet from recovery phrase (never leaves this browser).');
  const creationBlock = await getFallbackProviderForNetwork(NETWORK).getBlockNumber();
  engineLog('INFO', `Setting the wallet scan start block to ${creationBlock} on Sepolia.`);
  const wallet = await createRailgunWallet(encryptionKey, mnemonic, { [NETWORK]: creationBlock }, 0);
  engineLog('INFO', `RAILGUN wallet created · 0zk ${wallet.railgunAddress.slice(0, 18)}…`);
  return wallet;
}

export function generatePrivateWalletMnemonic() {
  return Mnemonic.generate(128);
}

export async function restorePrivateWallet(encryptionKey, walletId) {
  await initializeRailgun();
  engineLog('INFO', `Unlocking encrypted RAILGUN wallet ${walletId}…`);
  return loadWalletByID(encryptionKey, walletId, false);
}

export function generateShieldPrivateKey() {
  // populateShield only needs an ephemeral scalar to encrypt the shield note.
  // A wallet signature is not required when the recipient RAILGUN address is explicit.
  const curveOrder = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const entropy = crypto.getRandomValues(new Uint8Array(32));
  const raw = BigInt(`0x${Array.from(entropy, byte => byte.toString(16).padStart(2, '0')).join('')}`);
  return ((raw % (curveOrder - 1n)) + 1n).toString(16).padStart(64, '0');
}

export async function deriveWalletEncryptionKey(password) {
  if (!password || password.length < 10) throw new Error('Use a wallet encryption password with at least 10 characters.');
  const saltKey = 'veil.railgun.encryptionSalt.v1';
  let saltHex = localStorage.getItem(saltKey);
  if (!saltHex) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    saltHex = Array.from(salt, byte => byte.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(saltKey, saltHex);
  }
  const salt = Uint8Array.from(saltHex.match(/.{2}/g), byte => Number.parseInt(byte, 16));
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 310_000 }, material, 256);
  return Array.from(new Uint8Array(bits), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function getBroadcasterStatus() {
  return broadcasterStatus;
}

export async function refreshPrivateBalances(walletId) {
  const activeScan = activeWalletScans.get(walletId);
  if (activeScan) {
    engineLog('INFO', 'A private balance scan is already running; waiting for that scan instead of starting another.');
    return activeScan;
  }
  const scanPromise = scanPrivateBalances(walletId);
  activeWalletScans.set(walletId, scanPromise);
  try {
    return await scanPromise;
  } finally {
    if (activeWalletScans.get(walletId) === scanPromise) activeWalletScans.delete(walletId);
  }
}

async function scanPrivateBalances(walletId) {
  const wallet = getEngine().wallets[walletId];
  if (!wallet) throw new Error('RAILGUN wallet is no longer loaded. Unlock it again.');
  engineLog('INFO', 'Scanning Sepolia commitment tree for private notes…');
  // Register before requesting the scan so a fast WalletDecryptBalancesComplete
  // event cannot fire between refreshBalances and waiter registration.
  const scanComplete = awaitWalletScan(walletId, CHAIN);
  await refreshBalances(CHAIN, [walletId]);
  // A long scan must not kill the whole flow: on timeout keep going with the
  // balances decrypted so far and surface a warning to the UI.
  let scanWarning = null;
  let timeoutId;
  try {
    await Promise.race([
      scanComplete,
      new Promise(resolve => { timeoutId = setTimeout(() => {
      scanWarning = 'Private balance scan is still running; showing partial balances. New shields may take a few minutes to appear.';
      engineLog('WARN', 'Wallet scan exceeded 180s — returning partial balances.');
      resolve();
      }, 180_000); }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
  const balances = await wallet.getTokenBalances(TXIDVersion.V2_PoseidonMerkle, CHAIN, true);
  const tokenCount = Object.keys(balances).length;
  engineLog('INFO', `Private balance scan returned ${tokenCount} token${tokenCount === 1 ? '' : 's'}${scanWarning ? ' (partial)' : ''}.`);
  return { balances, warning: scanWarning };
}

export async function estimateBroadcasterFeeForAmount({ walletId, encryptionKey, tokenIn, amountToUnshield, buildCrossContractCalls }) {
  const { feeTokenDetails, gasDetails } = await prepareFeeContext({ walletId, encryptionKey, tokenIn, amountToUnshield, buildCrossContractCalls });
  const fee = calculateBroadcasterFeeERC20Amount(feeTokenDetails, gasDetails);
  return { feeAmount: fee.amount, feeToken: feeTokenDetails.tokenAddress, gasEstimate: gasDetails.gasEstimate, maxFeePerGas: gasDetails.maxFeePerGas };
}

async function prepareFeeContext({ walletId, tokenIn, amountToUnshield, buildCrossContractCalls, publicWalletSubmission = false }) {
  const wallet = getEngine().wallets[walletId];
  if (!wallet) throw new Error('RAILGUN wallet is no longer loaded. Unlock it again.');
  const selectedBroadcaster = publicWalletSubmission ? null : await selectBroadcaster(walletId, tokenIn);
  const feeTokenDetails = selectedBroadcaster ? {
    tokenAddress: selectedBroadcaster.tokenAddress,
    feePerUnitGas: BigInt(selectedBroadcaster.tokenFee.feePerUnitGas),
  } : undefined;
  const feeData = await getFallbackProviderForNetwork(NETWORK).getFeeData();
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? 1_000_000_000n;
  const maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice ?? maxPriorityFeePerGas * 2n;
  const minGasLimit = MINIMUM_RELAY_ADAPT_CROSS_CONTRACT_CALLS_GAS_LIMIT_V2;
  const originalGasDetails = {
    evmGasType: EVMGasType.Type2,
    gasEstimate: minGasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas,
  };
  const unshieldAmounts = [{ tokenAddress: tokenIn, amount: BigInt(amountToUnshield) }];
  // Keep any unused input-token remainder private. The swapped output is sent
  // directly to the connected public wallet by the Uniswap TAKE action.
  const shieldRecipients = [tokenIn].map(tokenAddress => ({
    tokenAddress,
    recipientAddress: wallet.getAddress(),
  }));
  if (shieldRecipients.some(recipient => !recipient.recipientAddress)) {
    throw new Error('Unlock the RAILGUN wallet again before swapping.');
  }
  return { wallet, selectedBroadcaster, feeTokenDetails, originalGasDetails, minGasLimit, unshieldAmounts, shieldRecipients };
}

export async function hasBroadcasterFeeOption(walletId) {
  // Instant check against the local Waku fee cache — never waits for
  // announcements. Used to auto-pick the submission path before a swap.
  if (!WakuBroadcasterClient?.findAllBroadcastersForChain) {
    return { available: false, reason: 'Waku broadcaster client is not available.' };
  }
  const candidates = WakuBroadcasterClient.findAllBroadcastersForChain(CHAIN, true) || [];
  if (!candidates.length) {
    return { available: false, reason: 'No broadcaster fees are cached yet.' };
  }
  const wallet = getEngine().wallets[walletId];
  if (!wallet) return { available: false, reason: 'Wallet is not loaded.' };
  const balances = await wallet.getTokenBalances(TXIDVersion.V2_PoseidonMerkle, CHAIN, true);
  const findPrivateBalance = address => Object.values(balances).find(balance =>
    String(balance.tokenData?.tokenAddress || '').toLowerCase().replace(/^0x/, '').endsWith(address.toLowerCase().replace(/^0x/, '').slice(-40)));
  const held = candidates.find(candidate => BigInt(findPrivateBalance(candidate.tokenAddress)?.balance ?? 0n) > 0n);
  if (!held) {
    return { available: false, reason: `No privately-held token is advertised for fees (advertising: ${[...new Set(candidates.map(candidate => shortToken(candidate.tokenAddress)))].slice(0, 4).join(', ')}).` };
  }
  return { available: true, feeToken: held.tokenAddress, railgunAddress: held.railgunAddress };
}

async function selectBroadcaster(walletId, tokenIn) {
  // Prefer paying in the swap input token. Demo tokens are often unknown to
  // RAILGUN broadcasters, so fall back to any advertised fee token already
  // held in the user's private wallet (for example, a supported Sepolia asset).
  let selectedBroadcaster = await WakuBroadcasterClient.findBestBroadcaster(CHAIN, tokenIn, true);
  if (!selectedBroadcaster) {
    const wallet = getEngine().wallets[walletId];
    if (!wallet) throw new Error('Unlock the RAILGUN wallet again before selecting a broadcaster fee token.');
    let balances = await wallet.getTokenBalances(TXIDVersion.V2_PoseidonMerkle, CHAIN, true);
    const findPrivateBalance = address => Object.values(balances).find(balance =>
      String(balance.tokenData?.tokenAddress || '').toLowerCase().replace(/^0x/, '').endsWith(address.toLowerCase().replace(/^0x/, '').slice(-40)));
    const selectAvailableFeeToken = () => {
      const candidates = WakuBroadcasterClient.findAllBroadcastersForChain(CHAIN, true) || [];
      return candidates.find(candidate => BigInt(findPrivateBalance(candidate.tokenAddress)?.balance ?? 0n) > 0n);
    };
    selectedBroadcaster = selectAvailableFeeToken();
    engineLog('WARN', selectedBroadcaster
      ? `The swap token is unsupported for broadcaster fees; trying privately-held fee token ${shortToken(selectedBroadcaster.tokenAddress)}.`
      : `No broadcaster fee token is currently held in the private wallet (Waku ${broadcasterStatus}). Waiting up to 15s for fee announcements…`);
    if (!selectedBroadcaster) {
    for (let attempt = 0; attempt < 3 && !selectedBroadcaster; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      selectedBroadcaster = await WakuBroadcasterClient.findBestBroadcaster(CHAIN, tokenIn, true)
        || selectAvailableFeeToken();
    }
    }
  }
  if (!selectedBroadcaster) {
    const supported = (WakuBroadcasterClient.findAllBroadcastersForChain(CHAIN, true) || [])
      .map(candidate => shortToken(candidate.tokenAddress));
    const feeOptions = [...new Set(supported)].slice(0, 6).join(', ');
    throw new Error(`No usable Sepolia broadcaster fee token is shielded (Waku ${broadcasterStatus}). ${feeOptions ? `Advertised fee tokens: ${feeOptions}. Shield one of these tokens privately, then retry.` : 'No fee tokens are currently advertised. No swap was sent.'}`);
  }
  engineLog('INFO', `Selected broadcaster ${selectedBroadcaster.railgunAddress.slice(0, 18)}… · fee token ${shortToken(selectedBroadcaster.tokenAddress)} · feePerUnitGas ${selectedBroadcaster.tokenFee.feePerUnitGas}`);
  return selectedBroadcaster;
}

function shortToken(address) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export async function executePrivateCrossContractSwap({
  walletId,
  encryptionKey,
  tokenIn,
  amountToUnshield,
  swapAmount = amountToUnshield,
  submissionMode = 'broadcaster',
  buildCrossContractCalls,
  submitPublicTransaction,
  onProgress = () => {},
}) {
  const publicWalletSubmission = submissionMode === 'metamask';
  if (!['broadcaster', 'metamask'].includes(submissionMode)) throw new Error(`Unsupported swap submission mode: ${submissionMode}`);
  if (!publicWalletSubmission && !BroadcasterTransaction?.create) {
    throw new Error('RAILGUN Waku web client is not installed yet. Install it before submitting private swaps.');
  }
  if (!publicWalletSubmission && !['Connected', 'Searching'].includes(broadcasterStatus)) {
    throw new Error(`RAILGUN broadcaster network is ${broadcasterStatus}. Wait for Waku to connect before swapping.`);
  }
  if (publicWalletSubmission && typeof submitPublicTransaction !== 'function') {
    throw new Error('MetaMask transaction submitter is unavailable. Reconnect the wallet and try again.');
  }

  const context = await prepareFeeContext({ walletId, tokenIn, amountToUnshield, buildCrossContractCalls, publicWalletSubmission });
  const { wallet, selectedBroadcaster, feeTokenDetails, originalGasDetails, minGasLimit, shieldRecipients } = context;

  const unshieldAmount = BigInt(amountToUnshield);
  const unshieldAmounts = [{ tokenAddress: tokenIn, amount: unshieldAmount }];
  let swapInput;
  let estimate;
  let transactionGasDetails;
  let broadcasterFeeAmount = { amount: 0n };
  let broadcasterFeeRecipient;
  let finalCrossContractCalls;

  if (publicWalletSubmission) {
    swapInput = BigInt(swapAmount);
    finalCrossContractCalls = buildCrossContractCalls({ amountIn: swapInput });
    engineLog('WARN', 'No broadcaster fee is used. MetaMask will submit the Relay Adapt transaction directly; its sender address will be public.');
    estimate = await gasEstimateForUnprovenCrossContractCalls(
      TXIDVersion.V2_PoseidonMerkle,
      NETWORK,
      walletId,
      encryptionKey,
      unshieldAmounts,
      [],
      shieldRecipients,
      [],
      finalCrossContractCalls,
      originalGasDetails,
      undefined,
      true,
      minGasLimit,
    );
    transactionGasDetails = { ...originalGasDetails, gasEstimate: estimate.gasEstimate };
    const spendableBalances = await wallet.getTokenBalances(TXIDVersion.V2_PoseidonMerkle, CHAIN, true);
    const inputSuffix = tokenIn.toLowerCase().replace(/^0x/, '').slice(-40);
    const privateInputBalance = Object.values(spendableBalances).find(balance =>
      String(balance.tokenData?.tokenAddress || '').toLowerCase().replace(/^0x/, '').endsWith(inputSuffix));
    if (BigInt(privateInputBalance?.balance ?? 0n) < unshieldAmount) {
      throw new Error('Spendable private balance does not cover this swap input. Shield more tokens or reduce the amount.');
    }
    engineLog('INFO', `Public-wallet fallback gas estimate ${estimate.gasEstimate}; broadcaster fee 0. MetaMask will ask you to submit and pay gas.`);
  } else {
    // Fee-aware input sizing: derive the broadcaster fee first, reserve it plus
    // headroom, then re-estimate gas with the final swap call.
    engineLog('INFO', `Estimating gas for the private cross-contract swap (min limit ${minGasLimit})…`);
    const provisionalCalls = buildCrossContractCalls({ amountIn: unshieldAmount });
    const initialEstimate = await gasEstimateForUnprovenCrossContractCalls(
      TXIDVersion.V2_PoseidonMerkle,
      NETWORK,
      walletId,
      encryptionKey,
      unshieldAmounts,
      [],
      shieldRecipients,
      [],
      provisionalCalls,
      originalGasDetails,
      feeTokenDetails,
      false,
      minGasLimit,
    );
    const initialGasDetails = { ...originalGasDetails, gasEstimate: initialEstimate.gasEstimate };
    const initialFee = calculateBroadcasterFeeERC20Amount(feeTokenDetails, initialGasDetails);
    engineLog('INFO', `Gas estimate ${initialEstimate.gasEstimate} · broadcaster fee ≈ ${initialFee.amount} (${shortToken(feeTokenDetails.tokenAddress)})`);

    let sizeError;
    ({ swapInput, error: sizeError } = sizeSwapInput(unshieldAmount, initialFee.amount));
    if (sizeError) throw new Error(sizeError);
    engineLog('INFO', `Swap input sized to ${swapInput} of ${unshieldAmount} (fee reserve ${computeFeeReserve(initialFee.amount)}); re-estimating gas…`);
    finalCrossContractCalls = buildCrossContractCalls({ amountIn: swapInput });

    estimate = await gasEstimateForUnprovenCrossContractCalls(
      TXIDVersion.V2_PoseidonMerkle,
      NETWORK,
      walletId,
      encryptionKey,
      unshieldAmounts,
      [],
      shieldRecipients,
      [],
      finalCrossContractCalls,
      originalGasDetails,
      feeTokenDetails,
      false,
      minGasLimit,
    );
    transactionGasDetails = { ...originalGasDetails, gasEstimate: estimate.gasEstimate };
    broadcasterFeeAmount = calculateBroadcasterFeeERC20Amount(feeTokenDetails, transactionGasDetails);
    if (unshieldAmount - swapInput < broadcasterFeeAmount.amount) {
      const resized = sizeSwapInput(unshieldAmount, broadcasterFeeAmount.amount);
      if (resized.error) throw new Error(resized.error);
      swapInput = resized.swapInput;
      engineLog('WARN', `Fee grew after re-estimate; swap input resized to ${swapInput}.`);
      finalCrossContractCalls = buildCrossContractCalls({ amountIn: swapInput });
    }
    broadcasterFeeRecipient = {
      ...broadcasterFeeAmount,
      recipientAddress: selectedBroadcaster.railgunAddress,
    };
    const spendableBalances = await wallet.getTokenBalances(TXIDVersion.V2_PoseidonMerkle, CHAIN, true);
    const tokenSuffix = feeTokenDetails.tokenAddress.toLowerCase().replace(/^0x/, '').slice(-40);
    const privateFeeBalance = Object.values(spendableBalances).find(balance =>
      String(balance.tokenData?.tokenAddress || '').toLowerCase().replace(/^0x/, '').endsWith(tokenSuffix));
    const requiredBalance = feeTokenDetails.tokenAddress.toLowerCase() === tokenIn.toLowerCase()
      ? unshieldAmount + broadcasterFeeAmount.amount
      : broadcasterFeeAmount.amount;
    if (BigInt(privateFeeBalance?.balance ?? 0n) < requiredBalance) {
      throw new Error('Spendable private balance does not cover the swap input and broadcaster fee. Shield more tokens or reduce the swap amount.');
    }
  }
  const overallBatchMinGasPrice = publicWalletSubmission ? undefined : calculateGasPrice(transactionGasDetails);

  engineLog('INFO', `Generating the ZK proof on this device (${estimate.gasEstimate} gas · fee ${broadcasterFeeAmount.amount}). This can take minutes…`);
  await generateCrossContractCallsProof(
    TXIDVersion.V2_PoseidonMerkle,
    NETWORK,
    walletId,
    encryptionKey,
    unshieldAmounts,
    [],
    shieldRecipients,
    [],
    finalCrossContractCalls,
    broadcasterFeeRecipient,
    publicWalletSubmission,
    overallBatchMinGasPrice,
    minGasLimit,
    (progress, status) => {
      if (status) engineLog('INFO', `Proof ${Math.floor(progress * 100)}% · ${status}`);
      onProgress(progress, status);
    },
  );
  engineLog('INFO', 'ZK proof generated. Building the Relay Adapt transaction…');

  const populated = await populateProvedCrossContractCalls(
    TXIDVersion.V2_PoseidonMerkle,
    NETWORK,
    walletId,
    unshieldAmounts,
    [],
    shieldRecipients,
    [],
    finalCrossContractCalls,
    broadcasterFeeRecipient,
    publicWalletSubmission,
    overallBatchMinGasPrice,
    transactionGasDetails,
  );

  if (!populated.transaction.to || !populated.transaction.data) {
    throw new Error('RAILGUN did not produce a complete RelayAdapt transaction. No transaction was submitted.');
  }

  const nullifierCount = (populated.nullifiers ?? []).length;
  if (publicWalletSubmission) {
    engineLog('WARN', `Relay Adapt transaction built · ${nullifierCount} nullifier(s). Submitting from the connected MetaMask address; the sender will be public.`);
    const response = await submitPublicTransaction(populated.transaction);
    const hash = typeof response === 'string' ? response : response?.hash;
    if (!hash) throw new Error('MetaMask did not return a transaction hash.');
    engineLog('INFO', `MetaMask accepted the transaction: ${hash}`);
    return { response: hash, feeAmount: 0n, swapInput, broadcaster: null, gasEstimate: estimate.gasEstimate, submissionMode };
  }
  engineLog('INFO', `Relay Adapt transaction built · ${nullifierCount} nullifier(s) · ${Object.keys(populated.preTransactionPOIsPerTxidLeafPerList ?? {}).length} POI list(s). Submitting via broadcaster…`);
  const transaction = await BroadcasterTransaction.create(
    TXIDVersion.V2_PoseidonMerkle,
    populated.transaction.to,
    populated.transaction.data,
    selectedBroadcaster.railgunAddress,
    selectedBroadcaster.tokenFee.feesID,
    CHAIN,
    populated.nullifiers ?? [],
    overallBatchMinGasPrice,
    true,
    populated.preTransactionPOIsPerTxidLeafPerList ?? {},
  );
  const response = await transaction.send();
  engineLog('INFO', `Broadcaster accepted the private transaction. Response: ${typeof response === 'string' ? response : JSON.stringify(response).slice(0, 160)}`);
  return { response, feeAmount: broadcasterFeeAmount.amount, swapInput, broadcaster: selectedBroadcaster.railgunAddress, gasEstimate: estimate.gasEstimate, submissionMode };
}

export const railgunNetworkName = NETWORK;
export const railgunTXIDVersion = TXIDVersion.V2_PoseidonMerkle;
