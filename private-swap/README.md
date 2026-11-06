# Prawl confidential swap protocol (development)

This directory is the contract development workspace for Prawl's confidential
swap. It starts from the ETHGlobal encrypted vault and batching prototype and
adds the pieces the wallet needs to run a real WETH / custom-token pair:

- `contracts/VeilBatchSwap.sol` — the batch protocol (encrypted funding, orders,
  netting, oracle-priced lots, settlement, confidential credits, expiry/refund).
- `contracts/PoolLotPriceOracle.sol` — reads the lot price straight from the
  Uniswap v4 pool the batch settles against. No external feed is involved:
  there is one pool, and its own price is the quote. (Chainlink is not used.)
- `contracts/PrawlToken.sol` — fixed-supply 18-dp custom ERC-20.
- `contracts/VeilConfidentialWrapper.sol` — ERC-7984 wrapper (6-dp confidential
  units over an 18-dp underlying, `rate = 1e12`).
- `scripts/deploy.mjs` — deploys the whole stack on Sepolia and writes the
  wallet's build-time manifest.

## Status

This is **development code, not audited**. The encrypted path (funding, orders,
netting, settlement, expiry, refunds) is exercised on the FHEVM mock network,
and the Uniswap leg is exercised against a **real** v4 pool. It has not been:

- run against the live Zama gateway and real FHE coprocessors,
- run against a funded pool on a public network,
- reviewed adversarially for the minimum-output and timeout-recovery paths.

Pricing comes from the pool itself, so there is no feed to configure. That also
means a thin pool gives a manipulable quote; the batch snapshots the price when
a round opens and allows a refund when it expires, but do not point this at a
pool holding real value.

## Testing

```bash
npm ci
npm run setup:harness   # one-time: Uniswap v4 harness dependencies
npm run compile
npm test                # FHEVM mock network: 24 lifecycle tests + 3 real-pool tests
```

The suite has two halves:

- `test/veil-batch-swap.test.ts`, `test/chainlink-lot-price.test.ts`,
  `test/prawl-token.test.ts` — run on the FHEVM mock network. The swap leg is
  replaced by a 1:1 reserve (`MockBatchSwap`), so they validate the encrypted
  funding, ordering, netting, credits, expiry and refunds.
- `test/real-pool-e2e.test.ts` — the **real** Uniswap v4 path. It deploys an
  actual `PoolManager`, `UniversalRouter`, `Permit2` and a seeded pool, then
  runs `VeilBatchSwap` (not the mock) end to end: a residual is swapped on the
  real pool, a fully matched round trades nothing, and the on-chain slippage
  floor is verified. The FHE coprocessor and Zama gateway are still simulated
  by the mock engine; only the Uniswap leg is real.

Neither half verifies the live Zama gateway or a funded pool on a public
network. Both are prerequisites for a Sepolia deployment.

## Deploying the stack

The wallet enables its swap controls only when it is built with a manifest whose
code hashes match the live chain, so the manifest must come from the actual
deployment, not from a hand-written file.

```bash
cp .env.example .env            # then fill in the values
SEPOLIA_RPC_URL=... \
DEPLOYER_PRIVATE_KEY=... \
node scripts/deploy.mjs
```

The script is resumable: each finished step is recorded in
`deployments/state.json` and skipped on a re-run. It checks that every
infrastructure address has code before using it, refuses to proceed if a
transaction reverts, and verifies the deployed batch's wiring (token order,
wrappers, pool, oracle) before writing:

- `deployments/sepolia.json` — human-readable record,
- `deployments/manifest.json` — the exact JSON the wallet needs.

Then build the wallet with that manifest:

```bash
VITE_PRAWL_SWAP_DEPLOYMENT="$(cat deployments/manifest.json)" \
  pnpm --filter @prawl/wallet build
```

### Parameters

| Variable | Default | Meaning |
|---|---|---|
| `PRAWL_POOL_FEE` | `3000` | Uniswap v4 fee (hundredths of a bip) |
| `PRAWL_TICK_SPACING` | `60` | Pool tick spacing |
| `PRAWL_MIN_ROUND_SECONDS` | `60` | Minimum round duration |
| `PRAWL_MIN_USERS` | `2` | Distinct orderers needed to close a round |
| `PRAWL_REFUND_DELAY` | `3600` | Seconds after close before an unexecuted round can be refunded |
| `PRAWL_MAX_PRICE_AGE` | `1800` | Maximum age of the oracle quote |
| `PRAWL_LOT_A_UNITS` | `1e18` | Token A units per price lot |
| `PRAWL_MAX_ROUNDING_BPS` | `25` | Maximum accepted rounding error of the lot price |
| `PRAWL_TOKEN_SUPPLY` | `1e26` | Fixed PrawlToken supply |

## What the wallet assumes

The wallet reads (`apps/wallet/src/swap/`) only:

- `fundedBalance`, `currentRound`, `distinctSubmitters`, `lastUpdateTime`,
  `minRoundDuration`, `minDistinctSubmitters`, `refundDelay`, `maxPriceAge`,
  `roundPrices`, `rounds`, `closedAt`, `refundable`, `orderStatus`,
- `WRAPPER.confidentialBalanceOf`, `WRAPPER.wrap`,
  `WRAPPER.confidentialTransferAndCall`,
- `ORACLE.latestLotPrice`,

and writes `submitOrder`, `exit`, `refundOrder`, `creditOrder`. If a function
signature here changes, update `apps/wallet/src/swap/service.ts` in the same
change.
