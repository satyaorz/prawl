const UINT256_MAX = (1n << 256n) - 1n;

export const SEPOLIA = Object.freeze({
  chainId: 11155111,
  poolManager: '0xE03A1074c86CFeDd5C142C4F04F1a1536e203543',
  // Official Sepolia Universal Router deployment (developers.uniswap.org/deployments).
  // The previously bundled 0x7E4f6c5e… address is not the current v4 router.
  universalRouter: '0x3a9d48ab9751398bbfa63ad67599bb04e4bdf98b',
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  quoter: '0x61b3f2011a92d183c7dbadbda940a7555ccf9227',
  reservesLens: '0x0000001b173C3bbF3984D417d8614E3eed34865B',
  poolModifyLiquidityTest: '0x0c478023803a644c94c4ce1c1e7b9a087e411b0a',
});

export const SELECTOR = Object.freeze({
  erc20Approve: '095ea7b3',
  erc20BalanceOf: '70a08231',
  erc20Decimals: '313ce567',
  permit2Approve: '87517c45',
  v4QuoteExactInputSingle: 'aa9d21cb',
  universalRouterExecute: '3593564c',
  poolInitialize: '6276cbbe',
  poolModifyLiquidity: '5a6bcfda',
  poolTVL: 'f95138f2',
});

const strip0x = value => String(value).replace(/^0x/i, '');

export function word(value) {
  const n = BigInt(value);
  if (n < 0n || n > UINT256_MAX) throw new RangeError('ABI integer is out of range');
  return n.toString(16).padStart(64, '0');
}

export function signedWord(value) {
  return BigInt.asUintN(256, BigInt(value)).toString(16).padStart(64, '0');
}

export function addressWord(address) {
  const clean = strip0x(address).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(clean)) throw new TypeError(`Invalid address: ${address}`);
  return clean.padStart(64, '0');
}

function encodeBytes(value) {
  const data = strip0x(value);
  if (data.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(data)) throw new TypeError('Invalid bytes');
  const padded = data.padEnd(Math.ceil(data.length / 64) * 64, '0');
  return word(data.length / 2) + padded;
}

function encodeBytesArray(values) {
  const tails = values.map(encodeBytes);
  let cursor = values.length * 32;
  const offsets = [];
  for (const tail of tails) {
    offsets.push(word(cursor));
    cursor += tail.length / 2;
  }
  return word(values.length) + offsets.join('') + tails.join('');
}

function encodeTwoDynamicBytes(first, second) {
  const firstTail = encodeBytes(first);
  const secondTail = encodeBytesArray(second);
  const firstOffset = 64;
  const secondOffset = firstOffset + firstTail.length / 2;
  return word(firstOffset) + word(secondOffset) + firstTail + secondTail;
}

function encodeSingleTupleWithBytes(staticWords, bytesValue) {
  // ABI encoding for one tuple argument whose final field is dynamic bytes.
  const tupleHeadSize = (staticWords.length + 1) * 32;
  const tuple = staticWords.join('') + word(tupleHeadSize) + encodeBytes(bytesValue);
  return word(32) + tuple;
}

export function normalizePoolKey({ tokenA, tokenB, fee, tickSpacing, hooks }) {
  const a = tokenA.toLowerCase();
  const b = tokenB.toLowerCase();
  if (a === b) throw new Error('Choose two different tokens');
  const [currency0, currency1] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  const parsedFee = Number(fee);
  const parsedSpacing = Number(tickSpacing);
  if (!Number.isInteger(parsedFee) || parsedFee < 0 || parsedFee > 0xffffff) throw new Error('Invalid fee tier');
  if (!Number.isInteger(parsedSpacing) || parsedSpacing < 1 || parsedSpacing > 32767) throw new Error('Invalid tick spacing');
  return { currency0, currency1, fee: parsedFee, tickSpacing: parsedSpacing, hooks };
}

function poolKeyWords(poolKey) {
  return [
    addressWord(poolKey.currency0),
    addressWord(poolKey.currency1),
    word(poolKey.fee),
    signedWord(poolKey.tickSpacing),
    addressWord(poolKey.hooks),
  ];
}

export function encodePoolTVLCall(poolKey) {
  return `0x${SELECTOR.poolTVL}${addressWord(SEPOLIA.poolManager)}${poolKeyWords(poolKey).join('')}`;
}

export function encodeV4QuoteCall({ poolKey, zeroForOne, amountIn, hookData = '0x' }) {
  const words = [
    ...poolKeyWords(poolKey),
    word(zeroForOne ? 1 : 0),
    word(amountIn),
  ];
  return `0x${SELECTOR.v4QuoteExactInputSingle}${encodeSingleTupleWithBytes(words, hookData)}`;
}

function encodeExactInputSingle({ poolKey, zeroForOne, amountIn, amountOutMinimum, hookData = '0x' }) {
  const words = [
    ...poolKeyWords(poolKey),
    word(zeroForOne ? 1 : 0),
    word(amountIn),
    word(amountOutMinimum),
  ];
  return `0x${encodeSingleTupleWithBytes(words, hookData)}`;
}

function encodePermit2Approve(token, router, amount, expiration) {
  return `0x${SELECTOR.permit2Approve}${addressWord(token)}${addressWord(router)}${word(amount)}${word(expiration)}`;
}

function encodeErc20Approve(spender, amount) {
  return `0x${SELECTOR.erc20Approve}${addressWord(spender)}${word(amount)}`;
}

