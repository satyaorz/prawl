import { addressWord, buildPrivateV4Calls, decodeUint256Result, encodeErc20Approve, encodePermit2Approve, encodePoolTVLCall, encodeV4QuoteCall, normalizePoolKey, SEPOLIA, SELECTOR } from './v4-encoding.js';
import { scaleMinimumOut } from './fee-sizing.js';
import { createSepoliaDemoPool, mintDemoTokenToWallet, mintDemoTokens, mintAndAddDemoPoolLiquidity } from './pool-setup.js';

const $ = id => document.getElementById(id);
const state = { account: null, chainId: null, mode: 'private', quote: null, tokens: [], pool: null, railgunWallet: null, encryptionKey: null, privateBalances: {}, broadcasterStatus: 'Not started' };
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const RPC = () => window.ethereum;
let railgunModulesPromise;
let dashboardRefreshing = false;

function appendEngineLog(line) {
  const list = $('engineLogList');
  if (!list) return;
  const row = document.createElement('div');
  row.className = 'engine-log-row';
  if (line.includes('[WARN]')) row.classList.add('warn');
  if (line.includes('[ERROR]')) row.classList.add('error');
  row.textContent = line;
  list.append(row);
  while (list.childElementCount > 300) list.firstChild.remove();
  list.scrollTop = list.scrollHeight;
  const count = $('engineLogCount');
  if (count) count.textContent = list.childElementCount;
}

function engineLog(level, text) {
  const line = `[${new Date().toLocaleTimeString()}] [${level}] ${text}`;
  (level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log)(line);
  appendEngineLog(line);
}

document.addEventListener('veil-engine-log', event => appendEngineLog(event.detail));

function loadRailgunModules() {
  if (!railgunModulesPromise) {
    railgunModulesPromise = Promise.all([
      import('./railgun-runtime.js'),
      import('@railgun-community/wallet'),
      import('@railgun-community/shared-models'),
    ]).then(([runtime, wallet, models]) => ({ runtime, wallet, models })).catch(error => {
      railgunModulesPromise = undefined;
      throw new Error(`Could not load the private wallet engine: ${error?.message || error}`);
    });
  }
  return railgunModulesPromise;
}

function message(text, isError = false) {
  $('formMessage').textContent = text;
  $('formMessage').classList.toggle('error', isError);
  engineLog(isError ? 'ERROR' : 'INFO', text);
}

const txHashPattern = /^0x[0-9a-f]{64}$/i;
const explorerTxUrl = hash => `https://sepolia.etherscan.io/tx/${hash}`;
const explorerAddressUrl = address => `https://sepolia.etherscan.io/address/${address}`;

function messageTransaction(label, hash) {
  const container = $('formMessage');
  container.replaceChildren(document.createTextNode(`${label} `));
  if (txHashPattern.test(hash || '')) {
    const link = document.createElement('a');
    link.href = explorerTxUrl(hash);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = `${hash.slice(0, 10)}…${hash.slice(-8)} · Etherscan ↗`;
    container.append(link);
  } else {
    container.append(document.createTextNode(String(hash || 'hash unavailable')));
  }
  container.classList.remove('error');
}

function renderActivity() {
  const list = $('activityList');
  if (!list) return;
  let entries = [];
  try { entries = JSON.parse(localStorage.getItem('veil.activity.v1') || '[]'); } catch {}
  list.replaceChildren();
  $('activityEmpty').hidden = entries.length > 0;
  for (const entry of entries.slice(0, 20)) {
    const row = document.createElement('div');
    row.className = 'activity-row';
    const label = document.createElement('span');
    label.textContent = `${entry.label} · ${new Date(entry.time).toLocaleString()}`;
    const link = document.createElement('a');
    link.href = explorerTxUrl(entry.hash);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = `${entry.hash.slice(0, 8)}…${entry.hash.slice(-6)} ↗`;
    row.append(label, link);
    list.append(row);
  }
}

function recordActivity(label, hash) {
  if (!txHashPattern.test(hash || '')) return;
  let entries = [];
  try { entries = JSON.parse(localStorage.getItem('veil.activity.v1') || '[]'); } catch {}
  if (entries.some(entry => String(entry.hash).toLowerCase() === hash.toLowerCase())) return;
  entries.unshift({ label, hash, time: Date.now() });
  localStorage.setItem('veil.activity.v1', JSON.stringify(entries.slice(0, 20)));
  renderActivity();
}

function renderPoolStatus(text, tokens = []) {
  const status = $('poolSetupStatus');
  status.replaceChildren(document.createTextNode(text));
  if (tokens.length) {
    for (const token of tokens) {
      const line = document.createElement('div');
      const link = document.createElement('a');
      link.href = explorerAddressUrl(token.address);
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = `${token.symbol} ${token.address} · Sepolia Etherscan ↗`;
      line.append(link);
      status.append(line);
    }
    $('watchTokensButton').hidden = false;
    $('watchTokensButton').disabled = false;
    $('mintDemoTokensButton').hidden = false;
    $('mintDemoTokensButton').disabled = false;
  }
}

function dashboardMetric(label, value, className = '') {
  const metric = document.createElement('div');
  metric.className = `dashboard-metric ${className}`.trim();
  const title = document.createElement('span');
  title.textContent = label;
  const amount = document.createElement('b');
  amount.textContent = value;
  metric.append(title, amount);
  return metric;
}

