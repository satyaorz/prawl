# Plan 2 — Private Swap Wallet (ETHGlobal)

> Goal: a self-custody wallet where swaps are **genuinely private on-chain** — not just hidden in the
> frontend. We reuse open-source contracts, circuits and SDKs (RAILGUN, Flashbots, ERC-5564), but
> build our **own wallet UI, transaction flow and privacy orchestration**.

> **Scope note (v1):** we are building **private swaps only — no encrypted intents**. Intent-based
> designs (Zama FHEVM confidential orders, Uniswap v4 batch netting) are deferred to a future
> milestone. See §10.

---

## 1. North star

One complete private swap, end to end, from our own wallet:

```
Shield USDC → private spend authorization (ZK proof) → swap through public DEX liquidity
→ atomic reshield of WETH → submission via protected relayer → UI shows the real privacy guarantees.
```

Demo centerpiece: run the *same swap* through a normal public router and through our privacy stack,
side by side, and show exactly what a public observer can see in each case.

---

## 2. Feature set (revised priority order — swaps first, no intents)

| Priority | # | Feature | Implementation approach |
|---|---|---------|------------------------|
| **P0** | 1 | Private swaps + hidden sender/recipient | RAILGUN Wallet SDK + Cookbook. Flow: shield → ZK proof → swap → reshield, with broadcaster submission. |
| **P0** | 2 | Private mempool + sandwich resistance | Submit via Flashbots Protect (`https://rpc.flashbots.net?hint=hash`). Enforce `minAmountOut`, deadlines, price-impact checks, token allowlists, pre-trade simulation. |
| **P1** | 3 | Private receiving addresses + ENS | ERC-5564 stealth addresses + ERC-6538 registry; relayer-funded gas where supported. |
| **P1** | 4 | Private RPC reads + quote requests | Privacy-preserving RPC routes, local tx history, protected quote discovery. Never leak wallet identifiers to quote APIs. |
| **P2** | 5 | Privacy leakage verification | Observer service that inspects calldata, events, pool deltas, sender addresses and RPC requests; renders a "what the public can see" report. |
| **Deferred** | 6 | Hidden swap amount/direction/slippage (encrypted intents) | Zama FHEVM confidential intent contract — **not in v1**. |
| **Deferred** | 7 | Private batch swaps on Uniswap v4 | Encrypted-intent batcher + net settlement — **not in v1** (depends on #6). |

**Scope decision:** ship features 1–2 (the private swap core), then 3–5 to strengthen guarantees and
the demo. Intents and v4 batch netting wait until the swap pipeline is solid.

---

## 3. What can we actually hide?

| Information | Hidable? | Mechanism |
|---|---|---|
| Sender | ✅ Yes | Shielded authorization (RAILGUN notes) |
| Recipient | ✅ Yes | Shielded outputs / stealth addresses |
| Individual amount | ⚠️ Deferred | Shielded notes hide *private balances*; the swap leg itself is public until intents land |
| Swap direction | ⚠️ Deferred | Needs confidential venue / matched batch (deferred) |
| Slippage / price limit | ⚠️ Deferred | Encrypted order conditions (deferred); v1 uses visible `minAmountOut` + deadline guardrails |
| Token pair | ❌ Not in v1 | Needs confidential execution/matching design |
| Aggregate public Uniswap swap | ❌ No | The swap leg executes on public liquidity; shield/unshield boundaries are public by design |

> Be explicit in the UI about this: v1 hides **who** (sender/recipient linkage) and **what balance
> moves privately**; it does not yet hide **how much is swapped** or **which pair** on the DEX leg.

---

## 4. Architecture

```
┌────────────────────────────── Wallet (ours) ──────────────────────────────┐
│  UI / keys / accounts / local private balance + history / privacy dashboard │
└──────┬───────────────────────────────────────────────┬────────────────────┘
       │                                               │
┌──────▼───────┐                              ┌────────▼─────────┐
│ RAILGUN SDK  │                              │ Trading layer    │
│ shield/notes │                              │ quotes, guard-   │
│ ZK proofs    │                              │ rails, router    │
│ priv balances│                              │ fallback path    │
└──────┬───────┘                              └────────┬─────────┘
       │                                               │
┌──────▼────────────────────────────────────────────────▼─────────┐
│ Submission: Flashbots Protect (hint=hash) + RAILGUN broadcaster  │
└──────────────────────────────────────────────────────────────────┘
```

Key separation of concerns:
- **Our wallet**: interface, key management, local private history, UX, orchestration, guardrails.
- **RAILGUN cryptographic components**: note creation, proof generation, private balances,
  private cross-contract transactions (shield → swap → reshield atomically).
- **Flashbots Protect**: mempool privacy + sandwich resistance for the public swap leg.

> ⚠️ Before integrating: verify the actively supported RAILGUN **7702 / Relay Adapt** cross-contract
> path. Use RAILGUN engine/Wallet SDK/Cookbook — do **not** fork Railway Wallet.
>
> ℹ️ Privacy Pools v2: has an embeddable SDK + LI.FI swaps, but its documented withdraw-and-swap
> sends output to a recipient rather than reshielding it (reshield = future work). RAILGUN's
> cross-contract flow is the closer fit for atomic private swaps — noted, not our starting point.

---

## 5. Codebase structure

```
src/
  wallet/
    keys.ts                  # key derivation, storage
    accounts.ts              # account lifecycle
    privateBalances.ts       # RAILGUN private balance sync

  privacy/
    shieldedSwap.ts          # shield → prove → swap → reshield orchestration
    proofGenerator.ts        # ZK proof generation wrapper
    stealthAddress.ts        # ERC-5564 / ERC-6538
    privateRpc.ts            # private reads + protected quote discovery

  trading/
    quoteEngine.ts           # quotes without leaking wallet identity
    mevProtection.ts         # Flashbots Protect submission, hint policy,
                             # minAmountOut / deadline / price-impact guardrails
    swapRouter.ts            # public fallback path (for demo comparison)

  observer/
    leakageMonitor.ts        # calldata/events/pool-delta watcher (feature 5)

contracts/
  (vendored open-source only — RAILGUN + stealth registry; no custom
   intent/settlement contracts in v1)

tests/
  swapSecurity.test.ts       # minAmountOut, deadlines, simulation, allowlists
  privacyLeakage.test.ts     # automated "what does an observer see" assertions
```

> Deferred contracts (`ConfidentialIntent.sol`, `BatchSettlement.sol`, `UniswapV4Adapter.sol`,
> `SettlementVerifier.sol`) move out of scope with the intent milestone (§10).

---

## 6. Phased implementation plan

### Phase 0 — Skeleton & environment (0.5 day)
- [ ] Monorepo scaffold per §5 (app + tests; vendored contracts only).
- [ ] Wallet core: keys, accounts, send/receive on a supported testnet.
- [ ] CI: lint, unit tests.
- [ ] Spike: confirm current RAILGUN SDK version + **7702/Relay Adapt** support on our target
      chain; verify testnet USDC/WETH liquidity for the swap leg.

### Phase 1 (P0) — Private swap end to end (2–3 days) ← *first milestone*
- [ ] Integrate RAILGUN Wallet SDK: shield USDC into private balance.
- [ ] Private spend authorization + note/proof generation (`proofGenerator.ts`).
- [ ] Cross-contract swap through public DEX liquidity with **atomic reshield of WETH**
      (`shieldedSwap.ts`).
- [ ] Broadcaster submission path (relayer submits, wallet doesn't self-expose).
- [ ] UI: shield / private balance / swap / private history screens.
- [ ] Acceptance: swap completes; on-chain tx shows no sender→token linkage; output sits in a new
      shielded note.

### Phase 2 (P0) — Protected mempool (1 day)
- [ ] Route submissions through `https://rpc.flashbots.net?hint=hash`.
- [ ] Enforce per-trade guardrails in `mevProtection.ts`: `minAmountOut`, tx deadline,
      price-impact cap, token allowlist, pre-trade simulation (`eth_call` fork sim).
- [ ] Tests (`swapSecurity.test.ts`): revert paths for slippage/deadline/sim failure.
- [ ] Known limits documented in-UI: receiving infra still sees the tx; the swap leg is public.

### Phase 3 (P1) — Stealth receiving + private reads (1–2 days)
- [ ] ERC-5564 stealth address generation/announcement; ERC-6538 registry lookup by ENS.
- [ ] Stealth receive flow in UI; scanning/announcement discovery.
- [ ] Relayer-funded gas for stealth receives where supported.
- [ ] `privateRpc.ts`: local tx history first; no wallet identifiers to quote APIs;
      privacy-preserving RPC route for balance/quote reads.

### Phase 4 (P2) — Privacy leakage verification (1–2 days)
- [ ] Observer service (`observer/leakageMonitor.ts`): watches mempool/calldata/events/pool
      deltas/RPC egress.
- [ ] `privacyLeakage.test.ts`: automated assertions on what is recoverable per phase.
- [ ] Side-by-side report UI: normal router swap vs our stack — public fields compared.
- [ ] This doubles as the hackathon demo script generator.

---

## 7. Tech stack

| Layer | Choice |
|---|---|
| Wallet SDK | RAILGUN Wallet SDK + Cookbook (engine, not Railway Wallet) |
| Private tx submission | RAILGUN Broadcaster + Flashbots Protect (`hint=hash`) |
| Stealth | ERC-5564 + ERC-6538 |
| DEX | Public DEX liquidity via RAILGUN cross-contract calls; public router (demo baseline) |
| Contracts | Vendored open-source only; Foundry for tests |
| Frontend | React/TypeScript wallet UI (ours) |
| Tests | Vitest/Jest + Foundry fuzz + leakage observer |

---

## 8. Risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| RAILGUN 7702/Relay Adapt path changes or is unsupported on target chain | Blocks Phase 1 | Spike in Phase 0; keep withdraw→shield fallback; pin SDK versions |
| Proof generation latency in browser | UX | Worker threads / background proof queue; show progress states |
| Testnet liquidity for USDC/WETH | Demo | Use well-supported testnet pools; document swap sizes that won't price-impact |
| Flashbots Protect ≠ full privacy | Expectation gap | Document in-UI: hint=hash limits searcher disclosure, but receiving infra sees the tx and the swap leg is public |
| Public swap leg reveals amount/pair | Expectation gap | Be explicit (§3); it's the documented v1 boundary, resolved later by deferred intent milestone |
| Scope creep (intents pulled back in early) | Missed deadline | §10 gates the intent milestone on a working swap pipeline |

---

## 9. Non-goals for v1

- **Encrypted intents / FHEVM confidential orders** (hidden amount, direction, price limit).
- **Uniswap v4 batch netting** (depends on intents).
- Hiding the **token pair** on a public pool.
- Forking an existing wallet (Railway) instead of building our UI/orchestration.
- Privacy Pools v2 reshield-swap (upstream doesn't support atomic reshield output yet).

---

## 10. Deferred milestone — encrypted intents & v4 batch netting (future)

Trigger: only after Phases 0–4 are demo-ready.

1. **Encrypted intents (FHEVM)** — encrypt amount/direction/price limit with `@zama-fhe/sdk`
   (never the deprecated `@zama-fhe/relayer-sdk`); `ConfidentialIntent.sol` with ACL checks.
   Note: makes *order data* confidential; does not make a public pool private by itself.
2. **v4 batch netting** — one pair (USDC/WETH), encrypted-intent batcher, match opposing trades,
   settle only the net on Uniswap v4 via `BatchSettlement.sol` + `UniswapV4Adapter.sol`, with
   `SettlementVerifier.sol` so the matcher can't alter fills or steal. No custom hook in v1 of this
   milestone (hooks are fixed at pool creation).
3. This milestone is what upgrades §3's deferred rows (amount/direction/slippage) to ✅.

---

## 11. Definition of done (hackathon demo)

1. Live wallet: shield USDC → private swap → reshield WETH, submitted via protected relayer.
2. On-chain evidence: no sender→swap linkage; output in a fresh shielded note.
3. Observer report: side-by-side "normal router vs our stack" leakage comparison.
4. Guardrails proven: slippage/deadline/simulation revert tests pass.
5. UI honestly states the v1 boundary: who is hidden, how much/pair is public until the intent
   milestone ships.

---

## 12. Production-readiness audit (2025-11-06) — DONE

Full audit of the shipped stack; every finding fixed and re-verified in a real
headless Chromium run against the live Sepolia deployment.

**Bugs found & fixed (src/batch.js):**
1. `sendTx` called `.request()` on the ethers `BrowserProvider` (only `.send()`
   exists) → every tx button crashed (`n.request is not a function`). Now signs
   via raw EIP-1193 `window.ethereum.request` with an explicit guard.
2. `sendTx` receipt wait referenced a removed `provider` variable → crash after
   broadcast. Now waits via the read provider.
3. `state.account` kept MetaMask's lowercase address; the FHEVM SDK requires
   EIP-55 checksummed → `createEncryptedInput` rejected deposits. Normalized
   with `getAddress()` at connect.
4. `readProvider()` used a **relative** URL (`/rpc`) — ethers v6 throws
   `UNSUPPORTED_OPERATION unsupported protocol /rpc` at request time. This
   killed the whole read-only path (Transparency load-from-chain, treasury,
   round ledger, receipt waits) for wallet-less visitors. Now absolutized
   against `location.href`.
5. `getFhevm()` passed `network: window.ethereum` with no fallback →
   `FhevmConfigError` without a wallet, so Transparency could not decrypt round
   totals for read-only visitors. Now falls back to the `/rpc` proxy URL;
   verified publicDecrypt works wallet-free (round 1 & 2: 150000000/100000000).
6. Zero confidential-balance handles (`0x000…0`) were sent to `userDecrypt`
   (gateway rejects) → now short-circuited to 0 locally.
7. `settleRound` read `dec.clearValues[handle]` unguarded → `undefined` could
   reach settlement math. Added tolerant `clearValue()` extractor (case
   variants, throws loudly).
8. Website `executeSettle` passed `minSwapOutput = 0` — slippage guard
   disabled. Now anchored to the last executed round's realized rate × 95%
   (logged in the Engine Log; first-ever swap leg degrades to 0 with a loud
   warning).
9. Wrap button re-sent `approve` every time; a reload during the receipt wait
   left users stuck pre-wrap (the deposit-revert root cause). Now skips approve
   when allowance suffices.
10. `deployStack` had no confirmation → a stray click would orphan the live
    stack. Now requires explicit `confirm()`.

**Cleanup:** removed debug bisect artifacts (`dbg.mjs`, `swaptest*.mjs`,
`probe.mjs`, `poolcheck.mjs`, `ACL.mjs`, `mocks/SwapProbe.sol`); hardened
`.gitignore` (`**/.env`, `cache/`, `deployments/`, `dist/`, `*.log`); added
inline favicon (clean console); rewrote README to lead with the FHE product.

**Verification (all green):**
- `npm test` root: 19/19. `npx hardhat test`: 6/6. `vite build`: clean.
- ESLint (`no-undef`): 0 errors.
- Headless Chromium (real build, live Sepolia via `/rpc`): boot, connect
  (mocked EIP-1193), faucet, wrap (approve correctly skipped), deposit (real
  FHEVM SDK encrypt + correct `confidentialTransferAndCall` calldata),
  Transparency round 2 load-from-chain **without wallet** (full state incl.
  decrypted totals), Operator settle error path ("Round 2 is already
  settled."), auto-keeper start/stop — **zero page errors** in every run.
- Not covered: a *real* browser-signed round (MetaMask) — the scripted
  `demo-round.mjs` rounds 1–2 remain the on-chain evidence.

## 13. Speed/UX implementation (T1–T3) — 2026-11-06 (post-audit session)

**T1a — round knobs:** `minRoundDuration`/`minDistinctSubmitters` are constructor
immutables (no setters) → folded into the T2b redeploy (30 s, 2 users).
Note: the deployed contract exposes no getter for these immutables — the
website/keeper must read the duration from `batch-config.json`.

**T1b — pool depth:** `scripts/seed-pool.mjs` added ~90,000 units of two-sided
liquidity to the Sepolia v4 pool (±600 ticks, same salt), txs 12076088–90.
Economic effect verified by the next swap's realized rate.

**T1c — keeper state machine (`scripts/keeper.mjs`, daemon):** every 8 s it
runs close → gateway decrypt (retry/backoff) → `prepareSettle` (slippage guard
anchored to the last realized rate) → `executeSettle` (RoundPrepared-event
handle recovery) → permissionless claims → finalize of ANY pending unwrap
requests. Event scans go to publicnode (Alchemy free tier = 10-block
`eth_getLogs`); rounds() decoded adaptively (12- vs 13-field struct layouts
across deployments); handles extracted by byte-slicing raw log data.
Lessons: immutables have no getters; `ethers.getAddress` rejects 32-byte
padded topics (slice 26 chars); event topic order is (hash, p1, p2, p3).

**T1d — frontend:** batch-lifecycle timeline (5 live stages: open → closed →
decrypting → Uniswap swap → payout, 10 s poll) + live quote line (last
realized batch rate, ±5 % guard, honest "no swap executed yet" state) in the
deposit card. All round reads route through an adaptive `getRoundInfo`.

**T2a — permissionless underlying payouts:** `VeilBatchSwap.withdrawForAndUnwrap(roundId, direction, user)` — anyone claims FOR any depositor; the batch
burns its own c-token share via the OZ wrapper's `euint64` unwrap overload
(creator is ACL-allowed; no client inputProof needed) and queues an async
unwrap paying the user plain vUSD/vETH. `ClaimedForUser` event. Legacy
`withdraw` (c-token payout) kept. New hardhat test proves a third party
claims for both sides, finalizes the unwrap, and the user receives
underlying — 11/11 tests pass.

**T2b — redeploy:** after restoring `deployments/state.json` + config (a
leftover auto-runner had silently redeployed an orphan stack at 16:05 and
repointed state — killed the process, restored the user's stack), redeployed
with `VEIL_REDEPLOY_BATCH=1 VEIL_MIN_ROUND_SECONDS=30 VEIL_MIN_USERS=2`:
new batch `0x7A6798596FAFE3bb4fFB6e867506C045DbB9407F`, **wrappers reused**
(user c-token balances preserved), config updated, keeper restarted.

**T3a — one-click swap (EIP-5792):** `oneClickSwap()` probes
`wallet_getCapabilities` for atomic batching, encrypts client-side (FHE input
binding preserved — batching happens in the wallet, not Multicall), then ONE
`wallet_sendCalls` (faucet-mint if needed + approve + wrap + encrypted
deposit), polls `wallet_getCallsStatus`; sequential sendTx fallback. Headless
Chromium proof: 0 sequential txs, batch confirmed, "Deposited in ONE
signature ⚡".

**End-to-end proof (`scripts/e2e-round.mjs` + keeper):** alice 5 c-vUSD and
bob 5 c-vETH deposited (their last signatures); keeper closed round 1
(30 s/2-user threshold), decrypted totals 5M/5M (fully matched, zero AMM
leg), prepared, executed, claimed for both, finalized both unwraps:
alice received 5.0 vETH, bob 5.0 vUSD — **users signed nothing after
deposit**. Root tests 19/19, hardhat 11/11, build clean.

**Verification:** root `npm test` 19/19; hardhat 11/11; vite build clean;
headless smoke (timeline 5 stages, quote, one-click atomic path) zero page
errors.

## 14. One-click incident + fixes — 2026-11-06 (later)

**Incident:** the user's first real `wallet_sendCalls` run (MetaMask, Sepolia)
revealed three issues:
1. MetaMask returns the batch id as an OBJECT, not the EIP-5792 string —
   status polling polled `[object Object]`. Fixed: normalize
   `string | {id|batchId|capabilities.id}`, log the raw response as JSON, and
   fall back to on-chain verification (watch `DepositSubmitted` for the user
   for 90 s) whenever the wallet's status API is unusable.
2. **Unit bug:** the one-click approve+wrap reused the 6 dp c-token amount for
   18 dp underlying operations — "wrap 10 vUSD" moved 0.00000000001 vUSD.
   Fixed: `uAmount = cAmount × wrapper.rate()` (verified 10 c-vUSD → 1e19 wei).
3. **FHE × EIP-7702 interaction:** in the atomic batch a *valid* 10M encrypted
   deposit was transferred to the batch yet rejected by
   `onConfidentialTransferReceived`'s FHE acceptance (deposit handle decrypts
   to 0; totalAIn excluded it; the refund did not restore the user's c-balance
   — 10M c-vUSD unaccounted, likely stranded in the batch). Root cause not yet
   isolated (suspect input-proof/ACL validation under 7702 delegation).
   Decision: **sequential signing is the default** for one-click (every step
   proven on this deployment); atomic stays opt-in via
   `window.veilAtomicBatching = true`. The user was made whole with a 10 vUSD
   faucet mint (block 12076367).

**Keeper additions:** direction-aware slippage anchoring (realized rate only
when the surplus side matches; conservative 90%-of-net floor for the first leg
in a direction — `getSlot0` reverts on this v4 deployment so no live pool
price) and a **liquidity bot**: when one trader has waited out the round
window, the keeper deposits 1 c-unit in each direction so solo user rounds
always complete. `MissingSwapMinimum` deadlock (minOut=0 + net>0) eliminated.

**State after fixes:** batch `0x7A679859…` round 3 open; user compensated
(30 vUSD, 9.748138 vETH); keeper daemon running with bot + claims + finalize.

## 15. Privacy hardening v3 + minimal UI (2026-11-06)

User-directed privacy target, implemented in full:

1. **Funding separate from trading** — users fund a confidential vault balance
   once (public leg, honest labeling); orders draw on the funded balance.
2. **Encrypted direction + amount, one shared entry point** — `submitOrder`
   takes an encrypted euint64 amount and euint8 direction from a single
   client-side input. The order event carries only (round, user). Both
   c-tokens live in the batch vault, so the entry path reveals no side.
   Underfunded orders are silently zeroed (OZ pattern — no revert oracle).
3. **Encrypted round totals** — closeRound runs greedy pairwise netting
   inside FHE (`m = min(remaining_i, remaining_j)` over opposite-direction
   pairs; fhEVM has no encrypted÷encrypted division, so pro-rata is avoided:
   deficit payouts = matched exactly; surplus payouts = matched +
   residual × swapOutput / net with division by the PUBLIC net only). Only
   net + surplus side are publicly decryptable; totals/matched/orders never.
4. **Confidential payouts** — `creditOrder` (permissionless) credits the
   user's vault balance; no plain ERC-20 in the settlement flow. `exit`
   unwraps to plain tokens as an explicitly public leg.
5. **Honest disclosures** — relayer, timing, pair, net Uniswap trade and
   orderer ADDRESSES remain public; the UI states batching is not an
   anonymity guarantee.

Live: batch v3 `0x136e2A0F4a48d5f5cFC3821934B86a1B0dA286c0` (block 12076649),
wrappers reused. Hardhat 9/9 (new suite). E2E proven on Sepolia: fund →
encrypted order → bot counter-order → encrypted close → net=2M/surplus=A
decrypt → swap → confidential credit (vault 5.78 c-vETH) → exit → 5.0 vETH.
Keeper: bot funds once (marker file) then submits random-direction encrypted
orders; tick guard fixed to allow the bot on round 1.

UI rebuilt minimal: balances (plain + 🔒 vault), direction toggle, amount,
one Private swap button (auto-funds), two withdraw buttons, status line,
collapsed engine log. Honest-privacy note on the page.
