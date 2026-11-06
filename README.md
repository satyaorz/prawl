# Veil — Private Batched Swaps on Ethereum Sepolia

**Veil** is a working demonstration of *confidential DeFi*: users swap one token
for another through a batched auction where **what you traded, how much, which
way, and what you received are all encrypted on-chain** — verified by the Zama
FHEVM fully homomorphic encryption stack, settled against a real Uniswap v4
pool, and running live on Ethereum Sepolia.

> ⚠️ **This is a hackathon-grade testnet demo.** It runs on Sepolia with mock
> tokens. It is not audited, not production-ready, and the demo pair is
> intentionally 1:1-priced. See [Honest privacy limits](#honest-privacy-limits)
> for exactly what is and is not hidden.

---

## Table of contents

1. [What problem does this solve?](#what-problem-does-this-solve)
2. [The one-paragraph version](#the-one-paragraph-version)
3. [How a round works, step by step](#how-a-round-works-step-by-step)
4. [What is encrypted vs. what is public](#what-is-encrypted-vs-what-is-public)
5. [The privacy design decisions](#the-privacy-design-decisions)
6. [Architecture](#architecture)
7. [Live deployment (Sepolia)](#live-deployment-sepolia)
8. [Using the app](#using-the-app)
9. [The keeper daemon](#the-keeper-daemon)
10. [Contract API reference](#contract-api-reference)
11. [Running it yourself](#running-it-yourself)
12. [Testing](#testing)
13. [Honest privacy limits](#honest-privacy-limits)
14. [Security and trust assumptions](#security-and-trust-assumptions)
15. [Repository layout](#repository-layout)
16. [Known limitations and future work](#known-limitations-and-future-work)

---

## What problem does this solve?

On a normal DEX (Uniswap, etc.), every swap is a public event:

- **who** traded (wallet address),
- **which token pair and direction** they traded,
- **exactly how much** they bought and sold,
- **when** they traded.

This is a permanent, publicly queryable record of everyone's trading activity.
It enables front-running, copy-trading, wallet profiling, and de-anonymization
of users who thought a pseudonymous address was enough.

Veil explores a different model: **users place orders into a batch, and the
batch — not the individual — is what the blockchain sees.** Inside the batch,
every number is a fully homomorphic encryption (FHE) ciphertext: the contract
can compute on encrypted amounts (sum them, compare them, match them against
each other) *without ever decrypting them*. Only the minimal aggregate
information needed to execute one net trade on Uniswap is ever revealed.

## The one-paragraph version

Users fund a **confidential vault** (ERC-7984 wrapped tokens) once — that
funding transaction is public, by design. After that, each round they submit an
**order whose direction (buy A→B or B→A) and size are both encrypted** through
a single shared entry point that does not reveal which token they are selling.
When the round's timer closes, the contract **nets all orders against each
other inside FHE** — matched orders cancel 1:1 and never touch a DEX — and
only the *net residual* (one encrypted number) plus *which side had the
surplus* are decrypted via the Zama Gateway. The keeper swaps only that net
residual on Uniswap v4, and every user's payout is **credited back into their
encrypted vault balance** — no plaintext payout transaction ever links a
wallet to an amount received.

## How a round works, step by step

```
        ┌─────────────────────────────────────────────────────────────┐
        │ 1. FUND (public by design)                                  │
        │    vUSD → wrap → c-vUSD (ERC-7984) → transfer into vault    │
        │    vault balance stored as euint64 — encrypted forever      │
        ├─────────────────────────────────────────────────────────────┤
        │ 2. ORDER (fully encrypted)                                  │
        │    submitOrder(encryptedAmount, encryptedDirection)         │
        │    • direction: euint8  (1 = sell A→B, 2 = sell B→A)        │
        │    • amount:    euint64 (in c-token units)                  │
        │    • one shared entry point for BOTH assets — the path      │
        │      reveals no side; the event reveals no direction/amount │
        ├─────────────────────────────────────────────────────────────┤
        │ 3. CLOSE (encrypted netting inside FHE)                     │
        │    for every pair of opposite-direction orders:             │
        │        m = min(remaining_i, remaining_j)  ← computed on     │
        │        matched_i += m; remaining_i -= m      CIPHERTEXTS     │
        │    → per-order matched / residual stay encrypted            │
        │    → round totals aToB / bToA stay encrypted                │
        ├─────────────────────────────────────────────────────────────┤
        │ 4. DECRYPT THE MINIMUM (the only public decryption)         │
        │    Zama Gateway publicly decrypts exactly two values:       │
        │        net          = |totalA − totalB|   (the residual)    │
        │        surplus side = A or B                                │
        │    Never decrypted: totals, matched, any user's order       │
        ├─────────────────────────────────────────────────────────────┤
        │ 5. SWAP THE NET (public, necessarily)                       │
        │    unwrap net residual → Uniswap v4 swap → wrap output      │
        │    slippage floor enforced on-chain (90% of net)            │
        ├─────────────────────────────────────────────────────────────┤
        │ 6. PAY OUT (confidential)                                   │
        │    creditOrder: payout = matched_i (deficit side, 1:1)      │
        │                = matched_i + residual_i × swapOutput/net    │
        │                  (surplus side — division by the PUBLIC net)│
        │    → credited to the user's ENCRYPTED vault balance         │
        │    → permissionless: anyone can credit anyone               │
        ├─────────────────────────────────────────────────────────────┤
        │ 7. EXIT (optional, public by design)                        │
        │    exit(): unwrap vault balance → plain tokens to wallet    │
        └─────────────────────────────────────────────────────────────┘
```

**Why netting matters:** if Alice sells 5 vUSD and Bob sells 5 vUSD→vETH in the
opposite direction, they match 1:1 *inside the contract* and **nothing at all
happens on Uniswap**. Only imbalances between the two sides ever trade.

## What is encrypted vs. what is public

| Information | Status | Notes |
|---|---|---|
| Your order **direction** | 🔒 encrypted (euint8) | never decrypted, not even at settlement |
| Your order **amount** | 🔒 encrypted (euint64) | never decrypted, ever |
| Your **vault balance** | 🔒 encrypted | only you can decrypt it (userDecrypt) |
| Your **payout amount** | 🔒 encrypted | credited inside FHE to your vault |
| Round **directional totals** | 🔒 encrypted | never decrypted — not even the operator sees them |
| **Matched amount** | 🔒 encrypted | never decrypted |
| **Net residual** | 🌐 public | it trades on Uniswap — cannot be hidden |
| **Surplus side** (A or B) | 🌐 public | needed to route the net swap |
| Round **timing / pair / pool** | 🌐 public | the batch exists and when it closes |
| **Funding / exit transactions** | 🌐 public | wallet + token + amount (by design — see below) |
| **Which addresses ordered** | 🌐 public | orderer addresses are linkable (see limits) |

## The privacy design decisions

These are the deliberate choices, and the reasoning behind each:

1. **Funding is separate from trading.** The funding transaction necessarily
   reveals wallet, token and amount — that leg is not claimed private. But
   because subsequent orders draw down an accumulated *encrypted* balance, the
   funding amount does not reveal the size or direction of any individual
   order. You can fund once and trade many times.

2. **Direction is encrypted, not just amount.** Most "private swap" designs
   encrypt the amount but leave the direction as a plaintext function argument
   (or worse, log it in an event). That leaks the side you're on even when the
   size is hidden. Veil encrypts direction as an `euint8` and computes the
   per-asset debit with `FHE.select` on the encrypted direction bit — the
   contract never learns which token you are selling.

3. **One shared order path.** Encrypting direction is not enough if selling
   A means calling a different function or a different token wrapper than
   selling B — the *call itself* reveals the side. Both confidential tokens
   are held in the batch contract's shared vault, and both directions go
   through the identical `submitOrder` entry point.

4. **Totals stay encrypted.** A common shortcut is to decrypt the two
   directional totals at close time and compute matching in the clear. That
   hands observers the aggregate order book every round. Veil runs the netting
   *inside FHE* and publicly decrypts only the net residual and surplus side —
   the minimum needed to execute the Uniswap leg.

5. **Payouts stay confidential.** Paying out plain ERC-20 tokens in the
   settlement flow would re-expose the exact amount each user received, and
   link it to their wallet. Payouts are credited to the encrypted vault
   balance instead. Converting to plain tokens is a separate, explicit,
   intentionally-public exit step the user controls.

6. **No encrypted division — by design, not accident.** fhEVM has no
   encrypted÷encrypted division. Rather than leaking totals to compute pro-rata
   shares in the clear, the matching algorithm is structured so division is
   only ever by *public* values (the net residual). Deficit-side payouts are
   exactly their matched amount; the surplus side's Uniswap output share is
   `residual × swapOutput / net`.

## Architecture

```
┌────────────────────────── Browser (batch.html) ──────────────────────────┐
│  Minimal UI: balances (plain + 🔒 vault), direction toggle, amount,      │
│  one "Private swap" button, withdraw buttons, status line, engine log    │
│                                                                          │
│  • encrypts order (amount + direction) client-side via relayer SDK       │
│  • signs txs via raw EIP-1193 (MetaMask)                                 │
│  • decrypts own vault balances via EIP-712-signed userDecrypt             │
└───────────────┬──────────────────────────────────────────────────────────┘
                │ https (localhost:4173)
┌───────────────▼──────────────────────────────────────────────────────────┐
│  server.mjs — static host + JSON-RPC proxy (/rpc) + config/artifacts     │
└───────────────┬──────────────────────────────────────────────────────────┘
                │ RPC
┌───────────────▼──────────────────────────────────────────────────────────┐
│  Ethereum Sepolia                                                        │
│                                                                          │
│  VeilBatchSwap (v3)  ← the whole protocol: vault + orders + netting +    │
│        │                        settlement + confidential payouts        │
│        │ holds c-vUSD + c-vETH (shared vault)                           │
│        ▼                                                                 │
│  ERC7984ERC20Wrapper ×2 (OpenZeppelin) — c-vUSD / c-vETH                 │
│        │ wrap/unwrap underlying vUSD / vETH (ERC-20 mocks)               │
│        ▼                                                                 │
│  Zama FHEVM: ACL, KMS verifier, gateway coprocessors (publicDecrypt,     │
│  input verification, EIP-712 user decryption)                            │
│                                                                          │
│  Uniswap v4 PoolManager + Universal Router + Permit2 — the net leg       │
└───────────────▲──────────────────────────────────────────────────────────┘
                │
┌───────────────┴──────────────────────────────────────────────────────────┐
│  keeper.mjs — "the party that's always online"                           │
│                                                                          │
│  every 8s: close round → gateway-decrypt (net, surplus) → prepareSettle  │
│  → executeSettle → creditOrder for every orderer → finalize pending      │
│  unwraps → liquidity bot (see below)                                     │
│                                                                          │
│  Every step it drives is permissionless on-chain — the keeper only pays  │
│  gas; it holds no privileged power over user funds.                      │
└──────────────────────────────────────────────────────────────────────────┘
```

**The liquidity bot.** A round needs at least 2 distinct orderers to close.
If a single trader has waited out the round window, the keeper submits an
encrypted counter-order (1 c-unit) from its own funded balance — in a random
direction, because *directions are encrypted and even the keeper can't see
which side needs liquidity*. Either way the round completes for the waiting
trader: opposite direction → matched 1:1 internally; same direction → both
join the net leg on Uniswap.

## Live deployment (Sepolia)

Current stack (deployed 2026-11-06, block 12076649):

| Contract | Address |
|---|---|
| **VeilBatchSwap v3** | `0x136e2A0F4a48d5f5cFC3821934B86a1B0dA286c0` |
| c-vUSD (ERC-7984 wrapper of vUSD) | `0x361a17402c7bdc5Ac779e1DB9c1c81395472280a` |
| c-vETH (ERC-7984 wrapper of vETH) | `0x8F382Fb7221F655dc57796Ca95DF7586b576eaa1` |
| vUSD (ERC-20 mock, 18 dp, public faucet) | `0x430dCF0916f8a70C9368FAf9CE98Fa0f2Cd7E61D` |
| vETH (ERC-20 mock, 18 dp, public faucet) | `0xbb10CF47311deC8c9C4085A2Bf637571882095fc` |
| Uniswap v4 pool (vUSD/vETH, 0.30%, tick 60) | poolId `0xb4dd10273ec0c23ccd4375c06c741452cf8cb86d3c9dc868a161609fa89c7934` |

Round parameters: **60s minimum round duration, ≥2 distinct orderers** to close.
The full machine-readable record lives in `batch-config.json`.

## Using the app

1. `npm install && npm run build`, then `SEPOLIA_RPC_URL=… node server.mjs`
2. Open `http://127.0.0.1:4173/batch.html` in a browser with MetaMask on Sepolia.
3. **Connect** — the page shows your plain vUSD/vETH and your 🔒 vault balances.
4. Pick a direction, type an amount, click **Private swap**:
   - if your vault balance is short, the button first funds it (approve → wrap
     → confidential transfer — up to 3 signatures, one time),
   - then it submits your **encrypted order** (one signature).
5. That's it. The keeper closes the round, nets it, swaps the net on Uniswap,
   and credits your payout **back into your 🔒 vault balance** automatically.
6. **Withdraw vUSD / vETH** moves vault funds back to plain tokens in your
   wallet (a public leg, finalized by the keeper a minute or two later).

## The keeper daemon

```bash
cd protocol
export $(grep -v '^#' .env | xargs)          # keeper burner key
SEPOLIA_RPC_URL=… node scripts/keeper.mjs    # 8s tick loop
```

Responsibilities, in tick order: close eligible rounds → gateway-decrypt the
net/surplus (with retries — gateway propagation is asynchronous) →
`prepareSettle` → `executeSettle` → `creditOrder` for every orderer found in
`OrderSubmitted` events → finalize any pending unwrap requests → liquidity bot.
All of these are permissionless contract calls; the keeper is an automation,
not an authority. It also funds its own vault once (tracked in
`scripts/bot-funded.json`) so its counter-orders draw on encrypted balances.

## Contract API reference

`VeilBatchSwap` (v3) — the complete protocol in one contract:

| Function | Who | What |
|---|---|---|
| `onConfidentialTransferReceived` | wrappers | funding: empty/`0x00` data credits the caller's encrypted vault balance |
| `fundedBalance(user, asset)` | view | encrypted handle of a vault balance (decrypt it yourself) |
| `submitOrder(encAmt, proof, encDir, proof)` | anyone | encrypted order from the vault balance; one order per user per round; max 6 per round |
| `closeRound()` | anyone | after the timer + threshold: encrypted pairwise netting; only net + surplus become publicly decryptable |
| `prepareSettle(roundId, clearValues, proof)` | settler | verifies gateway signatures over (net, surplus); sets the on-chain 90% slippage floor; opens the unwrap request |
| `executeSettle(roundId, cleartext, proof)` | anyone | finalizes the unwrap, swaps the net on Uniswap v4, wraps the output, enforces the floor |
| `creditOrder(roundId, user)` | anyone | credits the orderer's payout into their encrypted vault balance; single-credit enforced |
| `exit(asset, encAmt, proof)` | anyone | unwrap part of your own vault balance to plain tokens (public leg) |

Events: `Funded(user, asset)`, `OrderSubmitted(round, user)` — **no direction,
no amount** — `RoundClosed`, `RoundPrepared(round, net, unwrapHandle)`,
`RoundSettled(round, surplusSide, net, swapOutput)` — **no matched amount** —
`OrderCredited(round, user)`.

## Running it yourself

```bash
# root: web app
npm install
npm test          # unit + server tests
npm run build     # vite build → dist/

# protocol: contracts
cd protocol
npm install
npx hardhat compile
npx hardhat test                    # FHEVM mock network, 9 tests

# deploy a fresh stack to Sepolia (uses protocol/.env burner keys)
VEIL_REDEPLOY_BATCH=1 SEPOLIA_RPC_URL=… node scripts/deploy-stack.mjs
# optional knobs: VEIL_MIN_ROUND_SECONDS=30 VEIL_MIN_USERS=2

# seed the demo pool with two-sided liquidity, then run the keeper
node scripts/seed-pool.mjs
SEPOLIA_RPC_URL=… node scripts/keeper.mjs
```

`batch-config.json` is the single source of truth for deployed addresses; the
server exposes it at `/batch-config` and the UI refuses to run against a
contract whose `VERSION()` doesn't match.

## Testing

- **`protocol/test/veil-batch-swap.test.ts`** (9 tests, FHEVM mock network):
  funding credits encrypted balances; order events carry no direction/amount;
  encrypted direction debits the correct side; underfunded orders are silently
  zeroed; two-sided rounds settle with correct matched/surplus math; fully
  matched rounds need no swap leg; creditOrder is permissionless but
  single-credit; exit unwraps to plain tokens; one order per user per round.
- **Root tests** (`npm test`): server proxy, fee-sizing, config handling.
- **Live E2E** (Sepolia, proven 2026-11-06): fund → encrypted order → bot
  counter-order → encrypted close → `net=2000000, surplusSide=A` decrypt →
  Uniswap swap → confidential credit (vault grew by 5.78 c-vETH) →
  `exit` → 5.0 plain vETH received.

## Honest privacy limits

This demo is built to be honest about what it does *not* hide:

- **Funding and exits are public.** The wallet, token and amount of the
  fund/unwrap legs are visible. The design claim is narrower: those amounts do
  not reveal individual order sizes or directions.
- **Orderer addresses are linkable.** `OrderSubmitted` and `OrderCredited`
  carry the user's address (required for permissionless crediting). An
  observer learns *that* an address traded in a round — not which side, not
  how much, not what it received. On-chain storage of the orderer array is
  also readable by anyone with `eth_getStorageAt`.
- **The net trade is public.** The residual must trade on Uniswap; its size,
  direction and timing are visible. Batching makes the *net* much smaller than
  the sum of individual orders, which blurs order patterns — it is **not** an
  anonymity guarantee, and with few participants the net can approximate a
  single order.
- **Round metadata is public.** Round timing, the token pair, and the fact
  that you interacted with the protocol at all.
- **FHE trust model.** Confidentiality rests on the Zama FHEVM threshold
  cryptography (KMS/gateway coprocessors), not on this contract alone.
- **The demo pair is 1:1.** Internal matching assumes parity pricing. Real
  pairs need price-aware matching, per-order execution bounds, and an
  independent oracle before any of this is production-viable.

## Security and trust assumptions

- **The settler role.** Only the immutable configured settler (the keeper's
  address) may call `prepareSettle` and commit the gateway-verified values;
  `executeSettle` is permissionless and cannot override the on-chain slippage
  floor. The settler cannot steal funds — it can only delay settlement or
  commit wrong decryptions, which the gateway signature verification rejects.
- **Slippage guard.** `minSwapOutput = 90% × net` is computed on-chain at
  prepare time; execution reverts if the Uniswap leg returns less. For the
  seeded ~1:1 demo pool this is a conservative bound, not an oracle price.
- **Underfunded orders.** An order larger than the encrypted vault balance is
  silently zeroed (the OpenZeppelin confidential-token pattern): no revert
  oracle leaks balance information, and the UI checks your own decryptable
  balance before submitting.
- **Burner keys.** The keeper/operator keys in `protocol/.env` are testnet
  burners, gitignored, and hold no authority over user funds.
- **Not audited.** Zero external review. Do not deploy this with real value.

## Repository layout

```
├── batch.html                  # the minimal private-swap UI
├── src/batch.js                # UI logic (encrypt, sign, decrypt, fund)
├── server.mjs                  # static host + /rpc proxy + /batch-config
├── batch-config.json           # live deployment record (addresses, knobs)
├── index.html, src/app.js      # legacy RAILGUN wallet demo (separate app)
├── test/                       # root unit tests
└── protocol/
    ├── contracts/VeilBatchSwap.sol        # the whole protocol (v3)
    ├── contracts/VeilConfidentialWrapper.sol
    ├── contracts/mocks/                   # ERC20Mock, MockBatchSwap (1:1 test double)
    ├── test/veil-batch-swap.test.ts       # 9-test FHEVM mock suite
    ├── scripts/
    │   ├── deploy-stack.mjs    # deploy/redeploy the stack, write batch-config.json
    │   ├── seed-pool.mjs       # two-sided liquidity for the demo pool
    │   ├── keeper.mjs          # the automation daemon (close→settle→credit→bot)
    │   ├── verify-v3.mjs       # live E2E: fund + encrypted order + self-decrypt
    │   ├── check-vault.mjs     # decrypt your own vault balances on live
    │   └── test-exit.mjs       # live E2E: exit to plain tokens
    └── .env                    # burner keys (gitignored)
```

## Known limitations and future work

- **Order cap per round** (6) bounds the O(n²) encrypted-netting gas; larger
  batches need a cheaper netting strategy.
- **One order per user per round** — multiple orders from one address in the
  same round are rejected (they would self-net; supporting them needs
  per-order accounting).
- **1:1 internal pricing** — real pairs need price-aware matching.
- **No MEV protection on the net leg** — the residual trades with a 90% floor;
  a production version would use on-chain oracle bounds or batch auctions.
- **Session keys (ERC-7710)** would remove the repeated signatures for
  funding/wrapping.
- **Address-linkability** of orderers is the biggest remaining privacy gap;
  designs like stealth-address registration or a separate commitment layer
  (e.g. a nullifier tree) are the natural next step.

---

*Built for ETHGlobal with Zama FHEVM, OpenZeppelin confidential contracts, and
Uniswap v4. Testnet only — everything here can and will change.*
