# Prowl — End-to-End Technical Architecture

> A privacy-first Ethereum wallet for the browser, plus a phone-to-phone offline-cash system.
> Network: **Sepolia** (chain `11155111`). Product name **Prowl**; some identifiers still say `prawl` on purpose (Android package, message labels, the `window.prawlOffline` bridge) because keys, passkeys and coins are bound to them.

This document explains the whole system from first principles: the architecture, every major component, the data flows, the trust model, and the nuances that make it work. It is organized so you can present any layer on its own slide.

---

## 1. The one-sentence pitch

Prowl is a wallet where **your real balance is a RAILGUN shielded balance**, every network call goes **over Tor with a different circuit per identity**, there is **no seed phrase and no server** (keys come from a passkey), and on top of that it ships an **offline cash** system that lets two phones pay each other with **no network at all**, backed by ETH locked in an escrow and secured by the phone's **one-time hardware keys**.

Two independent privacy stories live in one app:

| Story | Hides | Mechanism |
|---|---|---|
| **Online private wallet** | *What you own and who you pay* | RAILGUN shielded pool + Tor per-identity isolation |
| **Offline cash** | *That a payment happened at all* | Hardware one-time keys + escrow-backed coins, phone-to-phone over Bluetooth |

---

## 2. System map

```
┌──────────────────────────────────────────────────────────────────────┐
│  BROWSER (the wallet web app, apps/wallet)                             │
│                                                                        │
│   React UI ── 4 tabs: Wallet · Offline cash · Activity · Network       │
│      │                                                                 │
│      ├── lib/wallet.ts   (single WalletState store + epoch guard)      │
│      │                                                                 │
│      ├── RAILGUN worker  (kohaku-railgun-wasm off the UI thread)       │
│      │       └── global fetch is BRIDGED to the page → Anon-RPC        │
│      │                                                                 │
│      ├── packages/keys   (passkey PRF → HKDF → all keys, sealed vault) │
│      │                                                                 │
│      └── packages/anon-rpc  (THE only thing that sends bytes)          │
│                 │                                                      │
│                 └── Tor worker (in-browser Arti)                       │
└────────────────────────────────┬───────────────────────────────────┘
                                  │  WebRTC
                         ┌────────▼─────────┐
                         │  tor-js gateway  │  sees your IP, never your traffic
                         └────────┬─────────┘
                                  │  Tor circuits
          ┌───────────────────────┼───────────────────────────┐
          ▼                       ▼                             ▼
   JSON-RPC providers      RAILGUN infra                 ERC-4337 bundler
   (reads + broadcast)     (Subsquid, PPOI, artifacts)   (Pimlico)

┌──────────────────────────────────────────────────────────────────────┐
│  PHONE (Prowl Android app, offline/app — Kotlin/Compose)               │
│   :core  protocol library (also runs on the JVM, unit-tested)          │
│   :app   screens, Android Keystore, BLE transport                      │
│                                                                        │
│   Pays another phone over Bluetooth with NO network.                   │
│   Talks to the website only for the two on-chain steps (load/cash-out) │
│   via QR / links / the window.prawlOffline bridge.                     │
└──────────────────────────────────────────────────────────────────────┘

                 ON-CHAIN (Sepolia)
   RAILGUN smart wallet  ·  PrawlEscrow v3 / v3.1 / v3.2
```

**Repository layout**

| Path | What |
|---|---|
| `apps/wallet` | The React web wallet. RAILGUN runs in a worker whose `fetch` is bridged to Anon-RPC. |
| `packages/keys` | Passkey PRF root, HKDF key derivation, AES-GCM sealed storage. |
| `packages/anon-rpc` | Tor worker host, per-identity circuit isolation, deadlines/retries/batching, a `fetch` for RAILGUN. |
| `packages/railgun` | Wrapper around `kohaku-railgun-wasm`: queued session, windowed sync, snapshots, transport over Anon-RPC. |
| `gateway/` | Build/start/stop a local tor-js gateway. |
| `offline/app` | Android app: `:core` protocol library + `:app` screens. |
| `offline/contracts-v3`, `contracts-v32` | Escrow v3 and v3.1/v3.2 (RAILGUN load, shield cash-out, refresh). |
| `offline/deposit-proofs` | Offline Ethereum light-client proof of an escrow deposit (Python reference, Java verifier). |
| `offline/zk-attestation` | ZK proof that a coin key is a hardware single-use key, without revealing the phone. |

