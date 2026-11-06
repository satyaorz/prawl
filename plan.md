# Private Swap Wallet — Project Plan

## Goal

Build a self-custodial wallet with a custom UI and transaction flow that can complete one private USDC → WETH swap end to end. Use established protocols and SDKs for cryptography; build the wallet experience, orchestration, safety checks, and privacy reporting ourselves.

The initial flow is:

```text
Shield USDC → privately authorize the spend → swap through supported DEX liquidity
→ reshield WETH → show the user what was and was not hidden
```

The privacy claim must be based on what an external observer can recover from the transaction and its surrounding activity. A hidden interface or locally stored history is not, by itself, transaction privacy.

## Scope decision

### Build now

1. A complete RAILGUN-based shielded swap for one supported USDC → WETH route.
2. Swap safety checks and a protected submission path, if compatible with the selected RAILGUN broadcaster flow.
3. A clear transaction status flow and privacy summary.
4. Evidence that compares the public information from a normal router swap with the information exposed by the private flow.

### Defer

- Zama FHE encrypted swap intents.
- Uniswap v4 batch matching and net settlement.
- ERC-5564/6538 stealth receiving, relayer-funded gas, and broader private RPC work.
- Hiding the token pair or the aggregate public movement through a DEX pool.

The first release must not depend on encrypted intents or batch matching. RAILGUN shielded swaps and Zama encrypted intents are separate execution paths; do not assume they compose.

## User-visible privacy promise

For the supported flow, explain which sender, recipient, and amount fields are protected by shielded notes and which facts remain public. A public DEX settlement can expose the pool/token pair, aggregate pool deltas, execution time, and other transaction metadata. Deposits, withdrawals, relayers, RPC providers, quote providers, and the broadcaster can also see or infer information depending on the chosen path.

Do not promise that every observer is unable to link the user's activity. Report observed leakage and infrastructure trust boundaries, and distinguish protocol guarantees from best-effort metadata reduction.

## Phase 0 — Integration and network decision

Resolve the integration choices before building the full transaction flow:

1. Select a chain and one USDC/WETH route with usable liquidity and compatible RAILGUN support.
2. Verify the current RAILGUN Wallet SDK/Cookbook cross-contract swap and reshield path for that chain, including any 7702/Relay Adapt requirements.
3. Map the broadcaster submission path. Specifically determine whether the RAILGUN flow can use Flashbots Protect at `https://rpc.flashbots.net?hint=hash`. Do not assume the two submission paths can be combined.
4. Choose a protected route supported by the actual transaction path. If Flashbots Protect is incompatible, document the supported alternative and its privacy/MEV trade-offs before proceeding.
5. Confirm supported token behavior, proof-generation requirements, relayer/broadcaster requirements, and recovery behavior for failed or delayed transactions.
6. Write a threat model describing what the wallet, RPC provider, quote source, relayer/broadcaster, searchers, and public chain can observe.

**Exit criteria:** a short integration note identifies the selected chain, token addresses, DEX route, supported RAILGUN flow, submission path, trust assumptions, and known limitations. The path can atomically swap and reshield output into a private balance.

## Phase 1 — Wallet foundation

1. Scaffold the wallet application and contract workspace using the repository's chosen framework. A practical default is React/TypeScript for the wallet and Solidity/Foundry for contracts if the repository has no existing stack.
2. Implement account creation/import, signing, network configuration, and recovery guidance. Keep secret material out of logs and analytics.
3. Add private balance discovery and local transaction history with appropriate local protection.
4. Build the core screens: connect/create wallet, shielded balance, swap form, transaction progress, and privacy summary.

**Exit criteria:** a user can create or import an account, view the selected network and supported assets, and understand the transaction states before swap orchestration is added.

## Phase 2 — P0: end-to-end private swap

1. Allowlist the initial USDC and WETH contracts and validate chain, decimals, balances, and required approvals.
2. Shield USDC and confirm that the private balance is available before starting the swap.
3. Build the RAILGUN transaction flow: private spend authorization, proof generation, supported cross-contract swap, and atomic reshield of WETH.
4. Keep proof generation and signing local where the supported SDK permits it. Do not expose notes, seeds, or private history to application telemetry.
5. Show progress states for preparation, proof generation, signing, submission, confirmation, and recovery. Treat timeouts as pending/unknown until reconciled; never report success without evidence of the reshielded output.
6. Handle user rejection, insufficient balance, stale quote, proof failure, relayer failure, transaction revert, and delayed confirmation with actionable status.

**Exit criteria:** from the wallet, a user can shield USDC, execute one supported USDC → WETH swap, and see WETH in a private balance. The flow handles expected failures without losing track of funds or reporting false success.

## Phase 3 — P0: swap safety and protected submission

