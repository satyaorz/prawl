import { normalizePoolKey, SEPOLIA, encodePoolInitialize, encodePoolModifyLiquidity, word } from './v4-encoding.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const TOKEN_MINT = '40c10f19';
const ERC20_APPROVE = '095ea7b3';
const ERC20_SUPPLY = 1_000_000n * 10n ** 18n;
const LIQUIDITY = 10_000n * 10n ** 18n;

const clean = value => String(value).replace(/^0x/i, '');

function encodeBytes(value) {
  const bytes = clean(value);
  return word(bytes.length / 2) + bytes.padEnd(Math.ceil(bytes.length / 64) * 64, '0');
}

function encodeString(value) {
  const bytes = Array.from(new TextEncoder().encode(value), byte => byte.toString(16).padStart(2, '0')).join('');
  return word(bytes.length / 2) + bytes.padEnd(Math.ceil(bytes.length / 64) * 64, '0');
}

function encodeConstructor(name, symbol) {
  const nameData = encodeString(name);
  const symbolData = encodeString(symbol);
  return word(64) + word(64 + nameData.length / 2) + nameData + symbolData;
}

function encodeMint(to, amount) {
  return `0x${TOKEN_MINT}${to.slice(2).toLowerCase().padStart(64, '0')}${word(amount)}`;
}

function encodeApprove(spender, amount) {
  return `0x${ERC20_APPROVE}${spender.slice(2).toLowerCase().padStart(64, '0')}${word(amount)}`;
}

async function sendTx(provider, account, tx) {
  const hash = await provider.request({
    method: 'eth_sendTransaction',
    params: [{ from: account, ...tx }],
  });
  for (let attempt = 0; attempt < 240; attempt += 1) {
    let receipt = null;
    try {
      const response = await fetch('/rpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [hash] }),
      });
      const json = await response.json().catch(() => ({}));
      if (response.ok && !json.error) receipt = json.result || null;
    } catch {}
    if (!receipt) receipt = await provider.request({ method: 'eth_getTransactionReceipt', params: [hash] });
    if (receipt) {
      if (receipt.status !== '0x1') throw new Error(`Transaction reverted: ${hash}`);
      return { hash, receipt };
    }
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  throw new Error(`Timed out waiting for ${hash}`);
}

function addressFromReceipt(receipt) {
  const address = receipt.contractAddress;
  if (!address || address === ZERO_ADDRESS) throw new Error('Token deployment did not return a contract address');
  return address;
}

export async function createSepoliaDemoPool(provider, account, onStatus = () => {}) {
  const chainId = Number(BigInt(await provider.request({ method: 'eth_chainId' })));
  if (chainId !== SEPOLIA.chainId) throw new Error('Switch MetaMask to Sepolia before creating the demo pool.');

  onStatus('Loading demo token bytecode…');
  const bytecodeResponse = await fetch('/artifacts/MockERC20.bin');
  if (!bytecodeResponse.ok) throw new Error('Mock token artifact is missing. Compile contracts/MockERC20.sol first.');
  const bytecode = (await bytecodeResponse.text()).trim().replace(/^0x/i, '');
  if (!/^[0-9a-f]+$/i.test(bytecode)) throw new Error('Mock token bytecode is invalid.');

  onStatus('Deploying vUSD… confirm in MetaMask.');
  const usdDeployment = await sendTx(provider, account, { data: `0x${bytecode}${encodeConstructor('Veil Demo Dollar', 'vUSD')}` });
  const usd = addressFromReceipt(usdDeployment.receipt);

  onStatus('Deploying vETH… confirm in MetaMask.');
  const ethDeployment = await sendTx(provider, account, { data: `0x${bytecode}${encodeConstructor('Veil Demo Ether', 'vETH')}` });
  const eth = addressFromReceipt(ethDeployment.receipt);

  onStatus('Minting test balances… confirm two MetaMask transactions.');
  const usdMint = await sendTx(provider, account, { to: usd, data: encodeMint(account, ERC20_SUPPLY) });
  const ethMint = await sendTx(provider, account, { to: eth, data: encodeMint(account, ERC20_SUPPLY) });

  const fee = 3000;
  const tickSpacing = 60;
  const poolKey = normalizePoolKey({ tokenA: usd, tokenB: eth, fee, tickSpacing, hooks: ZERO_ADDRESS });
  const sqrtPriceX96 = 1n << 96n; // 1 vUSD = 1 vETH (both demo tokens have 18 decimals).

  onStatus('Initializing the Uniswap v4 pool… confirm in MetaMask.');
  const initialize = await sendTx(provider, account, { to: SEPOLIA.poolManager, data: encodePoolInitialize(poolKey, sqrtPriceX96) });

  onStatus('Approving the v4 liquidity helper… confirm two MetaMask transactions.');
  const approve0 = await sendTx(provider, account, { to: poolKey.currency0, data: encodeApprove(SEPOLIA.poolModifyLiquidityTest, ERC20_SUPPLY) });
  const approve1 = await sendTx(provider, account, { to: poolKey.currency1, data: encodeApprove(SEPOLIA.poolModifyLiquidityTest, ERC20_SUPPLY) });

  onStatus('Adding demo liquidity… confirm in MetaMask.');
  const liquidityCall = encodePoolModifyLiquidity(poolKey, {
    tickLower: -600,
    tickUpper: 600,
    liquidityDelta: LIQUIDITY,
  });
  const liquidityReceipt = await sendTx(provider, account, {
    to: SEPOLIA.poolModifyLiquidityTest,
    data: liquidityCall,
  });

  const transactions = [
    { label: 'Deploy vUSD', hash: usdDeployment.hash },
    { label: 'Deploy vETH', hash: ethDeployment.hash },
    { label: 'Mint vUSD', hash: usdMint.hash },
    { label: 'Mint vETH', hash: ethMint.hash },
    { label: 'Initialize pool', hash: initialize.hash },
    { label: 'Approve vUSD liquidity', hash: approve0.hash },
    { label: 'Approve vETH liquidity', hash: approve1.hash },
    { label: 'Add pool liquidity', hash: liquidityReceipt.hash },
  ];
  const pair = {
    token0: poolKey.currency0,
    token1: poolKey.currency1,
    fee,
    tickSpacing,
    hooks: ZERO_ADDRESS,
    sqrtPriceX96: sqrtPriceX96.toString(),
    tokens: [
      { address: usd, symbol: 'vUSD', name: 'Veil Demo Dollar', decimals: 18 },
      { address: eth, symbol: 'vETH', name: 'Veil Demo Ether', decimals: 18 },
    ],
    transactions,
    receipts: transactions.map(transaction => transaction.hash),
  };
  localStorage.setItem('veil.sepolia.demoPool', JSON.stringify(pair));
  onStatus('Demo pool created and funded.');
  return pair;
}

