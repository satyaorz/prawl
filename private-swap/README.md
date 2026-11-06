# Prawl confidential swap protocol (development)

This directory is the contract development workspace for Prawl's confidential
swap. It starts from the ETHGlobal encrypted vault and batching prototype and
adds the pieces the wallet needs to run a real WETH / custom-token pair:

- `contracts/VeilBatchSwap.sol` — the batch protocol (encrypted funding, orders,
  netting, oracle-priced lots, settlement, confidential credits, expiry/refund).
- `contracts/PoolLotPriceOracle.sol` — reads the lot price straight from the
  Uniswap v4 pool the batch settles against. No external feed is involved:
  there is one pool, and its own price is the quote.
- `contracts/PrawlToken.sol` — fixed-supply 18-dp custom ERC-20.
- `contracts/VeilConfidentialWrapper.sol` — ERC-7984 wrapper (6-dp confidential
  units over an 18-dp underlying, `rate = 1e12`).
- `scripts/deploy.mjs` — deploys the whole stack on Sepolia and writes the
  wallet's build-time manifest.

## Status

This is **development code, not audited**. It has run end to end on Sepolia, at small
scale, against the **live Zama gateway** and a **real Uniswap v4 pool** (see
"Live deployment" below): encrypted funding, encrypted orders, closing, publishing the
net, trading it on Uniswap, confidential credits, and an exit. It has not been reviewed
adversarially, and it must not be pointed at a pool holding real value.

Pricing comes from the pool itself, so there is no feed to configure. That also means a
thin pool gives a manipulable quote. Two guards bound that: the batch snapshots the price
when a round opens and refuses to settle if the live pool price has moved more than 2%
from the snapshot, and the Universal Router enforces a 97% output floor. A time-weighted
price would be stronger and is not built.

## Testing

```bash
npm ci --ignore-scripts   # scripts off: a git dependency's install script needs rimraf and fails otherwise
npm run setup:harness   # one-time: Uniswap v4 harness dependencies
npm run compile
npm test                # FHEVM mock network: 24 lifecycle tests + 3 real-pool tests
```

The suite has two halves:

- `test/veil-batch-swap.test.ts`,
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

## Live deployment (Sepolia)

| | |
|---|---|
| Batch (`VeilBatchSwap` v6, current) | `0x82937779eA2969a694Be9970e30971f3483C1811` |
| Earlier batch (v5, superseded) | `0x7D18B237fd0555C5f046EA9bbb1cBCf7b175C741` |
| PRAWL token (tokenA, currency0) | `0xce7d494Ca57BAc8bC3bE5964C5fA8D7da4338Fb3` |
| WETH (tokenB, currency1) | `0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14` |
| c-PRAWL wrapper | `0x2B4f777Eda45293AAAb1ac9beAE250A4dCC1cfcc` |
| c-WETH wrapper | `0x7C091e777CA1acA96446e8D8751878c2E7765Ddf` |
| Oracle (`PoolLotPriceOracle`) | `0xF3aeA35313Ad7CA3bdE064779E32b6497fCbC526` |
| Pool id (fee 3000, spacing 60, no hook) | `0xc3e2a961ffb3b1e017f6d6061aa561c6adbe72a4966d93b65241d703cf73a5aa` |
| PoolManager / UniversalRouter / Permit2 | Uniswap's Sepolia deployments (addresses in `scripts/deploy.mjs`) |

Evidence on Sepolia, **v6, run through the Prowl wallet UI over Tor** (a fresh passkey-derived account funded
from the private balance; the only scripted part is a second participant). Everything after the order was
done by the wallet itself, with no keeper running:

