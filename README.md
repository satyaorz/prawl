# Veil — Sepolia privacy swap demos

This workspace contains two separate demos. The current FHE batch swap is at
`/batch.html`; the earlier RAILGUN wallet demo remains at `/`. These are
testnet experiments and are not production-ready contracts.

## FHE batch flow

The FHE app wraps the demo vUSD/vETH tokens in ERC-7984 confidential tokens.
Users submit encrypted amounts and a public direction to a timed round. When a
round closes, the two aggregate totals become publicly decryptable. The
configured settlement operator verifies the gateway proof and commits a
minimum output. Anyone can then relay execution and users claim confidential
wrapper-token payouts.

```text
vUSD/vETH → wrap → encrypted round deposit → close round
→ operator prepares totals + minimum output → anyone executes residual swap
→ confidential payout → optional user unwrap
```

Internal matching is 1:1 and the current deployment scripts seed a 1:1 demo
pool. Do not reuse this settlement logic for arbitrary production token pairs:
it needs a price-aware matching rule and a protected quote/TWAP policy first.

## Privacy limits

- The sender address and direction are public in `DepositSubmitted` events.
- Input amounts stay encrypted; zero-value and overflowing additions are
  rejected by the wrapper callback without revealing which condition failed.
- Closing a round makes its aggregate totals public through the Zama Gateway.
- The matched amount, net Uniswap swap and output are public after settlement.
- The threshold is a count of submitting addresses, not an anonymity guarantee.
- Confidentiality relies on the FHEVM/Gateway threshold trust model. It does
  not hide the public residual trade or RPC metadata.

## Settlement safety and trust

The contract fixes the output minimum during `prepareSettle`; `executeSettle`
does not accept a caller-provided override. Only the immutable configured
settler may prepare a round, while anyone can submit the execution transaction.
This reduces the public caller's ability to bypass the bound, but the settler
still chooses it. The UI and keeper task use a 5% floor based on a previous
realized rate, or parity for the first round of the demo pool. That is only
suitable for the seeded demo pair; a production deployment needs an
independently validated price oracle and per-order execution constraints.

## Run and test

```bash
npm install
npm test
npm run build
SEPOLIA_RPC_URL=… node server.mjs
```

Open `http://127.0.0.1:4173/batch.html` with MetaMask on Sepolia.

```bash
cd protocol
npm test                 # FHEVM mock tests
npx hardhat compile
node scripts/demo-round.mjs  # live Sepolia round; uses burner keys from .env
npx hardhat settle --network sepolia
```

Deploying the updated contract requires a new deployment: deployed Solidity
bytecode cannot be changed in place. The current Sepolia deployment record
therefore remains on the old contract until a new stack is deployed and its
addresses are published. Do not treat a successful local test as a live
Sepolia or production verification.
