# tor-js worker (keep-alive build)

`keepalive.patch` applies to [tor-js](https://github.com/ethereum/tor-js) v0.4.4
(MIT OR Apache-2.0, The Tor Project and the Ethereum Foundation).
`build.sh` clones, patches and builds it into `.local/worker/anon-rpc-worker-0x<keccak>.js`.

What the patch changes in the worker's `fetch`:

- Keeps finished connections open and reuses them, per (isolation key, origin) only, at most 8 idle each.
- Retires a connection after 4 minutes.
- On a reused connection, a replayable request with no response head after 5 s is resent once on a fresh connection under the same key.
- Requests that must not be repeated (writes) never take a pooled connection.
- Puts the Tor error kind into the error name (`TorError.<kind>`), so the client can tell exit-side from destination failures.

The wallet loads the bundle by keccak from its own origin; the hash must be listed in
`packages/anon-rpc/src/worker-choice.ts`.