---

## 3. Identity & keys — no seed phrase, no server

**File: `packages/keys`**

### 3.1 The root secret comes from a passkey (WebAuthn PRF)

There is no mnemonic and nothing secret on disk. The wallet's 32-byte root secret is the output of the **WebAuthn PRF extension** for a fixed salt:

- `prfSalt() = SHA-256("prawl/v1/root")`.
- On unlock, `navigator.credentials.get({ ..., userVerification: "required", extensions: { prf: { eval: { first: salt } } } })` is called. The authenticator computes `HMAC(credential-secret, salt)` and returns only the result — it never reveals the credential secret.
- Because the passkey syncs (iCloud Keychain, Google Password Manager, a hardware key), the **same passkey on another device yields the same root → the same wallet**. That is the entire backup-and-restore story.

Only the **credential id** (not secret) is stored locally, to skip the account picker. Recovery on a new device calls unlock with no id and lets the user pick any Prowl passkey.

### 3.2 Creation time rides in the user handle

The passkey's `user.id` is a 25-byte v1 blob: `[0x01][u64 BE unix seconds: bornAt][16 random bytes]`. It carries no name, email, or address. `bornAt` is the device clock **minus** a measured clock-skew (so a fast clock can't record a time later than reality). On restore, the wallet knows it **cannot own notes from before it was born**, so the RAILGUN scan can start from around that time instead of replaying all history.

### 3.3 One root → five independent keys (HKDF)

The root is imported as a non-extractable HKDF key and expanded with **HKDF-SHA256**, salt `"prawl/v1"`, a distinct `info` label per purpose. Knowing one derived key tells you nothing about the root or the others.

| Derived key | Label | Use |
|---|---|---|
| RAILGUN spending | `prawl/v1/railgun/spending` | Spend shielded notes |
| RAILGUN viewing | `prawl/v1/railgun/viewing` | Decrypt/scan own notes |
| EVM account | `prawl/v1/evm/account` | The public account: the way in/out, signs UserOps |
| Storage | `prawl/v1/storage/aes-gcm` | Non-extractable AES-GCM key for the local vault |
| Reclaim seed | `prawl/v1/evm/reclaim-seed` | Root of per-coin refund addresses |

- The EVM key uses **rejection sampling**: if the derived scalar isn't a valid secp256k1 key (`0 < k < n`), it re-derives with a counter suffix until it is.
- `deriveReclaimKey(reclaimSeed, index)` gives a **fresh EVM address per offline coin**, deterministic and passkey-recoverable, independent of the main account. A coin that expires unspent refunds to its reclaim address, so the refund never appears next to your main address.

### 3.4 Sealed local storage

**File: `packages/keys/src/vault.ts`.** Everything private that touches disk (RAILGUN checkpoints, activity history) goes through `seal()`/`open()`: AES-GCM with a fresh 12-byte IV and `additionalData = "prawl/v1/vault/<record-name>"`. The name-bound AAD means a sealed blob **cannot be swapped** for another record. The storage key itself is non-extractable, so it never leaves `SubtleCrypto`.

---

## 4. Networking — Tor with a circuit per identity

**File: `packages/anon-rpc`.** The design goal: *no IP or address linking at the RPC layer*. There is **no direct-network code path** — the only thing that emits bytes is the Tor worker.

### 4.1 Identities = circuits

Every request names exactly **one `Identity`**, and the Tor circuit key is derived from the identity, never from the flow that happens to be running. Circuit key = `` `${identity}@${provider}#${generation}` ``.

| Identity kind | Example | Rule |
|---|---|---|
| `account` | the wallet's own EVM account | its reads share one circuit |
| `stealth` | a one-time sender address | each gets its own circuit |
| `tx` | a transaction hash | receipt-waiting rides its own circuit |
| `public` | `head:11155111`, `railgun-11155111` | shared, name may not contain an address/hash |
| `ephemeral` | proof submission, bundler calls | throwaway, never reused |

So: the account's reads, each transaction, each one-time private sender, and the shared RAILGUN scan all travel on **different circuits**. A **cross-identity guard** (`assertOnlySubject`) throws if a URL or body text contains the hex subject of any *other* registered identity — defense in depth against an address accidentally pasted into calldata.

