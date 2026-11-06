# Uniswap v4 developer feedback (from building Prowl's private swap)

We built a confidential batch swap that settles its **net** trade on a real Uniswap v4
pool through the Universal Router, from a smart contract, on Sepolia. This file lists the
friction we actually hit, what worked, and what we would ask for. Everything here comes
from this repository (`private-swap/`); line references are to the code that shows it.

## What worked

- **`V4_SWAP` through the Universal Router from a contract settled real rounds.**
  `VeilBatchSwap._swapExactInput` encodes `SWAP_EXACT_IN_SINGLE` + `SETTLE_ALL` + `TAKE`
  and a live Sepolia round traded its net lot through the pool (settle tx
  `0xa9647e53cb0d00f34cea663fec480984de98cfac0ffbb396e04ea033bd6511d6`).
- **`StateView` made verification easy.** After seeding we assert on chain that the pool
  has active liquidity at its current price (`getSlot0`, `getLiquidity`).
- **`PoolModifyLiquidityTest` on Sepolia** is the quickest way to seed a testnet pool.
- The official Sepolia deployment table was accurate: every address we use had code and
  matched (`PoolManager`, `UniversalRouter`, `Permit2`, `StateView`, `PoolModifyLiquidityTest`).

## Friction, in the order we hit it

1. **Compiling v4 + the router under Hardhat 2 needs a setup script.**
   `private-swap/scripts/setup-harness.sh` exists only because: the v4 sources import
   `solmate` and `forge-std` by bare name; `@uniswap/permit2`'s package has no `main`, so a
   bare `permit2` import cannot resolve (we copy `src/` into a minimal package);
   `universal-router` imports `@uniswap/v3-periphery` for its migration path, so two
   interfaces have to be stubbed; and exact pragmas differ across the three source trees.
   *Ask:* Hardhat-friendly packaging, or a documented "call the router from your contract"
   template that compiles out of the box.

2. **Swapping from a contract means a Permit2 sequence the docs treat as an EOA flow.**
   `forceApprove(permit2)` → `permit2.approve(token, router, amount, expiry)` →
   `router.execute` (see `VeilBatchSwap.sol`, `_swapExactInput`). *Ask:* a short "swap from a smart contract" example.

3. **Encoding a v4 swap by hand is easy to get subtly wrong.** The action byte string and
   the parameter ABI (`ExactInputSingleParams`, `SETTLE_ALL`'s currency + max amount, `TAKE`'s
   recipient + min amount) have to line up exactly (see `_swapExactInput`).
   *Ask:* a typed encoder in `v4-periphery`.

4. **Seeding a pool needs a hand-derived liquidity amount, and a wrong tick range fails silently.**
   Our first deploy script initialised the pool at 100 token per WETH (tick ~ -46054) but added
   liquidity in ticks -600..600. The transaction succeeded and the pool had **zero** liquidity at
   its price, so any swap would cross an empty range. Passing `MaxInt256` as `liquidityDelta`
   reverts with `SafeCastOverflow`. We now compute `L = min(amount0·√P, amount1/√P)` for a
   full-range position and assert active liquidity afterwards.
   *Ask:* a helper that takes token amounts and a range and returns `liquidityDelta`, and a
   warning when a position is not in range at the current price.

5. **Reading the price on chain is manipulable.** `StateLibrary.getSlot0` is a spot read.
   Our oracle (`PoolLotPriceOracle.sol`) uses it, then guards with a 2% bound between a round's
   snapshot and the live price at settlement, plus the router's `amountOutMinimum`.
   *Ask:* an official time-weighted-price or oracle-hook pattern for on-chain consumers.

6. **Hooks see the router as `sender`.** We considered a hook that only lets our batch trade,
   but the hook cannot tell who is behind the router without a trusted-router + `hookData`
   convention. We shipped without a hook. *Ask:* a documented pattern for restricting a pool to
   one caller.

## Integration facts

- Pool: Sepolia, fee 3000, tick spacing 60, no hook; full-range liquidity.
- Time to first working integration, docs rating (1-5), support rating (1-5): **to be filled in by
  the team before submitting; the Uniswap feedback form asks for these.**
- We did not use the Uniswap API or an SDK in the wallet; the wallet reads the pool price through
  our oracle contract.
