# Prawl

A privacy-first Ethereum wallet for the browser.

- **Private balance first.** Your main account is a RAILGUN shielded balance; the public address is only the way in and out.
- **No IP or address linking at the RPC layer.** Every chain read and write goes over Tor via Anon-RPC, with a separate circuit per identity: the wallet's account, each transaction, each one-time sender, and the shared RAILGUN scan.
- **No seed phrase, no server.** Keys come from a passkey (WebAuthn PRF). The same synced passkey on another device restores the wallet.

## What it does

| Step | How |
|---|---|
| Create | A passkey derives the RAILGUN spending/viewing keys, the public account key and a storage key (HKDF). A new wallet opens from our public pool snapshot in about 20 s over Tor. |
| Fund | Send Sepolia ETH to the public account, then **Shield ETH** into the private balance. |
| Settle | New shields wait for the PPOI check (about an hour). The wallet refreshes every minute and shows each note's PPOI state. |
| Pay privately | Private send to a `0zk` address as an ERC-4337 UserOperation from a fresh one-time EIP-7702 sender. The RAILGUN paymaster takes gas from the private balance, so the sender has no ETH and no history. Queued PPOI proofs are submitted on the following syncs. |
| Exit | Withdraw to a public address, with warnings when that would link you (own account, right after a shield). |
| Restore | On a new device, the passkey returns the wallet's creation time; the scan starts from the snapshot and replays only from then. **Full rescan** is the escape hatch. |

Nothing secret touches disk: RAILGUN checkpoints are sealed with AES-GCM under the passkey-derived storage key.

## Layout

| Path | What |
|---|---|
| `packages/anon-rpc` | Anon-RPC client: Tor worker host, per-identity isolation, deadlines and retries, batching, a `fetch` for RAILGUN |
| `packages/keys` | Passkey PRF root, key derivation, sealed storage |
| `packages/railgun` | Wrapper around kohaku-railgun-wasm: queued session, windowed sync, snapshots, transport over Anon-RPC |
| `apps/wallet` | The wallet web app (RAILGUN runs in a worker whose `fetch` is bridged to Anon-RPC) |
| `gateway/` | Build, start and stop our own tor-js gateway on this machine |
| `vendor/torjs-worker` | Patch and build script for the keep-alive tor-js worker |
| `scripts/` | Live smoke tests in Chromium with a virtual passkey |

## Run

```sh
pnpm install
gateway/build.sh                              # once: tor-js gateway into .local/bin
vendor/torjs-worker/build.sh                  # once: patched worker into .local/worker
packages/railgun/scripts/build-wasm.sh        # once: kohaku-railgun-wasm (+ our patches) into .local/railgun
node packages/railgun/scripts/build-snapshot.mjs   # public pool snapshot; rerun to refresh (resumes)
gateway/start.sh                              # our own gateway, plus a fresh Tor snapshot
pnpm dev                                      # http://localhost:5173 (passkeys need "localhost", not an IP)
gateway/stop.sh                               # when done
```

Without a local gateway the wallet falls back to the public demo gateway.

## Test

```sh
pnpm test
CHROME=/path/to/chromium node scripts/smoke.mjs                       # boots Tor in Chromium and reads over it
CHROME=/path/to/chromium RESTORE=1 node scripts/smoke-wallet.mjs URL  # create, wipe, restore a wallet over Tor
```