### 4.2 The request path, retries, and writes

`#send` is the single private path: validate identity → scheduler slot → acquire a ready worker → one attempt with per-request deadlines → retry/failover → emit a trace.

- **Reads** retry once on a **fresh circuit**, then optionally **fail over** to the next provider. Retryable: timeouts, connection/TLS/IO errors, HTTP 403/429/5xx, exit-side Tor errors.
- **Writes get exactly one attempt**, never retried, never failed over. Reads/GETs are marked idempotent so a keep-alive worker may resend once; any body naming a send/submit method is stripped of that marker (belt and braces).
- **Batching**: several reads for **one** identity can go as a single JSON-RPC batch where the provider supports it; a batch must stay on one route and one identity.

### 4.3 Heads, finality, and the light-client feed

`head(chain)` fetches the block number on the shared head scope and sets `finalized = head − 96`. Reads at/below the finalized block are **cacheable**. `setFinalizedBlock(chain, n)` lets an external verified source (an Ethereum light client) widen what may be cached. `blockTag()` never blocks the user: it returns `head − k` if a cached head is fresh enough, else `"latest"` and refreshes the head in the background.

### 4.4 The worker host and bootstrap

`WorkerHost` owns the Tor worker lifecycle. One worker serves every chain (isolation is per-identity, not per-worker). Boot has its own 90 s deadline. A worker is replaced only on boot failure/timeout or after 3 consecutive requests each failing on two fresh circuits — a single timeout never kills it. The Tor bootstrap snapshot (`/tor/bootstrap.zip.zst`) is loaded from the page's **own origin**, validated against a size cap and the zstd magic bytes; it goes stale in ~3 days, so it's served `no-cache` with an ETag.

### 4.5 The gateway

The gateway is the upstream **tor-js gateway** (a WebRTC endpoint the in-browser Arti client reaches). It **sees your IP but never your Tor traffic**. Gateway selection precedence: (1) a gateway the user confirmed from a `?gateway=IP:PORT:certhash` link — confirmed via a dialog precisely because it sees your IP; (2) the build's `VITE_PRAWL_GATEWAY`; (3) the public demo gateway. The Tor worker JS bundle is **hash-pinned** and loaded from the same origin, and its keccak is re-checked (fail-closed), so no CDN can swap it.

---

## 5. The online private wallet (RAILGUN)

**Files: `packages/railgun`, `apps/wallet/src/railgun`, `apps/wallet/src/lib/wallet.ts`.**

### 5.1 Why a worker + a bridged fetch

RAILGUN proving is heavy, so `kohaku-railgun-wasm` runs in a **Web Worker** off the UI thread. The catch: the wasm calls the global `fetch` with no injection API. So the worker **replaces `self.fetch`**:

- Same-origin requests (the wasm glue, the local snapshot) use the real fetch.
- **Everything else** is serialized and posted to the page, which answers through Anon-RPC — i.e. **over Tor**. The wasm never touches the network directly.

Keys arrive in the worker's `open` message and live only in its memory. Checkpoints are **sealed with the storage key** before they touch disk, after every state-changing op.

### 5.2 The queued session and windowed sync

`RailgunWallet` wraps the wasm `PoiSession`. Touching the session while an async call holds its borrow throws "recursive use", so **every** access goes through a `Serial` one-at-a-time queue. `sync()` works in windows (default 1,000,000 blocks) from the last synced block up to `head`, reporting progress and handing a plaintext checkpoint to the caller after each window.

### 5.3 Fast first open: public pool snapshots

**File: `packages/railgun/src/snapshot.ts`.** A newly registered RAILGUN account starts at the indexer's current block and *cannot own earlier notes*. So a fresh wallet opens instantly from a **public-pool snapshot**: a checkpoint with all account data stripped (`stripCheckpoint` empties `accounts`, PPOI `provider`, and `txid.own_ops`; `isPublicSnapshot` refuses anything with leftovers). `seedFreshAccount` injects one empty account synced to the snapshot block. A *restored* wallet seeds at `restoreStartBlock(...)` — on 12-second-slot chains it bounds the replay window from the snapshot's block/time and the wallet's `bornAt` (with 24 h slack). If the seeded account's address doesn't match the real wallet, the snapshot is discarded and a full scan runs — the snapshot is never trusted. Measured: a new wallet opens in ~20 s over Tor.

