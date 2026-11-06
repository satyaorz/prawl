# Prowl  

**A private Ethereum wallet you open with your fingerprint, which also works as digital cash when there is no internet.**

Try it on Sepolia testnet:

- **Wallet** (opens in any browser): <https://prawl-wallet.centralindia.cloudapp.azure.com>
- **Website and handbook**: <https://satyaorz.github.io/prawl/> (source: [`apps/site`](apps/site/README.md))
- **Android app** (Android 12+, test networks only): [latest release](https://github.com/satyaorz/prawl/releases/latest/download/prowl.apk), or build it from
  [`offline/app`](offline/app/README.md)
- **Private swap** (WETH for a test token on Uniswap v4, encrypted batches): see [`private-swap`](private-swap/README.md), with the live Sepolia contracts and transactions

## Why

On Ethereum, everything you do is public. Anyone who learns one of your addresses can see your balance, who pays you, who you pay
and how much. The node you connect to also sees your IP address and every address you ask about, so it can link your accounts even
when you keep them apart. On top of that, a seed phrase is easy to lose or steal, and a crypto payment needs an internet connection.

Prowl fixes each of these:

| Problem | What Prowl does |
|---|---|
| Your balance and payments are public | Your money sits in a **private balance** (RAILGUN). Payments between private balances do not show who sent what to whom, or how much. |
| The RPC node sees your IP and links your addresses | **Every request goes over Tor**, with a separate circuit for each identity (your account, each transaction, each one-time sender), so even the node cannot tie them together. |
| Gas reveals who paid | A private payment is sent from a **fresh one-time account** that holds no ETH. The gas is paid from your private balance. |
| Seed phrases get lost or stolen | **No seed phrase.** Your keys are derived from a passkey (fingerprint, face or screen lock). The same synced passkey restores the wallet on a new device. |
| Payments need internet | **Offline cash** on the Android app: pay phone to phone over Bluetooth with no network, and the phone's secure hardware makes a double spend impossible. |
| Wallets depend on someone's server | There is **no Prowl server**. The site is static files. You can run your own Tor gateway with one script. |

## What you can do

- **Create a wallet** with a passkey, in about 20 seconds.
- **Fund it** by sending ETH to your public address, then **shield** it into your private balance.
- **Pay privately** to any RAILGUN `0zk` address.
- **Withdraw** to any public address. The wallet warns you when a withdrawal would link you (for example, to your own account right after a shield).
- **Carry cash offline** on the Android app: load a coin from your public or private balance, pay another phone over Bluetooth with no
  network, and cash it out to your wallet (or another address) when you are back online.
- **See your history**, kept encrypted on your device only. There are no block explorer links, because opening one would show the explorer
  your IP and which transaction is yours.
- **Restore** on a new device with the same passkey.

New shields pass RAILGUN's **Private Proofs of Innocence (PPOI)** check before they can be spent: funds from flagged sources cannot enter
the private balance. This takes a few minutes on Sepolia and up to an hour on mainnet. The wallet shows the status of each deposit.

## For companies

On a public chain, every salary, supplier payment and treasury move is visible to competitors, to the people being paid, and to anyone
who wants to target the company. Prowl lets a company use Ethereum without publishing its books.

- **Payroll and supplier payments stay private.** Pay staff and vendors from the private balance. Nobody can read salaries or who your
  suppliers are from the chain, and an employee cannot see what colleagues earn.
- **Treasury stays private.** Competitors and attackers cannot follow the company's balance or its moves.
- **Clean money only.** The PPOI check keeps funds from flagged sources out of the private balance, so privacy does not mean taking in
  dirty money.
- **Cash for field staff.** Give staff offline cash on their phones, for places with poor or no connectivity (sites, events, travel, rural
  areas). Each coin has a value cap and an expiry. **The company, as the depositor, reclaims whatever is not spent** once a coin expires,
  so a lost phone loses at most what was on it, and only until the coin expires.
- **Device-level trust.** A coin can only be spent from a genuine Prowl app on a phone with a locked bootloader and a recent security
  patch, checked from Google's hardware attestation. A rooted or cloned phone is refused.
- **No seed phrases to manage.** Keys live in passkeys, which already fit how companies manage devices and sign-ins.
- **Run it yourself.** The site is static files and the Tor gateway is one script (`gateway/deploy-remote.sh`). Nothing depends on us.
- **No surprises.** Every transaction is simulated before it is sent, and an offline coin counts as paid only from the escrow's own on-chain
  events.

Not there yet for companies (planned, not built): multi-person approval for payments, sharing a view-only key with an auditor or accountant,
ERC-20 tokens such as USDC (today it is ETH only), and mainnet (today it runs on Sepolia).

## How it works

```
 Browser or Android app                     Ethereum (Sepolia)
 ┌─────────────────────────────┐
 │ passkey ──► keys (HKDF)     │
 │ RAILGUN private balance     │──── Tor ────► RPC node, RAILGUN contracts,
 │ (proofs made on the device) │  (one circuit │ PPOI node, offline-cash escrow
 └─────────────┬───────────────┘   per identity)
               │ window.prawlOffline (Android app only)
 ┌─────────────▼───────────────┐
 │ Offline cash: coin keys in  │◄── Bluetooth ──► another phone (no network)
 │ secure hardware, use-once   │
 └─────────────────────────────┘
```

- **Keys.** A passkey's PRF output is the root. HKDF derives the RAILGUN spending and viewing keys, the public account key and a storage key.
  RAILGUN state on the device is sealed with AES-GCM under that storage key, so nothing secret is stored in the clear.
- **Network.** Tor runs inside the page (tor-js). Anon-RPC gives every identity its own circuit and refuses to mix them in one request.
- **Private payments.** A private send is an ERC-4337 UserOperation from a fresh one-time EIP-7702 account. The RAILGUN paymaster takes the
  gas from the private balance.
- **Offline cash.** Each coin is owned by a key that the phone's secure hardware will sign with only once (Android Keystore
  `setMaxUsageCount(1)`, StrongBox where available). The coin is backed by ETH in an escrow contract. The receiving phone checks, with no
  network, the payer's hardware attestation, every signature, and a light-client proof of the deposit from a finalized Ethereum block.
  Details and the exact guarantees: [`offline/README.md`](offline/README.md).