1. Simulate the proposed transaction before signing and reject unsupported or unsafe routes.
2. Enforce a token allowlist, minimum output, deadline, and configurable price-impact limit in the execution path wherever supported. Display the quote, limits, and expiry before signing.
3. Submit through the protected route confirmed in Phase 0. For Ethereum Flashbots Protect, use the selected endpoint and `hint=hash` only if it is compatible with the chosen transaction path.
4. Make fallback behavior explicit. If protected submission is unavailable, ask the user to choose whether to retry or use a clearly labeled route with different exposure; do not silently downgrade.
5. Do not describe protected submission as a guarantee against sandwiching. It reduces public-mempool exposure; execution bounds remain necessary, and the receiving infrastructure still processes the transaction.

**Exit criteria:** expired or invalid quotes are rejected; a swap cannot execute below its enforced minimum output; the UI identifies the actual submission route and its limits.

## Phase 4 — Privacy leakage report and demo

1. Capture a representative normal-router swap and the wallet's private swap using the same chain and comparable route where possible.
2. Inspect public transaction data: sender, recipient, calldata, events, token transfers, pool identity, pool deltas, and timing.
3. Record relevant off-chain requests in a controlled development environment: RPC calls, quote requests, and broadcaster submissions. Do not include secrets in capture output.
4. Produce a side-by-side report with fields labeled **hidden**, **public**, **inferred**, or **provider-visible**, and link each claim to captured evidence or a protocol guarantee.
5. Turn the supported-flow observations into repeatable privacy regression checks.

**Exit criteria:** the demo shows actual evidence for what an observer can and cannot recover. It explicitly shows the public DEX pool and aggregate trade information that remain visible.

## Later roadmap

After the private swap flow is complete and its privacy boundaries are understood, consider these as separate projects:

1. **Private receiving and reads:** ERC-5564 stealth addresses, ERC-6538 registry integration, relayer-funded gas where supported, privacy-preserving RPC routes, and quote discovery without wallet identifiers.
2. **Encrypted intents:** evaluate the current `@zama-fhe/sdk` and define a confidential order flow as a separate execution path. Specify what ciphertext, sender, timing, and settlement data remain visible.
3. **Uniswap v4 batch settlement:** start with USDC/WETH, match opposing orders, and settle only the net residual through a vault and v4 adapter. Define fill rules, partial fills, refunds, censorship behavior, and a settlement verifier. A hook cannot be added to an already-created pool.

None of these later features is required for the initial swap milestone.

## Suggested code layout

Adapt this to the existing repository conventions and actual SDK APIs:

```text
src/
  wallet/
    accounts.ts             # account lifecycle and signing boundary
    privateBalances.ts      # private balance discovery
    transactionHistory.ts   # local transaction history
  privacy/
    shieldedSwap.ts         # shield → prove → swap → reshield orchestration
    proofGenerator.ts       # wrapper around supported proof APIs
    privacySummary.ts       # user-visible guarantees and limits
  trading/
    quoteEngine.ts          # quotes without unnecessary wallet identifiers
    swapSafety.ts           # simulation, allowlist, bounds, expiry
    mevProtection.ts        # selected broadcaster/protected submission path
    swapRouter.ts           # supported route and public comparison route

contracts/                  # only if the selected integration requires custom contracts
tests/
  swapSecurity.test.ts
  privacyLeakage.test.ts
```

Do not add FHE intent or v4 batch contracts to the initial implementation.

## Acceptance criteria for the first milestone

- [ ] The selected chain, contracts, RAILGUN flow, and broadcaster path are documented and verified.
- [ ] User can create/import a wallet and see their supported private balance.
- [ ] User can shield USDC, authorize a private spend, and generate the required proof.
- [ ] The supported DEX swap completes and WETH is reshielded into the user's private balance.
- [ ] Minimum output, quote expiry/deadline, allowlist, simulation, and price-impact checks are enforced as supported by the route.
- [ ] The wallet shows accurate pending, failed, and completed states and does not claim success before private output confirmation.
- [ ] Submission route and its privacy/MEV limitations are visible; there is no silent public-mempool fallback.
- [ ] The privacy report compares the normal route and private route using captured execution evidence.
- [ ] The UI does not claim to hide the public pool, token pair, aggregate pool movement, or metadata visible to infrastructure providers.

The first milestone is complete when all criteria pass for one supported USDC → WETH route. Only then should the project expand to more tokens, chains, or the deferred features.

## Key risks to revisit

- **SDK and chain support:** RAILGUN support, cross-contract behavior, and 7702/Relay Adapt requirements may change. Pin versions and re-check before integration updates.
- **Submission compatibility:** protected RPC submission and a RAILGUN broadcaster may not be interchangeable. Validate the actual transaction path instead of assuming a combined setup.
- **Privacy inference:** timing, deposits, withdrawals, pool deltas, and provider metadata can weaken unlinkability even when private notes protect transaction fields.
- **Proof UX:** browser proof generation can be slow or resource-intensive. Measure it on the target device and surface progress and recovery states.
- **Token and route behavior:** initially exclude rebasing, fee-on-transfer, or otherwise unsupported assets unless the integration explicitly handles them.
- **Liquidity and demo reliability:** validate the selected route and maintain a deterministic development/demo setup without presenting mock evidence as production privacy.