### 5.4 PPOI — Private Proof of Innocence

RAILGUN notes carry a **PPOI status**; only `Valid` WETH notes are spendable in Prowl. New shields wait for the PPOI check (2–4 min on Sepolia, up to an hour on mainnet). After each sync the wallet submits any queued PPOI proofs to the PPOI node and refreshes before trusting a `Valid`. Submission is not acceptance, so a proof the node can't take yet stays queued for the next sync.

### 5.5 The core user flows

| Flow | How it works |
|---|---|
| **Create / unlock** | Passkey PRF → derive keys → open RAILGUN (from checkpoint, snapshot, or full scan). An `epoch` counter is bumped on unlock/lock/rescan; any async work checks `myEpoch === epoch` before touching the screen, so stale work from a previous wallet is dropped. |
| **Shield** (public → private) | `buildShield` returns an unsigned public transaction; the app signs it with the EVM account (EIP-1559) and broadcasts over the account's circuit. Shows "pending until PPOI clears." |
| **Private send** (to a `0zk`) | A **fresh one-time EIP-7702 account** is generated as the sender. `prepareTransfer` proves in-browser and returns a **signed, paymaster-sponsored UserOperation**. The RAILGUN **paymaster takes gas from the private WETH balance**, so the sender holds no ETH and has no history. Sent to the ERC-4337 bundler (Pimlico) over Tor. |
| **Withdraw / exit** (to a public address) | `prepareUnshield`. Native-ETH mode unshields WETH to the one-time account, unwraps it, and forwards ETH to the recipient in the same UserOp (via a tail call); `asWeth` mode sends WETH directly. The 0.25 % RAILGUN fee is added on top via `grossUp`. **Linking warnings**: withdrawing to your own shield account is blocked; withdrawing the same amount right after a shield is flagged as linkable. |
| **Activity** | A local history sealed with the storage key (max 200, newest first). Shown **by hash only — no explorer links**, because opening one would leak your IP and which transaction is yours. |

A recurring safety nuance: a transaction broadcast that gets no answer raises an **`UnconfirmedError`** ("status unknown") rather than silently retrying — a blind retry could pay twice.

---

## 6. Offline cash — the headline feature

**Files: `offline/` (contracts, Android `:core`, deposit-proofs), `apps/wallet/src/offline/`.**

> Pay ETH **phone to phone with no network**, with no double spend. Each coin is owned by a key the phone's secure hardware will sign with **only once**. A recipient checks the payer's Google-signed key attestation **offline**, so a copied wallet or rooted phone can't spend the same coin twice. The coin is backed by an ETH deposit in an escrow, and the recipient can verify that deposit offline too, from an Ethereum light-client proof.

### 6.1 The three on-chain / off-chain phases

```
LOAD (online)            PAY (offline, phone↔phone)        CASH OUT (online)
─────────────            ──────────────────────────        ─────────────────
website deposits ETH     payer signs ONE spend             holder's phone signs
to the escrow for a      (amount to payee + change         a REDEEM spend naming
coin owned by the        to a fresh own key), sends         a payout; website
phone's genesis key      over Bluetooth. Payee verifies     simulates + submits
                         everything OFFLINE.                to the escrow.
```

The website **never holds offline cash**. It only sends the two on-chain transactions; the phone does everything in between.

### 6.2 What a coin is (escrow v3)

**File: `offline/contracts-v3/src/PrawlEscrowV3.sol`.** `deposit(coinId, expiry, k0x, k0y)` with `msg.value = value` locks the ETH and writes, once and immutably (storage **slot 0**, never reused):

```
deposits[coinId] = keccak256(abi.encode(value, expiry, k0x, k0y, depositor))
```

`k0 = (k0x, k0y)` is the **genesis one-time key** (P-256) held in the phone's secure element. The storage layout is normative: slot 0 is `deposits`, slot 1 is mutable `coins` state — so a light-client proof of `keccak256(abi.encode(coinId, 0))` proves the coin exists.

### 6.3 Notes, spends, splitting, and value conservation

