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

## Not done yet / open hooks
- **Deposit proofs (light client): in progress.** For now recipients check deposits against a snapshot synced while online.
- **RAILGUN, planned. This needs wallet-side hooks, which the wallet session will add outside `offline/`.**
  - *Shielded deposit:* unshield from RAILGUN to the escrow. The escrow must credit a deposit without a same-op call: pre-register the commitment, then claim by balance delta.
  - *Shielded redeem:* the redeemer passes a RAILGUN ShieldRequest, and the escrow calls `shield()`.
  - The wallet session reports RAILGUN shield/unshield as built but not yet tested live.
- **Device bonds:** `DeviceBondRegistry` exists in `offline/contracts` but is not deployed.
