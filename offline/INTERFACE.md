# Offline pay ↔ wallet interface

Owner: the offline-pay work (`offline/`). The wallet (everything outside `offline/`) calls in through what is listed here. Status as of 2026-11-06.

## Deployed contract (Sepolia, chain 11155111)
**PrawlEscrowV3** at `0x70b3B7EdCD18087C999ec80e3C3B0227c7e0D6E5`. Source: `offline/contracts-v3/src/PrawlEscrowV3.sol`; details: `offline/DEPLOYMENTS.md`.

| Call | Who | What |
|---|---|---|
| `deposit(bytes32 coinId, uint64 expiry, uint256 k0x, uint256 k0y)` payable | wallet (online), from the account named as `depositor` in the coin header | Locks `msg.value` as an offline coin owned by the phone's genesis one-time key (k0x, k0y). Stores `deposits[coinId] = keccak256(abi.encode(value, expiry, k0x, k0y, msg.sender))` at storage slot 0. `expiry` must be ≤ now + 30 days |
| `redeem(Header, Spend[], Redemption)` | anyone (the payout is fixed by the phone's signature) | Pays one phone-signed REDEEM output to its payout address |
| `reclaim(Header)` | depositor, after expiry + 1 day | Returns unredeemed value. A frozen coin's remainder goes to `compensationSink` instead |
| `proveEquivocation(...)` | anyone | Two different spends signed by one one-time key freeze that key's subtree |

**Measured Sepolia gas** (Sepolia runs a fork newer than Fusaka, with pricier storage):
- deposit: 138,194;
- redeem at depth 1: 536,030;
- redeem at depth 2: 467,429 / 357,202 (path already recorded).

## Data the phone hands the wallet
`mint3_<label>.json`: the deposit inputs. It contains:
- `coinId` (hex64), `chainId`, `escrow` (hex40), `expiry` (unix s), `value` (wei, decimal string);
- `k0x`/`k0y` (hex);
- `depositor` (hex40, which must be the account that sends `deposit`);
- `k0` (attestation cert ids) and `certs`.

The phone must be told the depositor address before minting (`-e depositor`), because it is part of the on-chain commitment. Reference sender: `offline/contracts-v3/tools/sepolia_deposit.sh` (checks everything, simulates, sends, reads back at the receipt block).

`redeem3_<label>_<alias>.json`: a phone-signed redemption. Submit it with `offline/contracts-v3/tools/sepolia_redeem.sh`, or encode it with `tools/v3_bundle_args.py`.

## Protocol
`offline/SPEC-v3.md`. Coins are notes owned by Android hardware one-time keys (`setMaxUsageCount(1)`, attested); a spend can split a note into several outputs with change.

## Escrow v3.1 (RAILGUN, refresh): Sepolia `0x236b1dC3b1a90E23728DA6E361b0Ab1C386cd779`
Same coin format and the same `deposit`, `redeem`, `reclaim` and `proveEquivocation` as v3, plus:

| Call | Who | What |
|---|---|---|
| `commitDeposit(DepositParams)` then fund then `activate(DepositParams)` | wallet; `activate` by anyone | **Private load.** Reserve the coin id, send WETH from a RAILGUN unshield to `depositAddress(params)`, then activate. Slot 0 holds the same commitment as v3, so deposit proofs are unchanged. `params.depositor` is only the reclaim address |
| `redeemToShield(Header, Spend[], Redemption, ShieldRequest)` | anyone | **Private cash-out.** The phone signed over `sha256(abi.encode(ShieldRequest))`, so the request cannot be swapped. The escrow wraps ETH and calls RAILGUN `shield` |
| `refresh(Header, Spend[], Redemption, newCoinId, newExpiry, newK0x, newK0y)` | anyone | Moves a note's value into a new coin with a new expiry, with no ETH movement |

Full ABI, gas, threat analysis and the exact encodings: the v3.1 `RESULTS.md` in the research tree (not pushed) and `offline/HANDOFF.md` §5-§9 (link payloads `load-private`, `shield-target`, `redeem-shield`).

**Measured on real Sepolia:** deploy 30.4M gas (Sepolia accepts it; mainnet rules would not). Estimated Sepolia gas (read-only): `commitDeposit` 137k, `activate` about 460k, `redeemToShield` 1.4-1.6M, `refresh` 0.3-0.7M. These RAILGUN flows were tested against the real RAILGUN contracts on a local fork, **not yet live**.

## Not done yet / open hooks
- **Wallet side of the v1.1 payloads** (`load-private`, `shield-target`, `redeem-shield`): the wallet session is building them.
- **Device bonds:** `DeviceBondRegistry` exists in `offline/contracts` but is not deployed.
- **Zero-knowledge attestation:** proves on a phone in about 2.5 s but is not yet in the payment format. It covers RKP chains; factory StrongBox chains are in progress.
- **Revocation list:** the app bundles Google's list, fetched 2026-11-05. After 48 hours phones only accept payments up to 0.05 ETH until it is refreshed from Settings while online.