## Limits

- **Testnet only.** Prowl runs on Sepolia. It has not been audited. Do not use real money.
- **ETH only**, no tokens yet.
- **Offline payments reveal the payer's phone model and key** to the receiver today. A zero-knowledge proof that hides it is in progress
  (`offline/zk-attestation/`).
- **A wiped app or lost phone loses its offline coins** until they expire and the depositor reclaims them.
- **The passkey is the wallet.** If it was saved only on one device and that device is lost, the wallet is lost. Use a passkey manager that
  syncs (Google Password Manager, iCloud Keychain, 1Password and similar).

## CROPS

- **C (Control).** We run only a static website, its domain, and a demo Tor gateway. If they go away, the code is in this repo: host `apps/wallet/dist-web` anywhere and point it at your own gateway (`gateway/deploy-remote.sh`). Keys come from your passkey, so no server holds your funds and nobody can refuse you. Two caveats: passkeys are bound to the site's domain, so a new domain means a new wallet until the old one is reachable again, and the offline cash escrow lives on-chain, so a coin can always be redeemed or reclaimed there.
- **O (Open).** The source is in this repo, and you can build and run it from here alone (see "Run locally" and "Deploy"). The license is [MIT](LICENSE). Third-party code keeps its own license (all permissive: MIT, Apache-2.0, BSD, ISC, and MPL-2.0 for build-time `lightningcss`), including the Aztec-generated verifiers in `offline/zk-attestation` (Apache-2.0) and the libraries under `offline/contracts*/lib`. A build also needs public services: Sepolia RPC providers, RAILGUN's Subsquid and PPOI nodes, and the Pimlico bundler.
- **P (Private).** Everything goes over Tor with one circuit per identity, so no third party sees your IP next to your addresses. The Tor gateway sees your IP but not your traffic. Public RPC providers (publicnode, OnFinality) see requests and addresses but not who sent them. The RAILGUN Subsquid and PPOI nodes and the Pimlico bundler see the same, and each one-time sender has its own circuit. The site host sees only that someone loaded static files, and the payload links keep data in the URL fragment, so it never reaches server logs. There is no analytics, telemetry or crash reporting in the code, and no Prowl server or indexer. Two Google touchpoints on Android: passkeys go through Google Play services (`credentials-play-services-auth`), and the optional attestation revocation-list update contacts `android.googleapis.com` directly after you confirm a dialog that warns it reveals your IP.
- **S (Secure).** Keys are derived from the passkey's PRF output with HKDF, are never stored in the clear, and anything saved on the device is sealed with AES-GCM. You trust your passkey provider and authenticator, the RAILGUN circuits and contracts, and the Prowl site's JavaScript on each load (the Tor worker is hash-pinned). Offline cash also trusts Google's attestation root and the phone's secure hardware. A failure there is caught and punished by the escrow's on-chain freeze, and light-client deposit proofs assume an honest majority of the Ethereum sync committee. The code has not been audited.