export async function mintDemoTokens(provider, account, tokens, onStatus = () => {}) {
  const chainId = Number(BigInt(await provider.request({ method: 'eth_chainId' })));
  if (chainId !== SEPOLIA.chainId) throw new Error('Switch MetaMask to Sepolia before minting demo tokens.');
  if (!Array.isArray(tokens) || tokens.length !== 2) throw new Error('Load the demo vUSD/vETH pool before minting its tokens.');
  const amount = 1_000n * 10n ** 18n;
  const transactions = [];
  for (const token of tokens) {
    onStatus(`Minting 1,000 test ${token.symbol} to your MetaMask account… confirm in MetaMask.`);
    const result = await sendTx(provider, account, {
      to: token.address,
      data: encodeMint(account, amount),
    });
    transactions.push({ label: `Faucet mint · ${token.symbol}`, hash: result.hash });
  }
  return transactions;
}

export async function mintDemoTokenToWallet(provider, account, token) {
  const chainId = Number(BigInt(await provider.request({ method: 'eth_chainId' })));
  if (chainId !== SEPOLIA.chainId) throw new Error('Switch MetaMask to Sepolia before minting demo tokens.');
  if (!token?.address) throw new Error('Select a demo token to mint.');
  const result = await sendTx(provider, account, { to: token.address, data: encodeMint(account, 1_000n * 10n ** 18n) });
  return { label: `Faucet mint · ${token.symbol} to wallet`, hash: result.hash };
}

export async function mintAndAddDemoPoolLiquidity(provider, account, pool, focusTokenAddress, onStatus = () => {}) {
  const chainId = Number(BigInt(await provider.request({ method: 'eth_chainId' })));
  if (chainId !== SEPOLIA.chainId) throw new Error('Switch MetaMask to Sepolia before adding liquidity.');
  if (!pool?.tokens || pool.tokens.length !== 2) throw new Error('Create or load the demo pool first.');
  const pair = normalizePoolKey({
    tokenA: pool.tokens[0].address,
    tokenB: pool.tokens[1].address,
    fee: pool.fee,
    tickSpacing: pool.tickSpacing,
    hooks: pool.hooks,
  });
  if (!pool.tokens.some(token => token.address.toLowerCase() === String(focusTokenAddress).toLowerCase())) {
    throw new Error('Choose a token from this demo pool.');
  }
  const transactions = [];
  const mintAmount = 1_000n * 10n ** 18n;
  for (const token of pool.tokens) {
    const isFocusedToken = token.address.toLowerCase() === String(focusTokenAddress).toLowerCase();
    const balanceCall = `0x70a08231${account.slice(2).toLowerCase().padStart(64, '0')}`;
    const walletBalance = BigInt(await provider.request({ method: 'eth_call', params: [{ to: token.address, data: balanceCall }, 'latest'] }));
    if (!isFocusedToken && walletBalance >= mintAmount) continue;
    onStatus(`Minting 1,000 ${token.symbol} ${isFocusedToken ? 'for the selected pool side' : 'to pair the pool deposit'}…`);
    const result = await sendTx(provider, account, { to: token.address, data: encodeMint(account, mintAmount) });
    transactions.push({ label: `Pool mint · ${token.symbol}`, hash: result.hash });
  }

  for (const token of pool.tokens) {
    onStatus(`Checking ${token.symbol} approval for the v4 liquidity helper…`);
    const allowanceData = `0xdd62ed3e${account.slice(2).toLowerCase().padStart(64, '0')}${SEPOLIA.poolModifyLiquidityTest.slice(2).toLowerCase().padStart(64, '0')}`;
    const allowance = BigInt(await provider.request({ method: 'eth_call', params: [{ to: token.address, data: allowanceData }, 'latest'] }));
    if (allowance < LIQUIDITY) {
      onStatus(`Approving ${token.symbol} for the v4 liquidity helper… confirm in MetaMask.`);
      const approval = await sendTx(provider, account, { to: token.address, data: encodeApprove(SEPOLIA.poolModifyLiquidityTest, ERC20_SUPPLY) });
      transactions.push({ label: `Approve liquidity · ${token.symbol}`, hash: approval.hash });
    }
  }

  onStatus('Adding a vUSD/vETH liquidity position to the Uniswap v4 pool… confirm in MetaMask.');
  const liquidity = await sendTx(provider, account, {
    to: SEPOLIA.poolModifyLiquidityTest,
    data: encodePoolModifyLiquidity(pair, { tickLower: -600, tickUpper: 600, liquidityDelta: LIQUIDITY }),
  });
  transactions.push({ label: 'Add balanced pool liquidity', hash: liquidity.hash });
  return transactions;
}