async function updateBalanceDashboard() {
  const rows = $('dashboardTokenRows');
  if (!rows || dashboardRefreshing) return;
  if (!state.account) {
    $('dashboardStatus').textContent = 'Connect MetaMask on Sepolia to load live balances.';
    return;
  }
  if (!state.pool?.tokens?.length) {
    $('dashboardStatus').textContent = 'Create or load the vUSD/vETH demo pool to view balances.';
    rows.replaceChildren();
    return;
  }

  dashboardRefreshing = true;
  $('dashboardStatus').classList.remove('error');
  $('dashboardStatus').textContent = 'Updating wallet, pool and private balances…';
  try {
    const poolKey = normalizePoolKey({
      tokenA: state.pool.tokens[0].address,
      tokenB: state.pool.tokens[1].address,
      fee: state.pool.fee,
      tickSpacing: state.pool.tickSpacing,
      hooks: state.pool.hooks,
    });
    const [poolResult, tokenRows] = await Promise.all([
      ethCall(SEPOLIA.reservesLens, encodePoolTVLCall(poolKey)).then(value => ({ value })).catch(error => ({ error })),
      Promise.all(state.pool.tokens.map(async token => {
        const [decimals, publicBalance] = await Promise.all([
          tokenDecimals(token.address),
          ethCall(token.address, `0x${SELECTOR.erc20BalanceOf}${addressWord(state.account)}`),
        ]);
        return { token, decimals, publicBalance: decodeUint256Result(publicBalance) };
      })),
    ]);
    const poolBalances = new Map();
    let poolError = poolResult.error;
    if (!poolError) {
      const poolWords = (poolResult.value.slice(2).match(/.{64}/g) || []).map(value => BigInt(`0x${value}`));
      if (poolWords.length < 2) poolError = new Error('Pool reserves response was incomplete.');
      else {
        poolBalances.set(poolKey.currency0, poolWords[0]);
        poolBalances.set(poolKey.currency1, poolWords[1]);
      }
    }

    rows.replaceChildren();
    for (const { token, decimals, publicBalance } of tokenRows) {
      const row = document.createElement('article');
      row.className = 'dashboard-token';
      const head = document.createElement('div');
      head.className = 'dashboard-token-head';
      const symbol = document.createElement('strong');
      symbol.textContent = token.symbol;
      const descriptor = document.createElement('small');
      descriptor.textContent = token.symbol === 'vUSD' ? 'demo USDC' : token.symbol === 'vETH' ? 'demo ETH' : 'demo token';
      head.append(symbol, descriptor);

      const metrics = document.createElement('div');
      metrics.className = 'dashboard-metrics';
      metrics.append(
        dashboardMetric('Wallet', formatUnits(publicBalance, decimals, 4)),
        dashboardMetric('Pool', poolError ? 'unavailable' : formatUnits(poolBalances.get(token.address.toLowerCase()) || 0n, decimals, 4), 'pool'),
        dashboardMetric('Shielded', state.railgunWallet
          ? formatUnits(privateTokenBalance(token.address), decimals, 4)
          : 'locked', 'private'),
      );

      const controls = document.createElement('div');
      controls.className = 'dashboard-controls';
      const walletButton = document.createElement('button');
      walletButton.type = 'button';
      walletButton.className = 'secondary-button';
      walletButton.textContent = `Mint 1k ${token.symbol} → wallet`;
      walletButton.disabled = !state.account;
      walletButton.addEventListener('click', () => mintDashboardToken(token, walletButton));
      const poolButton = document.createElement('button');
      poolButton.type = 'button';
      poolButton.className = 'secondary-button';
      poolButton.textContent = `Mint ${token.symbol} + add pool`;
      poolButton.disabled = !state.pool || !state.account;
      poolButton.addEventListener('click', () => addDashboardLiquidity(token, poolButton));
      controls.append(walletButton, poolButton);
      row.append(head, metrics, controls);
      rows.append(row);
    }
    $('dashboardStatus').textContent = poolError
      ? `Wallet/private live · pool reserves unavailable (${poolError.message || 'RPC error'})`
      : `Live · ${shortAddress(state.account)} · Sepolia · refreshed ${new Date().toLocaleTimeString()}`;
  } catch (error) {
    $('dashboardStatus').textContent = `Balance update failed: ${error?.message || error}`;
    $('dashboardStatus').classList.add('error');
  } finally {
    dashboardRefreshing = false;
  }
}

async function mintDashboardToken(token, button) {
  button.disabled = true;
  try {
    await connectWallet();
    const transaction = await mintDemoTokenToWallet(RPC(), state.account, token);
    recordActivity(transaction.label, transaction.hash);
    await updateBalanceDashboard();
    messageTransaction(`Minted 1,000 ${token.symbol} to your wallet:`, transaction.hash);
  } catch (error) {
    message(error?.message || `Could not mint ${token.symbol}.`, true);
  } finally {
    button.disabled = false;
    void updateBalanceDashboard();
  }
}

async function addDashboardLiquidity(token, button) {
  button.disabled = true;
  $('dashboardStatus').classList.remove('error');
  try {
    await connectWallet();
    const transactions = await mintAndAddDemoPoolLiquidity(RPC(), state.account, state.pool, token.address, text => {
      $('dashboardStatus').textContent = text;
    });
    for (const transaction of transactions) recordActivity(transaction.label, transaction.hash);
    $('dashboardStatus').textContent = 'Minted the demo pair and added a liquidity position. Updating pool reserves…';
    await updateBalanceDashboard();
    if (transactions.length) messageTransaction('Pool liquidity added:', transactions.at(-1).hash);
  } catch (error) {
    $('dashboardStatus').textContent = error?.message || 'Could not add pool liquidity.';
    $('dashboardStatus').classList.add('error');
  } finally {
    button.disabled = false;
    void updateBalanceDashboard();
  }
}

function modal(title, body, status = '') {
  $('modalTitle').textContent = title;
  $('modalText').textContent = body;
  $('modalStatus').textContent = status;
  $('modalStatus').classList.remove('error');
  $('modalBackdrop').hidden = false;
}

function closeModal() { $('modalBackdrop').hidden = true; }

function shortAddress(address) { return `${address.slice(0, 6)}…${address.slice(-4)}`; }

function hexToBigInt(hex) { return BigInt(hex || '0x0'); }