## Repository layout

| Path | What |
|---|---|
| `apps/wallet` | The wallet website (React). RAILGUN runs in a worker whose `fetch` goes through Anon-RPC |
| `packages/anon-rpc` | Anon-RPC client: Tor worker host, per-identity isolation, deadlines and retries, batching, a `fetch` for RAILGUN |
| `packages/keys` | Passkey PRF root, key derivation, sealed storage |
| `packages/railgun` | Wrapper around kohaku-railgun-wasm: queued session, windowed sync, snapshots, transport over Anon-RPC |
| `offline/app` | The Android app (Kotlin, Compose): Wallet tab (the website) and Offline cash tab (native) |
| `offline/` | Offline cash: escrow contracts, deposit proofs, protocol spec, phone test scripts |
| `gateway/` | Build and run our own tor-js gateway, locally or on a server |
| `vendor/torjs-worker` | Patch and build script for the keep-alive tor-js worker |
| `scripts/` | Site deploy script and live tests in Chromium with a virtual passkey |

## Run locally

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

## Deploy

```sh
gateway/deploy-remote.sh user@<server-ip>                                   # Tor gateway on Ubuntu 24.04 x86_64; prints its address
VITE_PRAWL_GATEWAY=<address> pnpm --filter ./apps/wallet build:web          # apps/wallet/dist-web
scripts/deploy-site-azure.sh user@<server-ip> <domain>                      # https site with Caddy on the same server
```

`apps/wallet/dist-web` also works on any static host (it includes a `vercel.json`). Passkeys are bound to the site's domain, so choose the
final domain before real wallets are made; the Android app also needs that domain's `/.well-known/assetlinks.json` to use passkeys. Refresh
the Tor bootstrap and pool snapshot with each deploy (the bootstrap goes stale in about 3 days).

The Android app: see [`offline/app/README.md`](offline/app/README.md) (`./gradlew :app:assemblePrawlDebug -Pprawl.site=https://<domain>`).

## Test

```sh
pnpm test
(cd offline/app && ./gradlew :core:test)                              # Android protocol library on the JVM
CHROME=/path/to/chromium node scripts/smoke.mjs                       # boots Tor in Chromium and reads over it
CHROME=/path/to/chromium RESTORE=1 node scripts/smoke-wallet.mjs URL  # create, wipe, restore a wallet over Tor
CHROME=/path/to/chromium node scripts/live-funded.mjs URL DIR         # live Sepolia: shield, PPOI, private send, withdraw
CHROME=/path/to/chromium node scripts/live-offline.mjs URL DIR        # live Sepolia: offline-cash load and cash-out links
```

## Naming

The product is **Prowl**. Some identifiers still say `prawl` on purpose: the Android package `xyz.prawl.offline`, the key and message
labels (`prawl/v1/...`, `PRAWL-OTK-v3`), the site's domain and the `window.prawlOffline` bridge. Keys, passkeys and coins are bound to
them, so changing them would mean a new wallet. The repository is `satyaorz/prawl`.