A **note** is `(value, one-time key)`. The genesis note is `(deposit value, k0)`. To spend a note, its key signs **one** message committing to the full output list:

```
PRAWL-OTK-v3|chainId|escrow|coinId|expiry|depth|parentNoteId|outputsHash
outputsHash = sha256( join(";", [valueWei_i ":" keyHash_i]) )
```

Each output's `keyHash` is either the next one-time key (`sha256` of its SPKI DER) or a `PRAWL-REDEEM` target. **Splitting**: one signature can create several outputs; **change** is just another output paid to a fresh key on the payer's own phone. The hard rule, enforced identically off-chain and on-chain: **Σ outputs == value of the note being spent**, every output `> 0`.

### 6.4 Why an intermediary can't mint value

Three mechanisms stack:

1. **Conservation at every hop** — checked by the payer (construction), the recipient (`PaymentVerifier`), and the escrow (`ConservationViolated` revert), plus an independent `paid ≤ value` counter (`CapExceeded`).
2. **One-time hardware keys** — the key is generated inside a locked, verified-boot StrongBox/TEE with `usageCountLimit == 1`, so it **physically cannot sign twice**. Proven by Android Key Attestation (see 6.6).
3. **Equivocation freeze** — if a subverted device ever did sign two different messages, that's public, machine-checkable evidence: `_record` stores the first message per key; a conflicting one triggers `_markBroken` + `_freeze`, bricking that subtree. `proveEquivocation` lets anyone submit the two signatures; the frozen remainder goes to a `compensationSink`, and the device bond can be slashed.

Because every hop conserves value and the whole tree is rooted at one real deposit, the total redeemable value can never exceed the deposit.

### 6.5 Redeem — tying the payout back to the deposit

`redeem(Header h, Spend[] path, Redemption rd)`:

1. `_checkHeader` — the header must hash to `deposits[coinId]` (the original deposit).
2. `_start` — seed the walk at the genesis key `k0` from the header.
3. For each hop: recompute the signed message, verify the signature with the **P256VERIFY precompile**, check conservation, and require `outputs[index].keyHash == keyHash(nextX, nextY)` so the path can only follow outputs that were actually signed.
4. `rd` is the "tip auth": signed by the redeemed note's own key, naming a `PRAWL-REDEEM` output for the payout address. Only then does it pay.

Double-redeem is blocked by a `redeemed` map keyed by `(sha256(message), index)` — the **message hash**, not the signature, so signature malleability can't double-pay.

### 6.6 The hardware trust root (Android Key Attestation)

**Files: `offline/app/core/.../attest/AttestationVerifier.kt` (a port of `OtkVerify.java`).** Before paying a payee, or accepting a note, the parties verify the attestation chain, enforcing in order:

- chain verifies up to a **pinned Google attestation root**; issuer/subject + CA path-length checks;
- no serial on the revocation list; RKP certs within validity;
- the `KeyDescription` extension on the **leaf only**;
- security level **TEE or StrongBox**, and equal to the KeyMint level;
- **`usageCountLimit == 1` in the hardware-enforced list** (and absent from software) — the one-time guarantee;
- `origin GENERATED`, `purpose SIGN`, EC P-256;
- **bootloader locked**, **verified boot = Verified**;
- RKP chain or factory StrongBox chain; `osPatchLevel ≥ minimum`; key created by the **allowed app** (package + signing-cert digest).

### 6.7 The offline deposit proof (Ethereum light client)

**Files: `offline/deposit-proofs` (Python reference `verifier.py`/`builder.py`/`dp_core.py`, Java port, Solidity).** So a *recipient* can confirm **offline** that a coin is backed by real locked ETH, without trusting any server, the coin carries a light-client proof verified in this order:

1. **Trusted anchor** — the phone's cached sync committee from its last online sync (`prawl-lc-cache-v1`). Fork versions and genesis root are code constants, never taken from the proof.
2. **Committee stepping** — `LightClientUpdate`s walk the cached committee forward period by period.
3. **Finality** — a sync aggregate with a **2/3 supermajority** (≥ 342 of 512), BLS-verified over the Gloas-domain signing root; `finality_branch` + `execution_branch` extract the execution block hash.
4. **Execution header** — `keccak(header_rlp) == execution_block_hash`, read `stateRoot`.
5. **Account + storage Merkle-Patricia proofs** — `keccak(address)` → `storageRoot`, then `keccak(storage_key)` → the 32-byte deposit commitment, compared with the coin's own `keccak256(abi.encode(value, expiry, k0x, k0y, depositor))`.