| Step | Transaction |
|---|---|
| v6 batch deployed | `0x44f4159f8957dc7c04bf121996f1ffa3a80670ace5f5ef385a519f797b67469e` |
| wallet's encrypted order (fresh account) | `0xada88b2fc1b397ce36827b81a081f5bd04ccf961b9f4299cffa0094694f466d2` |
| counterparty's encrypted order (scripted) | `0x2e18f6363bfbf023c1856fda70077182bef426e79b04f8dd191b6881cacebe8b` |
| round closed (by the wallet) | `0x037d8603bc7cb904d084a0234dfdbbcccbab57961d03bd7aeeecdd44727fd61a` |
| net published (1 lot) | `0xea06e8865ea7d44b378fc0d80302a349b156183c0cb0f33b07e9c1a77827f984` |
| **net traded on Uniswap v4** (one `PoolManager` Swap event in this tx) | `0xd74086bc05847ad820f708ca31fae35c60ee91f90a17fd8d7562a2f4d310db6c` |
| wallet's payout credited | `0xbd52a4e8eb2dcc2787abcfcce852f5bea512a27fb41ddcbc0f3e288ecbd83661` |
| counterparty's payout credited (keeper, afterwards) | `0x8b1bf81852fc36524d7d03720ab5e9126dbbdb449d1c4dd0f5d25e77f4bb77a8` |
| wallet's exit requested | `0x997d3f4cb5c5276750fc90963086ba2b50b8cf35572b3864f543df924ebd8140` |
| wallet's exit released (by the wallet) | `0x1fe13e2c4b7cdbca1e47e94135b18e2f87463b1c69789f378c47ff61c2e6a6b8` |

In that round the wallet sold 2 lots of WETH and the counterparty sold 1 lot of the custom token: one lot
matched at the quoted price and one lot (the residual) traded on the pool. The deployment, pool seed and
pool id are in the table above (the pool and wrappers are shared by v5 and v6).

Earlier evidence from v5, driven by scripts: a round settled and credited, and an exit finalized (settle tx
`0xa9647e53cb0d00f34cea663fec480984de98cfac0ffbb396e04ea033bd6511d6`). Decrypting the vaults afterwards
showed the deployer with 199 B units (100 matched + 99 from the pool) and the counterparty with exactly 1
lot of A. v6 changed one thing in the contract: a round's clock starts at its first order (v5 let anyone
refund the first order of a round that had sat empty for over an hour).

## What is hidden and what is not

Hidden: each order's direction, size and minimum; how much of a round was matched; each
payout; vault balances.

Not hidden:
- Wrapping, funding and exiting are public steps: the amounts, the asset (the `Funded` event
  names it) and the address are visible. An account that only ever funded one asset can only
  sell that asset, so its direction is effectively public.
- Which addresses ordered in a round, and when.
- The round's **net** trade, its side, and the price it traded at.

Limits you should know about:
- "At least N participants" counts **addresses**, not people. One honest user plus one extra
  account closes a round, and in a two-account round the other account can work out your order
  from the public net and its own order. A liquidity bot would make the net equal one user's
  order, so rounds should not be padded that way if the privacy claim matters.
- Several colluding accounts can recover the last participant's order.
- This is order-intent privacy and a smaller footprint on Uniswap, **not anonymity**.
- The wallet's "fresh private account" mode funds the swap account straight from the private
  balance, so no transaction links it to the main address. The wrap, fund and exit amounts are
  still public on that fresh account.

## Running it

```bash
npm ci --ignore-scripts && npm run setup:harness && npm run compile && npm test
cp .env.example .env.local        # SEPOLIA_RPC_URL, DEPLOYER_PRIVATE_KEY, COUNTERPARTY_PRIVATE_KEY
node scripts/deploy.mjs           # resumable; writes deployments/manifest.json
node scripts/keeper.mjs           # anyone can run it: closes, settles, credits, finalizes exits
LIVE_EXIT=1 node scripts/live-round.mjs   # a live round with two scripted accounts
```

The wallet advances its own rounds (close, publish, settle, credit, exit), so a keeper is only
needed when nobody has the wallet open. Every step is permissionless and credits only ever land
in an order's own encrypted balance.
