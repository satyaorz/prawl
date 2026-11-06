import test from 'node:test';
import assert from 'node:assert/strict';
import { computeFeeReserve, sizeSwapInput, scaleMinimumOut } from '../src/fee-sizing.js';

test('fee reserve adds 25% headroom to the broadcaster fee', () => {
  assert.equal(computeFeeReserve(1_000_000n), 1_250_000n);
  assert.equal(computeFeeReserve(0n), 0n);
  assert.equal(computeFeeReserve(1n), 1n); // integer math floors
  assert.throws(() => computeFeeReserve(-1n), RangeError);
});

test('swap input shrinks by the fee reserve and fails closed on tiny inputs', () => {
  const { swapInput, error } = sizeSwapInput(1_000_000_000n, 1_000_000n);
  assert.equal(swapInput, 1_000_000_000n - 1_250_000n);
  assert.equal(error, null);

  const tiny = sizeSwapInput(1_000n, 1_000n);
  assert.equal(tiny.swapInput, 0n);
  assert.match(tiny.error, /exceeds the swap input/);
});

test('minimum output scales down with the fee-sized input, never up', () => {
  // quoted at 997_500 of 1_000_000; actual input 995_000 → scale down
  const scaled = scaleMinimumOut(500_000n, 997_500n, 995_000n);
  assert.equal(scaled, (500_000n * 995_000n) / 997_500n);
  // actual equal to quoted keeps the minimum intact
  assert.equal(scaleMinimumOut(500_000n, 997_500n, 997_500n), 500_000n);
  // actual larger than quoted never raises the minimum
  assert.equal(scaleMinimumOut(500_000n, 997_500n, 999_999n), 500_000n);
  assert.throws(() => scaleMinimumOut(1n, 0n, 1n), RangeError);
  assert.throws(() => scaleMinimumOut(1n, 1n, 0n), RangeError);
});