Adapted to Sepolia's **Gloas (ePBS)** fork. Measured on a Samsung S25 Ultra: ~19.5 ms cached, ~63 ms with 3 committee steps. It **fails closed**: any slot before Gloas or at/after an unknown future fork is refused. This also feeds `setFinalizedBlock` on the online side.

### 6.8 Refresh and expiry

Coins expire (default 14 days, max 30). Before expiry a holder can **refresh**: a signed REDEEM that moves a note's value into a brand-new coin with a new expiry and no ETH movement (`newCoinId` must equal `refreshCoinId(...)` with a reserved prefix). After expiry + grace, unredeemed value is reclaimable by the depositor's reclaim address — or swept to the `compensationSink` if the coin was frozen.

---

## 7. Phone ↔ website handoff

**Files: `offline/HANDOFF.md`, `apps/wallet/src/offline/{payload,bridge,escrow,shield}.ts`.**

### 7.1 Transport

Payloads are **UTF-8 JSON → base64url (no padding)**, carried as `https://<site>/#/offline/<kind>?d=<d>` (a URL **fragment**, so the payload stays out of server logs) or `prawl://offline/<kind>?d=<d>`. Read from a scanned QR, a pasted link, or the location hash. Everything is strictly validated (`parsePayload`) and `v:1` is required.

| Kind | Direction | Meaning |
|---|---|---|
| `load` | phone → site | public deposit of a minted coin |
| `load-private` | phone → site | commit → RAILGUN unshield to the deposit address → activate |
| `redeem` | phone → site | public cash-out (header + path + redemption) |
| `redeem-shield` | phone → site | cash out straight into a RAILGUN shield |
| `refresh` | phone → site | move a note into a new coin |
| `shield-ask` / `shield-target` | both ways | the phone asks for, and signs over, a shield target for exactly value V |

### 7.2 The native bridge

When the page runs **inside the Android app**, `window.prawlOffline` exposes `mint / coins / cashOut / refresh / shieldAsk / acceptShieldTarget / markDeposited / markRefreshed`. Whatever the bridge returns goes through the **same parser and the same simulate-then-send checks** as a scanned QR. The bridge exists only for the exact allowed origin, never in iframes, `coins()` returns no keys, and `cashOut`/`refresh` always require the phone's own biometric confirmation (a refusal becomes "declined", never retried).

### 7.3 Simulate before send, and judge "paid" from events only

**File: `apps/wallet/src/offline/escrow.ts`.** Every on-chain step is `eth_call`-simulated first. Critically, a redeem whose return value is `false` (the escrow would record a double spend and **freeze** the coin) is **never sent**. And a mined redeem can succeed as a transaction yet pay nothing, so `redeemOutcome` decides the result **only from escrow events**:

- `Redeemed` / `RedeemedToShield` / `Refreshed` → **paid**;
- `PaymentDeferred` (payout refused ETH, now owed in-escrow) → **deferred**;
- `RedeemBlocked` / `CoinFrozen` → **blocked**.

### 7.4 Cash out into the private balance (the two systems meet)

This is where offline cash flows back into RAILGUN:

1. The phone shows a `shield-ask` with a fresh 32-hex nonce.
2. The website builds a single-use **ShieldRequest** (`buildShield` WETH → the wallet's own `0zk`, decoded into 9 fields) and hands it back as a `shield-target` echoing the nonce.
3. The phone checks value/token/escrow, computes `shieldHash = sha256(abi.encode(request))` (exactly 288 bytes / 9 words), signs a `PRAWL-REDEEM-SHIELD` output over it, and returns a `redeem-shield`.
4. The website verifies the phone signed over **exactly** the request it gave, simulates, and calls `redeemToShield`. The escrow shields the value directly into the private balance (RAILGUN keeps its 0.25 % fee).

---

## 8. End-to-end worked example

**Alice shields 0.1 ETH, hands a coin to Bob offline, Bob pays Charlie 0.05, Charlie cashes out:**

1. **Alice funds + shields.** ETH → her public EVM account → `shieldEth(0.1)` builds a public shield tx (over her account's Tor circuit). After the PPOI check clears, she has 0.1 ETH of spendable private WETH notes.
2. **Load a coin (privately).** Her phone mints a coin key; the website runs `commitDeposit → unshield WETH to the deposit address (one-time EIP-7702 sender, paymaster gas) → activate`. The coin is now backed on-chain, owned by the phone's genesis key `k0`, with Alice's **reclaim** address (not her main one) as depositor.
3. **Pay Bob offline.** Alice's phone signs **one** spend of the genesis note → `[0.1 → Bob's one-time key]`, over Bluetooth. Bob's phone verifies offline: the deposit (light-client proof), every key's hardware attestation, the signature, conservation, expiry, hop limit, cap.
4. **Bob pays Charlie 0.05 offline.** Bob's phone signs one spend → `[0.05 → Charlie's key, 0.05 → Bob's fresh change key]`. Conservation holds (`0.05 + 0.05 = 0.1`). Bob's secure element will not sign that note a second time.
5. **Charlie cashes out.** Charlie's phone signs a REDEEM naming a payout (or a shield target). The website simulates (`paid == true`), submits `redeem`, and judges success from the `Redeemed` event. The escrow re-walks the whole path from Alice's `k0` with P256VERIFY and conservation, then pays Charlie.

Charlie is **unlinkable** to Alice (the chain sees only key hashes), yet the escrow mathematically refuses to pay unless his note descends, value-conserving hop by hop, from Alice's real 0.1 ETH deposit. Bob can move and split value, never create it.

---

## 9. Trust model & guarantees

| Property | Guaranteed? | Rests on |
|---|---|---|
| No seed phrase; cross-device restore | Yes | Passkey PRF (synced authenticator) |
| RPC layer can't link IP ↔ address | Yes | Tor + one circuit per identity; no direct-network path |
| Private balances & payments hidden | Yes | RAILGUN shielded pool + PPOI |
| Offline double-spend prevention | Yes, **given** the phone's secure hardware enforces one-use | Android Key Attestation (`usageCountLimit == 1`, StrongBox/TEE) |
| Detection/punishment if hardware fails | Yes | On-chain equivocation freeze + slashable device bonds |
| Offline value can't be minted by intermediaries | Yes | Value conservation at every hop + deposit-rooted redeem path |
| Recipient can verify deposit offline | Yes | Ethereum sync-committee light client (honest-majority assumption) |
| Offline payments reveal the payer's phone | **Today, yes** | Each key carries its attestation chain; a ZK proof to hide the device is in `zk-attestation/` |
| Coins can be lost | A wiped app / lost phone loses its coins; they expire and the depositor reclaims |

**External trust dependencies worth naming on a slide:** Google's attestation root and each phone model's secure hardware; Ethereum's sync-committee honest-majority for deposit proofs; the gateway operator (sees your IP, never your traffic); the RAILGUN circuits/artifacts, the PPOI node, and the ERC-4337 bundler.

---

## 10. Cheat sheet / glossary

- **0zk address** — a RAILGUN shielded address (your private balance).
- **PPOI** — Private Proof of Innocence; a note isn't spendable until `Valid`.
- **Checkpoint / snapshot** — serialized RAILGUN session state; a snapshot is a checkpoint with all account data stripped (public pool only) for fast first sync.
- **OTK** — one-time key; a P-256 key in the phone's secure element with `usageCountLimit == 1`.
- **Coin / note** — a coin is one escrow deposit owned by a genesis key; a note is a spendable piece `(value, one-time key)`.
- **Genesis key `k0`** — the coin's root one-time key, committed in the on-chain deposit.
- **Equivocation** — one key signing two different messages; public, machine-checkable, freezes the subtree.
- **Reclaim address** — a fresh per-coin address derived from the passkey; where an expired coin's refund goes.
- **Gloas** — the Sepolia consensus fork (ePBS) the light client targets; execution payload is proven via `execution_block_hash`.
- **Escrows** — v3 `0x70b3B7…` (split notes, phone-signed redeem, freeze); v3.1 `0x236b1d…` (RAILGUN load, shield cash-out, refresh); v3.2 `0x2492B9…` (audit fixes, same ABI/layout).