function encodeUniversalRouterExecute({ poolKey, zeroForOne, amountIn, minAmountOut, recipientAddress, deadline }) {
  const currencyIn = zeroForOne ? poolKey.currency0 : poolKey.currency1;
  const currencyOut = zeroForOne ? poolKey.currency1 : poolKey.currency0;
  const actions = '0x060c0e'; // SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE
  const params = [
    encodeExactInputSingle({ poolKey, zeroForOne, amountIn, amountOutMinimum: minAmountOut }),
    `0x${addressWord(currencyIn)}${word(amountIn)}`,
    // OPEN_DELTA (zero) takes the full swap output. The swap action above
    // enforces minAmountOut before this action transfers it to the wallet.
    `0x${addressWord(currencyOut)}${addressWord(recipientAddress)}${word(0)}`,
  ];
  const v4ActionInput = `0x${encodeTwoDynamicBytes(actions, params)}`;
  const commands = '0x10'; // V4_SWAP
  const encodedCommands = encodeBytes(commands);
  const encodedInputs = encodeBytesArray([v4ActionInput]);
  const commandsOffset = 96;
  const inputsOffset = commandsOffset + encodedCommands.length / 2;
  const args = word(commandsOffset) + word(inputsOffset) + word(deadline) + encodedCommands + encodedInputs;
  return `0x${SELECTOR.universalRouterExecute}${args}`;
}

export function buildPrivateV4Calls({ tokenIn, tokenOut, amountIn, minAmountOut, recipientAddress, poolKey, zeroForOne, deadline, permit2Expiration }) {
  const amount = BigInt(amountIn);
  const minOut = BigInt(minAmountOut);
  const maximumV4Amount = (1n << 128n) - 1n;
  const maximumPermit2Amount = (1n << 160n) - 1n;
  const maximumPermit2Expiration = (1n << 48n) - 1n;
  if (amount <= 0n || minOut <= 0n) throw new Error('Input amount and minimum output must be greater than zero.');
  if (amount > maximumV4Amount) throw new RangeError('Uniswap v4 exact-input amount exceeds uint128.');
  if (minOut > maximumV4Amount) throw new RangeError('Uniswap v4 minimum output exceeds uint128.');
  if (amount > maximumPermit2Amount) throw new RangeError('Permit2 allowance exceeds uint160.');
  if (deadline <= Math.floor(Date.now() / 1000)) throw new Error('Swap deadline has expired');
  const expiration = permit2Expiration ?? deadline;
  if (!Number.isSafeInteger(expiration) || expiration <= Math.floor(Date.now() / 1000) || expiration > maximumPermit2Expiration) {
    throw new RangeError('Permit2 expiration must be a future uint48 timestamp.');
  }
  const normalizedIn = tokenIn.toLowerCase();
  const normalizedOut = tokenOut.toLowerCase();
  if (!recipientAddress) throw new Error('Connect the wallet that should receive the public swap output.');
  if (![poolKey.currency0, poolKey.currency1].includes(normalizedIn)
      || ![poolKey.currency0, poolKey.currency1].includes(normalizedOut)
      || normalizedIn === normalizedOut) {
    throw new Error('Swap tokens must exactly match the selected Uniswap v4 pool.');
  }
  if (normalizedIn !== (zeroForOne ? poolKey.currency0 : poolKey.currency1)
      || normalizedOut !== (zeroForOne ? poolKey.currency1 : poolKey.currency0)) {
    throw new Error('Swap direction does not match the selected Uniswap v4 pool.');
  }
  return [
    { to: normalizedIn, data: encodeErc20Approve(SEPOLIA.permit2, amount), value: 0n },
    { to: SEPOLIA.permit2, data: encodePermit2Approve(normalizedIn, SEPOLIA.universalRouter, amount, expiration), value: 0n },
    { to: SEPOLIA.universalRouter, data: encodeUniversalRouterExecute({ poolKey, zeroForOne, amountIn: amount, minAmountOut: minOut, recipientAddress, deadline }), value: 0n },
  ].map(call => ({ ...call, value: call.value.toString() }));
}

export function decodeUint256Result(result) {
  const clean = strip0x(result);
  if (clean.length < 64) throw new Error('Malformed uint256 result');
  return BigInt(`0x${clean.slice(0, 64)}`);
}

export function encodePoolInitialize(poolKey, sqrtPriceX96 = 1n << 96n) {
  const words = poolKeyWords(poolKey);
  return `0x${SELECTOR.poolInitialize}${words.join('')}${word(sqrtPriceX96)}`;
}

export function encodePoolModifyLiquidity(poolKey, { tickLower, tickUpper, liquidityDelta, salt = `0x${'0'.repeat(64)}` }, hookData = '0x') {
  const keyWords = poolKeyWords(poolKey);
  const saltHex = strip0x(salt);
  if (!/^[0-9a-f]{64}$/i.test(saltHex)) throw new TypeError('Salt must be bytes32');
  const keyTuple = keyWords.join('');
  const paramsTuple = [signedWord(tickLower), signedWord(tickUpper), signedWord(liquidityDelta), saltHex.toLowerCase()].join('');
  // Both PoolKey and ModifyLiquidityParams are static tuples; hookData is the third dynamic top-level argument.
  const head = keyTuple + paramsTuple + word(10 * 32);
  return `0x${SELECTOR.poolModifyLiquidity}${head}${encodeBytes(hookData)}`;
}

export { encodeUniversalRouterExecute, encodePermit2Approve, encodeErc20Approve };
