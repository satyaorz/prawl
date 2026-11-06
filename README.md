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

## Develop

```sh
pnpm install
pnpm test
pnpm dev
```