function parseUnits(value, decimals) {
  const input = String(value).trim();
  if (!/^\d*(\.\d*)?$/.test(input) || !input || input === '.') throw new Error('Enter a valid token amount.');
  const [whole = '0', fraction = ''] = input.split('.');
  if (fraction.length > decimals) throw new Error(`This token supports at most ${decimals} decimal places.`);
  return BigInt(whole || '0') * (10n ** BigInt(decimals)) + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

function formatUnits(amount, decimals, precision = 6) {
  const n = BigInt(amount);
  const whole = n / (10n ** BigInt(decimals));
  const fraction = (n % (10n ** BigInt(decimals))).toString().padStart(decimals, '0').slice(0, precision).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function privateTokenBalance(address) {
  const token = address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const entry = Object.values(state.privateBalances || {}).find(balance => String(balance.tokenData?.tokenAddress || '').toLowerCase().replace(/^0x/, '').endsWith(token.slice(-40)));
  return entry ? BigInt(entry.balance || 0) : 0n;
}

function tokenSymbol(address) {
  return state.tokens.find(token => token.address.toLowerCase() === address.toLowerCase())?.symbol || shortAddress(address);
}

async function refreshPublicTokenBalance(direction, address) {
  const label = $(`walletBalance${direction === 'in' ? 'In' : 'Out'}`);
  if (!address) { label.textContent = 'Wallet balance · select token'; return; }
  if (!state.account) { label.textContent = 'Wallet balance · connect MetaMask'; return; }
  if (state.chainId !== SEPOLIA.chainId) { label.textContent = 'Wallet balance · switch MetaMask to Sepolia'; return; }
  try {
    const [decimals, balanceHex] = await Promise.all([
      tokenDecimals(address),
      ethCall(address, `0x${SELECTOR.erc20BalanceOf}${addressWord(state.account)}`),
    ]);
    label.textContent = `Wallet balance · ${formatUnits(decodeUint256Result(balanceHex), decimals)} ${tokenSymbol(address)}`;
  } catch (error) {
    label.textContent = `Wallet balance · unavailable (${error?.message || 'RPC error'})`;
  }
}

async function refreshWalletBalances() {
  await Promise.all([
    refreshPublicTokenBalance('in', $('tokenInAddress').value.trim()),
    refreshPublicTokenBalance('out', $('tokenOutAddress').value.trim()),
  ]);
  if (!state.railgunWallet) {
    await updateBalanceDashboard();
    return;
  }
  $('walletSetupStatus').classList.remove('error');
  $('walletSetupStatus').textContent = 'Scanning Sepolia for private notes…';
  const { runtime } = await loadRailgunModules();
  const result = await runtime.refreshPrivateBalances(state.railgunWallet.id);
  state.privateBalances = result.balances || {};
  if (result.warning) {
    $('walletSetupStatus').textContent = result.warning;
    engineLog('WARN', result.warning);
  }
  for (const [direction, addressId, balanceId] of [
    ['in', 'tokenInAddress', 'balanceIn'],
    ['out', 'tokenOutAddress', 'balanceOut'],
  ]) {
    const address = $(addressId).value.trim();
    if (!address) continue;
    const decimals = await tokenDecimals(address).catch(() => 18);
    $(balanceId).textContent = `Private balance · ${tokenSymbol(address)} · ${formatUnits(privateTokenBalance(address), decimals)} ${direction === 'in' ? '(spendable)' : ''}`;
  }
  $('walletSetupStatus').textContent = 'Private balance scan requested. New deposits may take a few minutes to appear.';
  await updateBalanceDashboard();
}

function showRailgunWallet(wallet) {
  state.railgunWallet = wallet;
  state.privateBalances = {};
  localStorage.setItem('veil.railgun.walletId', wallet.id);
  $('walletAddress').textContent = `Private address · ${wallet.railgunAddress}`;
  $('walletSetupStatus').textContent = `RAILGUN wallet ready · Waku ${state.broadcasterStatus}`;
  $('walletSetupStatus').classList.remove('error');
  renderWallet();
}

async function prepareRailgunWallet() {
  const password = $('walletPassword').value;
  $('walletSetupStatus').textContent = 'Loading the private-wallet engine and proof libraries. First load may take a few minutes…';
  $('walletSetupStatus').classList.remove('error');
  const { runtime } = await loadRailgunModules();
  state.encryptionKey = await runtime.deriveWalletEncryptionKey(password);
  $('walletSetupStatus').textContent = 'Starting RAILGUN engine and loading Sepolia…';
  await runtime.initializeRailgun(status => {
    state.broadcasterStatus = status;
    $('walletSetupStatus').textContent = `RAILGUN engine ready · Waku ${status}`;
  });
  return runtime;
}

async function createRailgunWalletUI(importPhrase = false) {
  const button = importPhrase ? $('restoreRailgunWalletButton') : $('createRailgunWalletButton');
  button.disabled = true;
  try {
    await prepareRailgunWallet();
    const phraseInput = $('walletMnemonic');
    const { runtime } = await loadRailgunModules();
    const phrase = importPhrase ? phraseInput.value.trim().replace(/\s+/g, ' ') : runtime.generatePrivateWalletMnemonic();
    if (!phrase) throw new Error('Enter your existing recovery phrase, or choose Create private wallet to generate a new one.');
    if (!importPhrase) phraseInput.value = phrase;
    $('walletSetupStatus').textContent = importPhrase ? 'Importing recovery phrase into this browser…' : 'Creating your private wallet. Keep the recovery phrase safe…';
    const wallet = await runtime.createPrivateWallet(state.encryptionKey, phrase);
    showRailgunWallet(wallet);
    $('walletSetupStatus').textContent = importPhrase
      ? 'Wallet imported. The phrase is held only in this page; save it offline.'
      : 'Wallet created. Write down the recovery phrase above before shielding funds.';
    $('walletSetupStatus').classList.remove('error');
  } catch (error) {
    $('walletSetupStatus').textContent = error?.message || 'Could not create the RAILGUN wallet.';
    $('walletSetupStatus').classList.add('error');
  } finally {
    button.disabled = false;
  }
}

async function unlockRailgunWalletUI() {
  const button = $('unlockRailgunWalletButton');
  button.disabled = true;
  try {
    const walletId = localStorage.getItem('veil.railgun.walletId');
    if (!walletId) throw new Error('No saved RAILGUN wallet ID exists in this browser. Import a recovery phrase first.');
    await prepareRailgunWallet();
    $('walletSetupStatus').textContent = 'Unlocking encrypted RAILGUN wallet…';
    const { runtime } = await loadRailgunModules();
    const wallet = await runtime.restorePrivateWallet(state.encryptionKey, walletId);
    showRailgunWallet(wallet);
    await refreshWalletBalances();
  } catch (error) {
    $('walletSetupStatus').textContent = error?.message || 'Could not unlock the RAILGUN wallet.';
    $('walletSetupStatus').classList.add('error');
  } finally {
    button.disabled = false;
  }
}

function addShieldButton() {
  if ($('shieldTokenButton')) return;
  const button = document.createElement('button');
  button.id = 'shieldTokenButton';
  button.className = 'secondary-button';
  button.type = 'button';
  button.textContent = 'Shield entered amount of pay token';
  button.addEventListener('click', shieldSelectedToken);
  $('walletAddress').before(button);
}

async function shieldSelectedToken() {
  const button = $('shieldTokenButton');
  button.disabled = true;
  try {
    await connectWallet();
    if (!state.railgunWallet || !state.encryptionKey) {
      $('walletSetupStatus').textContent = 'Create the embedded private account first, then shield tokens into it.';
      $('walletSetupStatus').classList.remove('error');
      return;
    }
    const tokenAddress = $('tokenInAddress').value.trim();
    const decimals = await tokenDecimals(tokenAddress);
    const amount = parseUnits($('amountInput').value, decimals);
    if (amount <= 0n) throw new Error('Enter a positive amount to shield.');
    const { runtime, wallet: walletSdk, models } = await loadRailgunModules();
    const proxy = models.NETWORK_CONFIG[runtime.railgunNetworkName].proxyContract;
    if (!proxy) throw new Error('RAILGUN Sepolia proxy address is missing from the installed SDK.');

    const allowanceCall = `0xdd62ed3e${addressWord(state.account)}${addressWord(proxy)}`;
    const allowance = decodeUint256Result(await ethCall(tokenAddress, allowanceCall));
    if (allowance < amount) {
      $('walletSetupStatus').textContent = 'MetaMask will ask once to approve this exact token amount, then once to confirm the shield deposit. No message-signature prompt is needed.';
      const approval = await sendTransaction({ to: tokenAddress, data: encodeErc20Approve(proxy, amount) });
      recordActivity(`Approval · ${tokenSymbol(tokenAddress)} → RAILGUN`, approval.hash);
    }

    $('walletSetupStatus').textContent = allowance < amount
      ? 'Approval confirmed. Confirm the public shield deposit in MetaMask.'
      : 'Confirm the public shield deposit in MetaMask.';
    const shieldPrivateKey = runtime.generateShieldPrivateKey();
    const { transaction } = await walletSdk.populateShield(
      runtime.railgunTXIDVersion,
      runtime.railgunNetworkName,
      shieldPrivateKey,
      [{ tokenAddress, amount, recipientAddress: state.railgunWallet.railgunAddress }],
      [],
    );
    const submitted = await sendTransaction({
      to: transaction.to,
      data: transaction.data,
      value: transaction.value == null ? '0x0' : `0x${BigInt(transaction.value).toString(16)}`,
    });
    $('walletSetupStatus').textContent = `Shield confirmed: ${submitted.hash}. Waiting for the private note scan…`;
    recordActivity(`Shield deposit · ${tokenSymbol(tokenAddress)}`, submitted.hash);
    engineLog('INFO', `Shield deposit confirmed on-chain: ${submitted.hash}. Waiting for the note scan…`);
    $('walletSetupStatus').classList.remove('error');
    await new Promise(resolve => setTimeout(resolve, 12_000));
    await refreshWalletBalances();
  } catch (error) {
    $('walletSetupStatus').textContent = error?.message || 'Shield deposit failed.';
    $('walletSetupStatus').classList.add('error');
    engineLog('ERROR', `Shield deposit failed: ${error?.message || error}`);
  } finally {
    button.disabled = false;
  }
}

async function ensureSepolia() {
  if (!RPC()) throw new Error('MetaMask was not found. Install or unlock MetaMask, then try again.');
  const current = Number(hexToBigInt(await RPC().request({ method: 'eth_chainId' })));
  if (current !== SEPOLIA.chainId) {
    try {
      await RPC().request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0xaa36a7' }] });
    } catch (error) {
      if (error.code !== 4902) throw error;
      await RPC().request({ method: 'wallet_addEthereumChain', params: [{
        chainId: '0xaa36a7', chainName: 'Sepolia', nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: ['https://ethereum-sepolia-rpc.publicnode.com'], blockExplorerUrls: ['https://sepolia.etherscan.io'],
      }] });
    }
  }
  state.chainId = SEPOLIA.chainId;
}

async function connectWallet() {
  if (!RPC()) throw new Error('MetaMask was not found. Install or unlock MetaMask, then try again.');
  await ensureSepolia();
  const accounts = await RPC().request({ method: 'eth_requestAccounts' });
  if (!accounts?.length) throw new Error('No MetaMask account is available.');
  state.account = accounts[0];
  renderWallet();
  void refreshPublicTokenBalance('in', $('tokenInAddress').value.trim());
  void refreshPublicTokenBalance('out', $('tokenOutAddress').value.trim());
  void updateBalanceDashboard();
  return state.account;
}

async function reconnectExistingMetaMask() {
  if (!RPC()) return;
  try {
    const [accounts, chain] = await Promise.all([
      RPC().request({ method: 'eth_accounts' }),
      RPC().request({ method: 'eth_chainId' }),
    ]);
    state.account = accounts?.[0] || null;
    state.chainId = Number(hexToBigInt(chain));
    renderWallet();
    await Promise.all([
      refreshPublicTokenBalance('in', $('tokenInAddress').value.trim()),
      refreshPublicTokenBalance('out', $('tokenOutAddress').value.trim()),
    ]);
    await updateBalanceDashboard();
  } catch (error) {
    console.warn('Could not restore MetaMask connection:', error);
  }
}

function renderWallet() {
  $('connectButton').innerHTML = state.account ? `${shortAddress(state.account)} <span>✓</span>` : 'Connect wallet <span>↗</span>';
  if (state.account && !state.pool && $('poolSetupStatus').textContent.startsWith('Connect MetaMask')) {
    $('poolSetupStatus').textContent = `Wallet ${shortAddress(state.account)} connected. Click Deploy tokens & create pool; approve each Sepolia transaction.`;
  }
  $('swapButton').disabled = !state.account;
  const savedWallet = Boolean(localStorage.getItem('veil.railgun.walletId'));
  $('swapButtonText').textContent = !state.account
    ? 'Connect wallet to continue'
    : state.mode === 'private' && !state.railgunWallet
      ? savedWallet ? 'Unlock private balance to continue' : 'Set up private balance to continue'
      : state.mode === 'private' ? 'Swap from shielded balance · public output' : 'Swap publicly with Uniswap';
}

async function ethCall(to, data) {
  const params = [{ to, data }, 'latest'];
  let response;
  try {
    response = await fetch('/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params }) });
  } catch {
    if (RPC()) return RPC().request({ method: 'eth_call', params });
    throw new Error('Could not reach the configured Sepolia RPC. Check SEPOLIA_RPC_URL in .env.local.');
  }
  const json = await response.json().catch(() => ({}));
  const upstreamError = json.error?.message || '';
  const rateLimited = response.status === 429 || /rate.?limit|too many requests|quota exceeded/i.test(upstreamError);
  if ((response.status === 503 || rateLimited) && RPC()) {
    try {
      engineLog('WARN', rateLimited
        ? 'Configured Sepolia RPC rate-limited a read; retrying this read through MetaMask’s Sepolia RPC.'
        : 'Local Sepolia RPC proxy is unavailable; retrying this read through MetaMask’s Sepolia RPC.');
      return await RPC().request({ method: 'eth_call', params });
    } catch (fallbackError) {
      const reason = rateLimited ? 'The configured Sepolia RPC is rate-limited' : 'The local Sepolia RPC proxy is unavailable';
      throw new Error(`${reason}, and MetaMask RPC fallback failed: ${fallbackError?.message || fallbackError}`);
    }
  }
  if (!response.ok || json.error) throw new Error(upstreamError || `Sepolia RPC returned HTTP ${response.status}.`);
  return json.result;
}

async function tokenDecimals(address) {
  const result = await ethCall(address, `0x${SELECTOR.erc20Decimals}`);
  const decimals = Number(decodeUint256Result(result));
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error('Token returned invalid decimals.');
  return decimals;
}

function currentRoute() {
  const tokenIn = $('tokenInAddress').value.trim();
  const tokenOut = $('tokenOutAddress').value.trim();
  const poolKey = normalizePoolKey({ tokenA: tokenIn, tokenB: tokenOut, fee: $('poolFee').value, tickSpacing: $('tickSpacing').value, hooks: $('hookAddress').value.trim() || ZERO_ADDRESS });
  const zeroForOne = tokenIn.toLowerCase() === poolKey.currency0.toLowerCase();
  return { tokenIn, tokenOut, poolKey, zeroForOne };
}

async function getQuote() {
  try {
    message('Checking Sepolia pool…');
    await ensureSepolia();
    const route = currentRoute();
    const inputDecimals = await tokenDecimals(route.tokenIn);
    const outputDecimals = await tokenDecimals(route.tokenOut);
    const amountIn = parseUnits($('amountInput').value, inputDecimals);
    if (amountIn <= 0n) throw new Error('Enter an amount greater than zero.');
    const grossAmountIn = state.mode === 'private' ? amountIn * 9975n / 10000n : amountIn;
    const data = encodeV4QuoteCall({ poolKey: route.poolKey, zeroForOne: route.zeroForOne, amountIn: grossAmountIn });
    const result = await ethCall(SEPOLIA.quoter, data);
    const amountOut = decodeUint256Result(result);
    const minimumOut = amountOut * 9950n / 10000n;
    state.quote = { ...route, amountIn: grossAmountIn, unshieldAmount: amountIn, grossAmountIn, amountOut, minimumOut, inputDecimals, outputDecimals, at: Date.now() };
    $('receiveAmount').textContent = formatUnits(amountOut, outputDecimals);
    $('minimumOut').textContent = `${formatUnits(minimumOut, outputDecimals)} (0.5% slippage)`;
    $('priceImpact').textContent = 'Not calculated';
    $('networkFee').textContent = state.mode === 'private' ? `Broadcaster · ${state.broadcasterStatus}` : 'Shown in MetaMask';
    message(state.mode === 'private' ? 'Quote fetched. The RPC provider saw the quote amount.' : 'Quote ready. This route will be public on-chain.');
  } catch (error) {
    state.quote = null;
    $('receiveAmount').textContent = '—';
    $('minimumOut').textContent = 'Set after quote';
    const detail = error?.message || 'unknown RPC error';
    const hint = /internal json-rpc|revert|call exception/i.test(detail)
      ? ' Verify the loaded token pair, fee, tick spacing, hook, and that the pool has active liquidity at the current price.'
      : '';
    message(`Quote failed: ${detail}.${hint}`, true);
  }
}

async function sendTransaction(tx) {
  const hash = await RPC().request({ method: 'eth_sendTransaction', params: [{ from: state.account, ...tx }] });
  message(`Waiting for ${shortAddress(hash)} confirmation…`);
  for (let index = 0; index < 240; index += 1) {
    const receipt = await getTransactionReceipt(hash);
    if (receipt) {
      if (receipt.status !== '0x1') throw new Error(`Transaction reverted: ${hash}`);
      return { hash, receipt };
    }
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  throw new Error(`Timed out waiting for ${hash}`);
}

async function getTransactionReceipt(hash) {
  try {
    const response = await fetch('/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [hash] }),
    });
    const json = await response.json().catch(() => ({}));
    if (response.ok && !json.error) return json.result || null;
  } catch {}
  return RPC().request({ method: 'eth_getTransactionReceipt', params: [hash] });
}

async function waitForTransactionReceipt(hash, timeoutMs = 360_000) {
  const deadline = Date.now() + timeoutMs;
  let nextUpdate = 0;
  while (Date.now() < deadline) {
    const receipt = await getTransactionReceipt(hash);
    if (receipt) {
      if (receipt.status !== '0x1') throw new Error(`Private swap transaction reverted: ${hash}`);
      return receipt;
    }
    if (Date.now() >= nextUpdate) {
      messageTransaction('Private swap submitted; waiting for confirmation:', hash);
      nextUpdate = Date.now() + 15_000;
    }
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  return null;
}

async function executePublicSwap() {
  if (!state.quote || Date.now() - state.quote.at > 30_000) throw new Error('Quote is missing or expired. Get a fresh quote.');
  const now = Math.floor(Date.now() / 1000);
  const amount = state.quote.amountIn;
  const expiration = now + 1800;
  message('Approve Permit2 in MetaMask…');
  await sendTransaction({ to: state.quote.tokenIn, data: encodeErc20Approve(SEPOLIA.permit2, amount) });
  message('Approve Uniswap through Permit2…');
  await sendTransaction({ to: SEPOLIA.permit2, data: encodePermit2Approve(state.quote.tokenIn, SEPOLIA.universalRouter, amount, expiration) });
  message('Confirm the public Uniswap swap in MetaMask…');
  const calls = buildPrivateV4Calls({
    tokenIn: state.quote.tokenIn,
    tokenOut: state.quote.tokenOut,
    recipientAddress: state.account,
    amountIn: amount,
    minAmountOut: state.quote.minimumOut,
    poolKey: state.quote.poolKey,
    zeroForOne: state.quote.zeroForOne,
    deadline: now + 120,
    permit2Expiration: expiration,
  });
  const routerCall = calls.at(-1);
  const transaction = await sendTransaction({ to: routerCall.to, data: routerCall.data });
  recordActivity(`Public swap · ${tokenSymbol(state.quote.tokenIn)} → ${tokenSymbol(state.quote.tokenOut)}`, transaction.hash);
  messageTransaction('Public swap confirmed:', transaction.hash);
  return transaction.hash;
}

async function submitPrivateSwap(submissionMode = 'auto') {
  if (!state.railgunWallet || !state.encryptionKey) throw new Error('Create or unlock a RAILGUN wallet first.');
  if (!state.quote) throw new Error('Get a quote first.');
  const { runtime } = await loadRailgunModules();
  if (submissionMode === 'auto') {
    // Zero-wait selection: check the fee cache once, instantly. If a broadcaster
    // accepts a token we privately hold, relay through it; otherwise self-submit
    // via MetaMask instead of hanging on fee announcements.
    const option = await runtime.hasBroadcasterFeeOption(state.railgunWallet.id);
    if (option.available) {
      submissionMode = 'broadcaster';
      engineLog('INFO', `Auto-submission: broadcaster available (fee token ${shortAddress(option.feeToken)}).`);
    } else {
      submissionMode = 'metamask';
      engineLog('WARN', `Auto-submission: ${option.reason} Falling back to self-submission via MetaMask (sender address will be public).`);
    }
  } else if (submissionMode === 'broadcaster') {
    const option = await runtime.hasBroadcasterFeeOption(state.railgunWallet.id);
    if (!option.available) {
      throw new Error(`${option.reason} Use "Continue with MetaMask" to self-submit instead.`);
    }
  }
  if (!state.quote) throw new Error('Get a quote first.');
  if (Date.now() - state.quote.at > 25_000) {
    engineLog('INFO', 'Quote older than 25s — refreshing automatically before the swap.');
    await getQuote();
    if (!state.quote) throw new Error('Could not refresh the quote. Try again.');
  }
  const outputBalanceBefore = decodeUint256Result(await ethCall(
    state.quote.tokenOut,
    `0x${SELECTOR.erc20BalanceOf}${addressWord(state.account)}`,
  ));
  const inputBalance = privateTokenBalance(state.quote.tokenIn);
  if (inputBalance < state.quote.unshieldAmount) {
    throw new Error(`Private balance is too low. Shield ${formatUnits(state.quote.unshieldAmount - inputBalance, state.quote.inputDecimals)} more ${tokenSymbol(state.quote.tokenIn)} first.`);
  }
  const now = Math.floor(Date.now() / 1000);
  // Fixed deadlines captured once so every rebuilt call set shares them.
  const deadline = now + 1800;
  const permit2Expiration = now + 3600;
  const buildCrossContractCalls = ({ amountIn }) => {
    // The runtime may shrink amountIn to leave room for the broadcaster fee.
    // Scale minOut down with the input: output is super-linear in input for a
    // fixed pool, so input-scaled minOut is a conservative lower bound that
    // still guards against slippage.
    const scaledMinimumOut = scaleMinimumOut(state.quote.minimumOut, state.quote.grossAmountIn, amountIn);
    return buildPrivateV4Calls({
      tokenIn: state.quote.tokenIn,
      tokenOut: state.quote.tokenOut,
      recipientAddress: state.account,
      amountIn,
      minAmountOut: scaledMinimumOut,
      poolKey: state.quote.poolKey,
      zeroForOne: state.quote.zeroForOne,
      // Proof generation can take several minutes, so the permit and swap deadline
      // must outlive the proof while remaining bounded.
      deadline,
      permit2Expiration,
    });
  };
  $('swapButton').disabled = true;
  message(submissionMode === 'metamask'
    ? 'Preparing a private RAILGUN proof on this device… MetaMask will submit it (sender public).'
    : 'Preparing a private RAILGUN proof on this device…');
  try {
    const { runtime } = await loadRailgunModules();
    engineLog('INFO', `Private swap start · in ${formatUnits(state.quote.unshieldAmount, state.quote.inputDecimals)} ${tokenSymbol(state.quote.tokenIn)} · min out ${formatUnits(state.quote.minimumOut, state.quote.outputDecimals)} ${tokenSymbol(state.quote.tokenOut)}`);
    const result = await runtime.executePrivateCrossContractSwap({
      walletId: state.railgunWallet.id,
      encryptionKey: state.encryptionKey,
      tokenIn: state.quote.tokenIn,
      amountToUnshield: state.quote.unshieldAmount,
      swapAmount: submissionMode === 'metamask' ? state.quote.grossAmountIn : undefined,
      buildCrossContractCalls,
      submissionMode,
      submitPublicTransaction: submissionMode === 'metamask' ? async tx => {
        const toHex = value => value == null ? undefined : `0x${BigInt(value).toString(16)}`;
        const request = { to: tx.to, data: tx.data };
        for (const [key, value] of Object.entries({
          value: tx.value,
          gas: tx.gas ?? tx.gasLimit,
          gasPrice: tx.gasPrice,
          maxFeePerGas: tx.maxFeePerGas,
          maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
        })) {
          const hex = toHex(value);
          if (hex !== undefined) request[key] = hex;
        }
        return sendTransaction(request);
      } : undefined,
      onProgress: (progress, status) => message(`Private proof ${Math.floor(progress * 100)}% · ${status || 'Generating'}`),
    });
    engineLog('INFO', result.submissionMode === 'metamask'
      ? `Private proof submitted directly by MetaMask · sender ${shortAddress(state.account)} is public · swap input ${result.swapInput}.`
      : `Private swap submitted · broadcaster fee ${result.feeAmount} · swap input ${result.swapInput} · broadcaster ${result.broadcaster.slice(0, 12)}…`);
    // Keep the privacy panel honest about who paid gas for the submission.
    const selfSubmitted = result.submissionMode === 'metamask';
    $('privacySenderClaim').textContent = selfSubmitted ? 'Gas paid by your address (self-submitted)' : 'Sender hidden during private spend';
    $('privacySenderTag').textContent = selfSubmitted ? 'PUBLIC' : 'HIDDEN';
    $('privacySenderTag').className = selfSubmitted ? 'tag-public' : 'tag-hidden';
    $('privacySenderIcon').className = selfSubmitted ? 'privacy-public' : 'privacy-check';
    const txHash = typeof result.response === 'string' ? result.response : result.response?.txHash || result.response?.hash;
    if (txHashPattern.test(txHash || '')) {
      recordActivity(`RAILGUN swap · ${result.submissionMode === 'metamask' ? 'MetaMask sender public' : 'broadcaster'} · ${tokenSymbol(state.quote.tokenIn)} → ${tokenSymbol(state.quote.tokenOut)}`, txHash);
      const receipt = await waitForTransactionReceipt(txHash);
      if (!receipt) {
        messageTransaction('Swap is still pending. Your MetaMask vETH balance will update after confirmation:', txHash);
        return;
      }
      messageTransaction('RAILGUN transaction confirmed on Sepolia. Checking your MetaMask vETH balance:', txHash);
    } else {
      message(`Broadcaster submitted the private swap but returned no verifiable Ethereum transaction hash: ${JSON.stringify(result.response)}`, true);
      return;
    }
    await refreshWalletBalances();
    const outputBalanceAfter = decodeUint256Result(await ethCall(
      state.quote.tokenOut,
      `0x${SELECTOR.erc20BalanceOf}${addressWord(state.account)}`,
    ));
    if (outputBalanceAfter <= outputBalanceBefore) {
      message(`Swap confirmed, but no public ${tokenSymbol(state.quote.tokenOut)} increase was detected in ${shortAddress(state.account)}. Check the transaction details before retrying.`, true);
    } else if (txHashPattern.test(txHash || '')) {
      messageTransaction(`${tokenSymbol(state.quote.tokenOut)} sent to your public wallet. Verify transaction:`, txHash);
    }
  } finally {
    renderWallet();
  }
}

async function swap(submissionMode) {
  if (!submissionMode) {
    // Default: fully automatic self-submission — no relayer, no broadcaster
    // cache, no waiting. The optional checkbox opts into broadcaster relay
    // when one accepts a privately-held fee token.
    submissionMode = $('preferBroadcaster')?.checked ? 'auto' : 'metamask';
  }
  try {
    if (state.mode === 'private') {
      $('metamaskFallbackButton').hidden = true;
      $('metamaskFallbackNote').hidden = true;
      if (submissionMode === 'metamask') {
        // Self-submission from the start: be honest about the gas payer up front.
        $('privacySenderClaim').textContent = 'Gas paid by your address (self-submitted)';
        $('privacySenderTag').textContent = 'PUBLIC';
        $('privacySenderTag').className = 'tag-public';
        $('privacySenderIcon').className = 'privacy-public';
        $('routeLabel').textContent = 'RAILGUN proof → Uniswap v4 · MetaMask sender public';
        $('modeNote').textContent = 'No relayer is used: MetaMask submits the RAILGUN proof transaction and pays gas, so your wallet address is public and linked to the swap. The shielded-note spend itself is still hidden by the ZK proof.';
      } else {
        $('privacySenderClaim').textContent = 'Sender hidden during private spend';
        $('privacySenderTag').textContent = 'HIDDEN';
        $('privacySenderTag').className = 'tag-hidden';
        $('privacySenderIcon').className = 'privacy-check';
        $('modeNote').textContent = 'RAILGUN hides your shielded sender, but swap details and your connected output address are public. Output tokens go directly to MetaMask, not back to private notes.';
        $('routeLabel').textContent = 'RAILGUN → Uniswap v4 → MetaMask · Sepolia';
      }
    }
    await connectWallet();
    await ensureSepolia();
    if (state.mode === 'private' && !state.railgunWallet) {
      const setup = document.querySelector('.wallet-settings');
      setup.open = true;
      setup.scrollIntoView({ behavior: 'smooth', block: 'center' });
      $('walletSetupStatus').textContent = localStorage.getItem('veil.railgun.walletId')
        ? 'Unlock the embedded private account, or import its recovery phrase to restore it.'
        : 'Set up your embedded private account once, save its recovery phrase offline, then use MetaMask to shield test tokens into it.';
      $('walletSetupStatus').classList.remove('error');
      message('A private swap needs shielded funds in Veil’s embedded account. MetaMask will still sign the deposit.');
      return;
    }
    // Auto-refresh a quote that is about to expire instead of failing late.
    if (!state.quote || Date.now() - state.quote.at > 25_000) {
      await getQuote();
      if (!state.quote) return;
    }
    if (state.mode === 'private') await submitPrivateSwap(submissionMode);
    else await executePublicSwap();
  } catch (error) {
    const canShowPublicFallback = state.mode === 'private'
      && /No usable Sepolia broadcaster fee token|No Sepolia broadcaster accepts the selected fee token/i.test(error?.message || '');
    $('metamaskFallbackButton').hidden = !canShowPublicFallback;
    if (canShowPublicFallback) $('metamaskFallbackNote').hidden = false;
    message(error?.message || 'Swap failed.', true);
  }
}

function setMode(mode) {
  state.mode = mode;
  $('metamaskFallbackButton').hidden = true;
  $('metamaskFallbackNote').hidden = true;
  $('privacySenderClaim').textContent = 'Sender hidden during private spend';
  $('privacySenderTag').textContent = 'HIDDEN';
  $('privacySenderTag').className = 'tag-hidden';
  $('privacySenderIcon').className = 'privacy-check';
  const privateMode = mode === 'private';
  $('privateTab').classList.toggle('selected', privateMode);
  $('privateTab').setAttribute('aria-selected', String(privateMode));
  $('publicTab').classList.toggle('selected', !privateMode);
  $('publicTab').setAttribute('aria-selected', String(!privateMode));
  $('routeLabel').textContent = privateMode ? 'RAILGUN → Uniswap v4 → Wallet' : 'Public Uniswap v4';
  $('modeNote').textContent = privateMode
    ? 'RAILGUN hides your shielded sender, but swap details and your connected output address are public. Output tokens go directly to MetaMask, not back to private notes.'
    : 'Comparison route: MetaMask sends the swap directly to Uniswap. Sender, token pair, calldata, and amount are public.';
  renderWallet();
  state.quote = null;
  $('receiveAmount').textContent = '—';
  message(privateMode ? (state.railgunWallet ? `Private route selected · broadcaster ${state.broadcasterStatus}.` : 'Private route selected. Unlock a RAILGUN wallet to continue.') : 'Public comparison route selected.');
}

function setTokenOptions(tokens) {
  state.tokens = tokens;
  for (const id of ['tokenInSelect', 'tokenOutSelect']) {
    const select = $(id);
    select.innerHTML = '<option value="">Select token</option>';
    for (const token of tokens) {
      const option = document.createElement('option');
      option.value = token.address;
      option.textContent = token.symbol;
      select.append(option);
    }
  }
}

function chooseToken(direction, address) {
  const token = state.tokens.find(item => item.address.toLowerCase() === address.toLowerCase());
  if (!token) return;
  const addressField = direction === 'in' ? 'tokenInAddress' : 'tokenOutAddress';
  $(addressField).value = token.address;
  void refreshPublicTokenBalance(direction, token.address);
  const balanceLabel = state.railgunWallet
    ? `Private balance · ${formatUnits(privateTokenBalance(token.address), token.decimals || 18)} ${token.symbol}`
    : 'Private balance · unlock RAILGUN wallet';
  if (direction === 'in') $('balanceIn').textContent = balanceLabel;
  else $('balanceOut').textContent = balanceLabel;
  state.quote = null;
  $('receiveAmount').textContent = '—';
  void updateBalanceDashboard();
}

function loadExistingPool() {
  try {
    state.pool = JSON.parse(localStorage.getItem('veil.sepolia.demoPool') || 'null');
    if (state.pool?.tokens?.length === 2) {
      $('createPoolButton').hidden = true;
      setTokenOptions(state.pool.tokens);
      $('tokenInSelect').value = state.pool.tokens[0].address;
      $('tokenOutSelect').value = state.pool.tokens[1].address;
      chooseToken('in', state.pool.tokens[0].address);
      chooseToken('out', state.pool.tokens[1].address);
      $('poolFee').value = state.pool.fee;
      $('tickSpacing').value = state.pool.tickSpacing;
      $('hookAddress').value = state.pool.hooks;
      renderPoolStatus('Saved demo pool loaded. Add the demo tokens to MetaMask to see their public balances.', state.pool.tokens);
      $('mintDemoTokensButton').hidden = false;
      const priorTransactions = state.pool.transactions || (state.pool.receipts || []).map(hash => ({ label: 'Previous pool transaction', hash }));
      for (const transaction of priorTransactions) recordActivity(`Pool · ${transaction.label}`, transaction.hash);
      void updateBalanceDashboard();
    }
  } catch {
    localStorage.removeItem('veil.sepolia.demoPool');
  }
}

async function watchDemoTokens() {
  $('watchTokensButton').disabled = true;
  try {
    await connectWallet();
    if (!state.pool?.tokens?.length) throw new Error('Create or load the demo pool before adding its tokens.');
    for (const token of state.pool.tokens) {
      const added = await RPC().request({
        method: 'wallet_watchAsset',
        params: { type: 'ERC20', options: { address: token.address, symbol: token.symbol, decimals: token.decimals } },
      });
      if (!added) throw new Error(`MetaMask did not add ${token.symbol}. Try importing its contract address manually.`);
    }
    renderPoolStatus('Requested both demo tokens in MetaMask. If a token is still hidden, import its linked contract address manually.', state.pool.tokens);
    await Promise.all([
      refreshPublicTokenBalance('in', $('tokenInAddress').value.trim()),
      refreshPublicTokenBalance('out', $('tokenOutAddress').value.trim()),
    ]);
    await updateBalanceDashboard();
  } catch (error) {
    renderPoolStatus(`Could not add tokens to MetaMask: ${error?.message || error}. The contracts and addresses are still available below.`, state.pool?.tokens || []);
  } finally {
    $('watchTokensButton').disabled = false;
  }
}

async function mintDemoTokensToWallet() {
  $('mintDemoTokensButton').disabled = true;
  try {
    await connectWallet();
    if (!state.pool?.tokens?.length) throw new Error('Create or load the demo vUSD/vETH pool first.');
    const transactions = await mintDemoTokens(RPC(), state.account, state.pool.tokens, text => { $('poolSetupStatus').textContent = text; });
    for (const transaction of transactions) recordActivity(transaction.label, transaction.hash);
    renderPoolStatus('Minted 1,000 demo vUSD and vETH to your public MetaMask address. Adding them to MetaMask now…', state.pool.tokens);
    await watchDemoTokens();
  } catch (error) {
    renderPoolStatus(`Could not mint demo tokens: ${error?.message || error}`, state.pool?.tokens || []);
    $('poolSetupStatus').classList.add('error');
  } finally {
    $('mintDemoTokensButton').disabled = false;
  }
}

async function createPool() {
  $('createPoolButton').disabled = true;
  $('poolSetupStatus').classList.remove('error');
  try {
    if (!state.account) await connectWallet();
    if (state.chainId !== SEPOLIA.chainId) await ensureSepolia();
    $('poolSetupStatus').textContent = 'Starting setup. Keep MetaMask open and approve each Sepolia transaction.';
    const pool = await createSepoliaDemoPool(RPC(), state.account, text => { $('poolSetupStatus').textContent = text; });
    state.pool = pool;
    $('createPoolButton').hidden = true;
    setTokenOptions(pool.tokens);
    $('tokenInSelect').value = pool.tokens[0].address;
    $('tokenOutSelect').value = pool.tokens[1].address;
    chooseToken('in', pool.tokens[0].address);
    chooseToken('out', pool.tokens[1].address);
    $('poolFee').value = pool.fee;
    $('tickSpacing').value = pool.tickSpacing;
    $('hookAddress').value = pool.hooks;
    renderPoolStatus(`Pool ready. Test balances were minted to ${shortAddress(state.account)}. Add the tokens to MetaMask to see the public balances.`, pool.tokens);
    void updateBalanceDashboard();
    for (const transaction of pool.transactions || []) recordActivity(`Pool · ${transaction.label}`, transaction.hash);
    $('poolSetupStatus').classList.remove('error');
  } catch (error) {
    $('poolSetupStatus').textContent = error?.message || 'Could not create the demo pool.';
    $('poolSetupStatus').classList.add('error');
  } finally {
    $('createPoolButton').disabled = false;
  }
}

function bind() {
  $('connectButton').addEventListener('click', async () => {
    try { await connectWallet(); message('MetaMask connected on Sepolia.'); }
    catch (error) { message(error?.message || 'Wallet connection failed.', true); }
  });
  $('privateTab').addEventListener('click', () => setMode('private'));
  $('publicTab').addEventListener('click', () => setMode('public'));
  $('quoteButton').addEventListener('click', getQuote);
  $('swapButton').addEventListener('click', () => swap());
  $('metamaskFallbackButton').addEventListener('click', async () => {
    $('metamaskFallbackButton').disabled = true;
    $('metamaskFallbackButton').hidden = true;
    $('privacySenderClaim').textContent = 'Sender visible in MetaMask transaction';
    $('privacySenderTag').textContent = 'PUBLIC';
    $('privacySenderTag').className = 'tag-public';
    $('privacySenderIcon').className = 'privacy-public';
    $('routeLabel').textContent = 'RAILGUN proof → Uniswap v4 · MetaMask sender public';
    $('modeNote').textContent = 'MetaMask submits and pays gas for this fallback, so your wallet address is public and linked to the swap. The RAILGUN spend proof is still generated locally; Uniswap pool activity and the output wallet are public.';
    message('MetaMask fallback selected: the shielded spend is proved locally, but MetaMask will submit and pay gas. Your sender address will be public.');
    try { await swap('metamask'); }
    finally { $('metamaskFallbackButton').disabled = false; }
  });
  $('createPoolButton').addEventListener('click', createPool);
  $('dashboardRefreshButton').addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await refreshWalletBalances();
      $('dashboardStatus').textContent = 'Balances refreshed.';
      $('dashboardStatus').classList.remove('error');
    } catch (error) {
      $('dashboardStatus').textContent = error?.message || 'Could not refresh balances.';
      $('dashboardStatus').classList.add('error');
    } finally {
      button.disabled = false;
      void updateBalanceDashboard();
    }
  });
  $('mintDemoTokensButton').addEventListener('click', mintDemoTokensToWallet);
  $('watchTokensButton').addEventListener('click', watchDemoTokens);
  $('createRailgunWalletButton').addEventListener('click', () => createRailgunWalletUI(false));
  $('restoreRailgunWalletButton').addEventListener('click', () => createRailgunWalletUI(true));
  $('unlockRailgunWalletButton').addEventListener('click', unlockRailgunWalletUI);
  $('tokenInSelect').addEventListener('change', event => chooseToken('in', event.target.value));
  $('tokenOutSelect').addEventListener('change', event => chooseToken('out', event.target.value));
  $('flipButton').addEventListener('click', () => {
    const oldIn = $('tokenInSelect').value;
    const oldOut = $('tokenOutSelect').value;
    $('tokenInSelect').value = oldOut;
    $('tokenOutSelect').value = oldIn;
    chooseToken('in', oldOut);
    chooseToken('out', oldIn);
  });
  $('maxButton').addEventListener('click', () => {
    if (state.mode === 'private' && state.railgunWallet) {
      const address = $('tokenInAddress').value.trim();
      tokenDecimals(address).then(decimals => {
        $('amountInput').value = formatUnits(privateTokenBalance(address), decimals, decimals);
      }).catch(error => message(error.message, true));
    } else message(state.mode === 'private' ? 'Unlock a RAILGUN wallet and refresh its private balances first.' : 'Enter an amount to quote.');
  });
  $('modalClose').addEventListener('click', closeModal);
  $('modalBackdrop').addEventListener('click', event => { if (event.target === $('modalBackdrop')) closeModal(); });
  $('modalAction').addEventListener('click', async () => {
    try { await connectWallet(); $('modalStatus').textContent = 'MetaMask connected. Create or unlock a RAILGUN wallet to shield and swap privately.'; }
    catch (error) { $('modalStatus').textContent = error.message; $('modalStatus').classList.add('error'); }
  });
  $('refreshButton').addEventListener('click', async () => {
    try { await refreshWalletBalances(); message('Private balance refresh requested.'); }
    catch (error) { message(error?.message || 'Private balance refresh failed.', true); }
  });
  $('engineLogClear').addEventListener('click', () => {
    $('engineLogList').replaceChildren();
    $('engineLogCount').textContent = '0';
    localStorage.removeItem('veil.engineLog.v1');
    engineLog('INFO', 'Engine log cleared.');
  });
  for (const id of ['amountInput', 'tokenInAddress', 'tokenOutAddress', 'poolFee', 'tickSpacing', 'hookAddress']) {
    $(id).addEventListener('input', () => { state.quote = null; $('receiveAmount').textContent = '—'; });
  }
  if (RPC()) {
    RPC().on?.('accountsChanged', accounts => {
      state.account = accounts[0] || null;
      renderWallet();
      void refreshPublicTokenBalance('in', $('tokenInAddress').value.trim());
      void refreshPublicTokenBalance('out', $('tokenOutAddress').value.trim());
      void updateBalanceDashboard();
    });
    RPC().on?.('chainChanged', chain => { state.chainId = Number(BigInt(chain)); renderWallet(); });
  }
}

loadExistingPool();
renderActivity();
bind();
addShieldButton();
renderWallet();
setMode('private');
void reconnectExistingMetaMask();
try {
  for (const line of JSON.parse(localStorage.getItem('veil.engineLog.v1') || '[]').slice(-100)) appendEngineLog(line);
} catch {}
engineLog('INFO', 'Veil private swap page loaded. RAILGUN engine initializes when you create or unlock a private wallet.');
window.setInterval(() => {
  if (document.visibilityState === 'visible' && state.account) void updateBalanceDashboard();
}, 30_000);
if (localStorage.getItem('veil.railgun.walletId')) {
  $('walletAddress').textContent = 'Saved encrypted wallet found · enter its encryption password and unlock.';
}
