import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPrivateV4Calls,
  addressWord,
  encodePoolInitialize,
  encodePoolModifyLiquidity,
  encodePoolTVLCall,
  encodeV4QuoteCall,
  normalizePoolKey,
  SEPOLIA,
} from '../src/v4-encoding.js';

const tokenA = '0x0000000000000000000000000000000000000002';
const tokenB = '0x0000000000000000000000000000000000000001';
const recipient = '0x0000000000000000000000000000000000000003';
const poolKey = normalizePoolKey({ tokenA, tokenB, fee: 3000, tickSpacing: 60, hooks: '0x0000000000000000000000000000000000000000' });

test('normalizes the v4 pool key by currency address', () => {
  assert.equal(poolKey.currency0, tokenB);
  assert.equal(poolKey.currency1, tokenA);
  assert.equal(poolKey.fee, 3000);
  assert.equal(poolKey.tickSpacing, 60);
});

test('builds a quoter call with a single encoded tuple argument', () => {
  const call = encodeV4QuoteCall({ poolKey, zeroForOne: false, amountIn: 10n ** 18n });
  assert.ok(call.startsWith('0x' + 'aa9d21cb'));
  assert.equal(call.slice(10, 74), '0'.repeat(62) + '20');
  assert.ok(call.length > 10 + 64 * 9);
});

test('builds pool initialization and modify-liquidity calldata', () => {
  const init = encodePoolInitialize(poolKey);
  assert.ok(init.startsWith('0x6276cbbe'));
  assert.equal((init.length - 10) / 2, 6 * 32);

  const modify = encodePoolModifyLiquidity(poolKey, { tickLower: -600, tickUpper: 600, liquidityDelta: 10n ** 22n });
  assert.ok(modify.startsWith('0x5a6bcfda'));
  assert.equal(modify.slice(10 + 9 * 64, 10 + 10 * 64), (10n * 32n).toString(16).padStart(64, '0'));
});

test('encodes a ReservesLens TVL read for the demo pool', () => {
  const call = encodePoolTVLCall(poolKey);
  assert.ok(call.startsWith('0xf95138f2'));
  assert.equal((call.length - 10) / 2, 6 * 32);
});

test('builds the ordered approve, Permit2 approve, and v4 router calls', () => {
  const calls = buildPrivateV4Calls({
    tokenIn: tokenA,
    tokenOut: tokenB,
    recipientAddress: recipient,
    amountIn: 1000n,
    minAmountOut: 900n,
    poolKey,
    zeroForOne: false,
    deadline: Math.floor(Date.now() / 1000) + 120,
  });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].to, tokenA);
  assert.equal(calls[1].to, SEPOLIA.permit2);
  assert.equal(calls[2].to, SEPOLIA.universalRouter);
  assert.equal(calls[0].data.slice(0, 10), '0x095ea7b3');
  assert.equal(calls[1].data.slice(0, 10), '0x87517c45');
  assert.equal(calls[2].data.slice(0, 10), '0x3593564c');
  assert.ok(calls[2].data.includes('060c0e'), 'uses V4 TAKE to send output to an explicit recipient');
  assert.ok(calls[2].data.includes(addressWord(recipient)), 'encodes the connected wallet as output recipient');
});

test('rejects invalid token pairs and expired swaps', () => {
  assert.throws(() => normalizePoolKey({ tokenA, tokenB: tokenA, fee: 3000, tickSpacing: 60, hooks: SEPOLIA.permit2 }));
  assert.throws(() => buildPrivateV4Calls({ tokenIn: tokenA, tokenOut: tokenB, amountIn: 1n, minAmountOut: 0n, poolKey, zeroForOne: true, deadline: 1 }));
});

test('rejects swap calls whose tokens or direction disagree with the pool key', () => {
  const args = {
    tokenIn: tokenA,
    tokenOut: tokenB,
    recipientAddress: recipient,
    amountIn: 1000n,
    minAmountOut: 900n,
    poolKey,
    zeroForOne: false,
    deadline: Math.floor(Date.now() / 1000) + 120,
  };
  assert.throws(() => buildPrivateV4Calls({ ...args, tokenIn: '0x0000000000000000000000000000000000000003' }), /exactly match/);
  assert.throws(() => buildPrivateV4Calls({ ...args, zeroForOne: true }), /direction/);
  assert.throws(() => buildPrivateV4Calls({ ...args, amountIn: 1n << 128n }), /uint128/);
  assert.throws(() => buildPrivateV4Calls({ ...args, permit2Expiration: 1n << 48n }), /uint48/);
});
