# Prawl

A privacy-first Ethereum wallet for the browser.

- **Private balance first.** Your main account is a shielded balance; public addresses are only the way in and out.
- **No IP or address linking at the RPC layer.** Every chain read and write goes over Tor via Anon-RPC, with a separate circuit per identity.
- **No server.** Keys stay on the device.

## Layout

| Path | What |
|---|---|
| `packages/anon-rpc` | Anon-RPC client: Tor worker host, per-identity isolation, deadlines and retries, Multicall3 batching, log scanning, a `fetch` for RAILGUN |
| `apps/wallet` | The wallet web app |

| `gateway/` | Build, start and stop our own tor-js gateway on this machine |
| `vendor/torjs-worker` | Patch and build script for the keep-alive tor-js worker |

## Run

```sh
pnpm install
gateway/build.sh            # once: builds the tor-js gateway into .local/bin
vendor/torjs-worker/build.sh  # once: builds the patched worker into .local/worker
gateway/start.sh            # our own gateway on 127.0.0.1, plus a fresh Tor snapshot
pnpm dev                    # http://127.0.0.1:5173
gateway/stop.sh             # when done
```

Without a local gateway the wallet falls back to the public demo gateway.

## Test

```sh
pnpm test
CHROME=/path/to/chromium node scripts/smoke.mjs   # live: boots Tor in Chromium and reads over it
```
