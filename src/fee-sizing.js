// Pure fee-sizing helpers shared by the RAILGUN runtime and the UI.
// The broadcaster is paid from the tokens the Relay Adapt contract receives
// alongside the swap input, so the swap input must leave room for the fee.
// Keeping these pure lets node tests cover the math without a browser engine.

// Reserve the estimated fee plus 25% headroom for gas movement between the
// estimate and the final proof.
export function computeFeeReserve(feeAmount) {
  const fee = BigInt(feeAmount);
  if (fee < 0n) throw new RangeError('Fee cannot be negative');
  return (fee * 5n) / 4n;
}

// Returns { swapInput, error? } — swapInput is what the Uniswap call should
// spend; the unshielded remainder (fee reserve) covers the broadcaster fee and
// re-shields back to the user's private balance.
export function sizeSwapInput(unshieldAmount, feeAmount) {
  const unshield = BigInt(unshieldAmount);
  const fee = BigInt(feeAmount);
  const reserve = computeFeeReserve(fee);
  const swapInput = unshield - reserve;
  if (swapInput <= 0n) {
    return { swapInput: 0n, error: `Broadcaster fee (~${fee}) exceeds the swap input. Shield more tokens first.` };
  }
  return { swapInput, error: null };
}

// The quote ran against a larger input than the fee-sized swap input. Output of
// a fixed pool is super-linear in input, so scaling the quoted minimum down by
// input ratio is a conservative lower bound that still guards slippage.
export function scaleMinimumOut(minimumOut, quotedInput, actualInput) {
  const minOut = BigInt(minimumOut);
  const quoted = BigInt(quotedInput);
  const actual = BigInt(actualInput);
  if (quoted <= 0n) throw new RangeError('Quoted input must be greater than zero');
  if (actual <= 0n) throw new RangeError('Actual input must be greater than zero');
  if (actual > quoted) return minOut; // never raise the minimum because of sizing
  return (minOut * actual) / quoted;
}
