# Prawl offline cash: the Android app (v3), 2026-11-06

This folder is a Gradle project (Kotlin, Jetpack Compose). It has a `:core` protocol library, ported from the Java harness with the same wire formats, and an `:app` with the user-facing screens. The app also has a debug "harness mode" that the existing adb scripts can drive.

**Status:**
- Everything here was built and tested on the JVM only.
- Nothing was installed on a phone (as instructed: no adb).
- The device checklist is in §9.

## 1. APKs

| APK | applicationId | What it is |
|---|---|---|
| `app/build/outputs/apk/prawl/debug/app-prawl-debug.apk` | `xyz.prawl.offline` | The product app |
| `app/build/outputs/apk/compat/debug/app-compat-debug.apk` | `xyz.prawl.otktest` | The same app under the harness's package. It replaces the Java harness on the test phones (see §4) |

Both APKs:
- are signed with `keystore/prawl-debug.keystore`, a copy of `android_test/build_debug.keystore`. The signer cert SHA-256 is `e6e0daae…a92eaf`, the same as the harness;
- target SDK 36 with minSdk 31;
- are about 41.5 MB (debug build, not minified);
- ship `libprawlbls.so` for arm64-v8a and x86_64, stored uncompressed and 16 KB-aligned (`zipalign -c -P 16` passes).

**Harness mode (debug builds only):**
- prawl flavor: `xyz.prawl.offline/xyz.prawl.offline.harness.HarnessActivity`
- compat flavor: `xyz.prawl.otktest/xyz.prawl.otktest.Wallet3Activity`. This is an activity-alias, so `w2_lib.sh`/`w3_lib.sh` work unchanged with `PKG=xyz.prawl.otktest`. The activity `xyz.prawl.otktest/xyz.prawl.offline.harness.HarnessActivity` also works.

## 2. Build

```
./gradlew assembleDebug          # both APKs
./gradlew test                   # JVM tests: core (both build types) + app (incl. screenshots)
./gradlew assembleDebug -Pprawl.site=https://my-wallet.vercel.app   # set the website for handoff links
```

| Piece | Version | Why |
|---|---|---|
| Gradle wrapper | **9.5.1** | Gradle 9.8.2 failed: AGP 8.x uses an internal API (`InternalProblems`) that Gradle 9.6 removed. 9.5.1 runs on the installed JDK 25 |
| AGP | **8.13.2** | AGP 9.5 needs build-tools 36.0.0, which is not installed. Using it would have meant installing into the shared `$ANDROID_HOME`; 8.13.2 uses the installed build-tools 35 |
| Kotlin | 2.4.21 (with the compose + serialization plugins) | |
| Compose BOM | 2026.06.01 | BOMs from 2026.08 on, activity 1.13 and core 1.18+ need compileSdk 37 / AGP 9.1 |
| compileSdk / targetSdk / minSdk | 36 / 36 / 31 | |
| JDK | Gradle runs on the system JDK 25. **The system JDK 25 is a JRE (no `javac`)**, so compiling uses a JDK 17 toolchain (`jvmToolchain(17)`), found at `/usr/lib/jvm/temurin-17-jdk` | The foojay resolver plugin downloads one into `~/.gradle/jdks` if none is installed. Nothing was downloaded into this folder, because a JDK 17 already exists |

Other notes:
- Dependencies are cached in `~/.gradle` as usual.
- Robolectric downloads its android-all-instrumented jar for SDK 34 on the first test run.

## 3. Architecture

```
:core  (Android library; everything outside core/android is pure JVM and unit-tested)
  util/       Bytes (hex, base64, sha256), Keccak256, Eth (wei, EIP-55, EIP-681), Der (port of OtkVerify.Der, strict ECDSA DER), Js
  attest/     AttestationVerifier (port of OtkVerify, same checks in the same order; injectable clock), AttestationPolicy, TrustAnchors
  certs/      CertStore (128-bit cert ids, files/certs), CertResolver (carried cert > cache > pinned root, like getCert)
  model/      CoinHeader, Output, SpendRecord, Bundle, ReceiveRequest, Note: JSON-tree wrappers, so unknown fields pass through
  protocol/   Protocol (PRAWL-OTK-v3 message, outputsHash, note ids, redeem key), RecipientPolicy, PaymentVerifier (accept3),
              OfflineWallet (mint / request / pay with split+change / carry / accept / redeem / retry)
  deposit/    DepositVerifier interface; SnapshotDepositVerifier (harness snapshot), CommitmentSnapshotDepositVerifier,
              LightClientDepositVerifier + LightClient (sync, proof build, forwarding), DepositSources
  handoff/    Handoff: HANDOFF.md v1 load/redeem encoder + link parser (byte-identical to handoff.py)
  transport/  Link, FramedLink (harness framing), SecureLink (AES-GCM, keyed by the QR), PayQr (receive code), PaymentSession
  keys/       KeyVault, SpendApprover interfaces
  store/      NoteStore: files/wallet/note_<alias>.json, pending_<name>.json (harness layout, atomic writes)
  android/    AndroidKeyVault, BiometricApprover (BiometricPrompt + CryptoObject), BluetoothTransport (BLE-L2CAP / RFCOMM),
              DeviceSelfTest, TrustStore (roots.pem + revocation list, online update)
  java/xyz/prawl/otktest/DepositProof.java   copied unchanged from raw/v3/deposit_proofs (JNI symbol needs that package)
  jniLibs/    libprawlbls.so (arm64-v8a, x86_64) copied unchanged
:app
  OfflineCashActivity (launcher + deep links + TWA hook), OfflineDataSyncActivity (signature-protected data hand-over)
  AppGraph (wiring, settings), ui/theme (Tailwind tokens), ui/components, ui/screens (7 screens)
  src/debug: HarnessActivity (adb harness mode); src/compatDebug: the Wallet3Activity alias
```

**Shared files.** The wallet files are the harness's own:
- `files/wallet`, `files/certs`, `files/in`, `files/out`;
- the AndroidKeyStore aliases `n_*` and `recv_*`.

Installing the compat APK over the harness (same package, same key; versionCode 300 > 1) therefore keeps the phone's notes and keys. The UI and harness mode share them, behind one wallet lock.

## 4. Interop with the Java harness

**Wire formats.** These are unchanged and verified on the real phone files:
- the `PRAWL-OTK-v3` message, outputsHash, note ids and redeem key;
- the request `{name, chain, certs, known}`;
- the bundle `{header, path, certs}`;
- 128-bit cert ids, and carrying only certificates the recipient lacks;
- retry by resending the stored bytes;
- the `mint3_`/`pay3_`/`redeem3_` files.

**App identity (important).** The harness accepts only keys created by package `xyz.prawl.otktest` with the debug cert digest. A phone still running the old harness therefore rejects keys made by `xyz.prawl.offline`. The fix is the **compat flavor**:
- It uses the harness's package and key, so old harness and new app accept each other's keys in both directions.
- The prawl flavor accepts an explicit allowlist of (package, cert) pairs: `xyz.prawl.offline` and `xyz.prawl.otktest`, both with the same debug cert (`BuildConfig.ALLOWED_APPS`).
- This is one deliberate widening of *which genuine apps* are trusted. It is not a relaxed check: package and digest are still both required, now as a pair.
- Release builds must replace the list with the release key.

**Harness mode.** Same extras, log tag `PRAWL_W2`, the `END <status>` line, and the same out-file names:
- Same commands: `mint`, `request`, `pay` (including `note=` malicious mode and `silent=true`), `accept`, `redeem`, `bt3_receive`/`bt3_pay` (plaintext RFCOMM, fixed harness UUID, so it can talk to an old-harness phone), `show`, `perm`.
- New commands:
  - `ble_receive` writes `out/qr_<name>.txt` and listens encrypted; `ble_pay … qr=<file>` pays it;
  - `selftest`;
  - `lc_sync`, `lc_proof coin`;
  - `import_snapshot`;
  - `pay precheck=false`, which lets the payee-side hop-limit test still be run.
- `mint` and `redeem` also write `out/handoff_load_*.json` and `out/handoff_redeem_*.json` (payload, d, both links).

## 5. Security checks kept, and what is stricter

**Kept as in the harness:**
- the attestation policy;
- the payee-key check before signing;
- expiry ≥ 1 h left, hop limit 3, cap 1 ETH, 0.05 ETH if the revocation list is > 48 h old;
- conservation, output→next-key binding, "addressed to me";
- persist-before-send and resend-same-bytes retry;
- reuse of a pending receive key;
- hardware refusal of re-spends.

`AttestationPolicy` and `RecipientPolicy` **throw** if built with weaker values. Settings can only tighten them: cap ≤ 1 ETH, lifetime ≥ 1 h (default 6 h), owner approval on by default.

**Added (each only refuses more):**
1. **Header binding.** The header's `k0x/k0y` must equal the attested genesis key. The escrow verifies spends with k0x/k0y, so a mismatch would pass every phone check but be unredeemable. `v` must be 3.
2. **Escrow allowlist.** The product accepts only Sepolia escrow `0x70b3…d6e5`. Harness mode accepts any escrow, like the harness.
3. **One note per receive key.** A second, different payment to an already-used key is rejected. That key can sign only once, so the second note would be lost.
4. **Payer pre-checks.** No note past the hop limit or below the minimum lifetime is signed away; the payee would have to reject it.
5. **No key that may hold value is ever replaced.** Reusing a label or name that still holds value is refused, and change-key aliases are collision-free. *A JVM test caught a real bug here:* a change alias built from the clock could overwrite the previous change key in the same millisecond.
6. **Data at rest.**
   - Notes are written atomically.
   - Backup and device transfer are disabled.
   - The clipboard marks copied files as sensitive.
7. **Receive code bound to the request.** The receive QR commits to the payee's key hash; the payer refuses a request with any other key. This stops another phone answering the BLE scan.
8. **Encrypted link.** App-to-app links use AES-256-GCM with keys from the QR's 16-byte secret (HKDF, one key per direction, counter nonces). A passive sniffer cannot read the bundle and its attestation chains, which would link the payment to the phone. A phone that did not scan the code cannot talk.
9. **Light-client proofs bound to the escrow.** A proof only counts for the trusted escrow address and chain. Anyone can deploy a look-alike contract whose storage "proves" anything.
10. **Harness mode is debug-only** (an exported adb entry point). The data hand-over activity needs a signature-level permission.

## 6. Website handoff (raw/v3/HANDOFF.md, as agreed)

**Format.** `Handoff.load` / `Handoff.redeem` produce compact JSON with the exact field order of `handoff.py`, then base64url without padding.
- Links: `https://<site>/#/offline/{load|redeem}?d=…` and `prawl://offline/…`.
- **Tested byte-for-byte:**
  - `load_ho_deposited.json` from `relay3ho/mint3_ho.json`;
  - `redeem_ho_0.003_unsubmitted.json` from `relay3ho/redeem3_ho_n_ho_c1793948361543.json` (identical payload JSON, `d` and https link);
  - `redeem_already_paid.json` matches one of the e2e redemptions.
- The parser rejects an unknown `v` and a kind/type mismatch.

**Configuration.**
- The site is a build-time config (`-Pprawl.site=…`, default `https://<site>`). While it is the placeholder, the UI says so and offers Copy / the prawl link.
- The depositor is scanned from the website's EIP-681 QR `ethereum:0x…@11155111`. The checksum is validated, and a wrong chain is refused. It can also be pasted.

**QR sizes** (measured, ZXing encode→decode round trip on the JVM):

| Payload | Link length | ECC | QR version |
|---|---|---|---|
| load | 596 chars | M | 19 |
| redeem 0.003 | 1,808 chars | L | 31 |
| `redeem_already_paid` | 2,529 chars | L | **37** |
| receive code | 290 chars | M | 13 |

HANDOFF.md says "version ≤ 30" for depth-2 notes. The real vectors need 31 and 37. They still fit one QR, but they are dense; the copy/open-link actions are the fallback.

## 7. Light-client deposit proofs (DepositProof.java plugged in)

**Integration.**
- `DepositProof.java` (unchanged, SHA-256 `48dceaa5…`) and `libprawlbls.so` are in `:core`.
- `PrawlApp` calls `DepositProof.loadNative(null)` once. If loading fails, proofs are reported as unverifiable and the snapshot fallback applies; it never crashes.
- `LightClientDepositVerifier` (behind `DepositVerifier`):
  1. computes keccak256(abi.encode(value, expiry, k0x, k0y, depositor)) from the header and requires k0x/k0y to be the attested key;
  2. requires the header escrow to be the trusted escrow;
  3. calls `DepositProof.verify(cache, proof, escrow, escrowStorageKey(coinId), commitment, now)`;
  4. on success, persists `updatedCache` and keeps the proof for forwarding.

**Bundle.** It gains an optional top-level `depositProof`.
- The recipient checks it first, then falls back to synced snapshots (`CompositeDepositVerifier`).
- Old harness phones ignore the field.
- Receive requests gain an optional `lc: {"min","max"}`, the payee's committee range. The payer then attaches the stored LightClientUpdates the payee needs (`LightClient.proofFor`).
- Redemption bundles do not carry the proof.

**Sync** (Settings / Load, online, user-initiated).
- **First bootstrap:** the finalized checkpoint from the Nimbus beacon API is accepted only if an independent HTTPS node (Lodestar or publicnode) confirms the same root and state root. Then `Cache.fromBootstrap`.
- **Later syncs** only apply LightClientUpdates, each verified by an already-trusted committee. Raw updates are stored to forward to stale recipients.
- About 30 periods are kept, covering the coins' 30-day lifetime.

**Proof building** (`LightClient.buildProof`, a port of `builder.build_proof`):
- finality_update → `eth_getBlockByHash` → RLP header rebuilt and checked against the block hash (Gloas/Amsterdam field orders as in the builder);
- `eth_getProof` at that block, cross-checked with a second RPC;
- the result is self-verified with `DepositProof.verify` against the phone's cache before it is stored.

**In the UI:**
- The Load screen's **"Check deposit (online)"** button proves the coin's own deposit and marks it deposited automatically. If the slot is still 0, it explains the ~15-minute finality delay. Manual "Mark as deposited" (with a confirmation) remains.
- The website can also hand over a proof through `OfflineDataSyncActivity` (extra `depositProof`). It is verified against the matching coin before it is kept.

**Network.**
- Endpoints are build-time config: Nimbus (HTTP), the Lodestar and publicnode checkers (HTTPS), `0xrpc.io/sep` and the thirdweb RPC (HTTPS).
- The network security config allows cleartext **only** for the Nimbus host. Its data is BLS/Merkle-verified, and the first checkpoint must be HTTPS-confirmed, so an attacker on the network can only deny service.
- **Privacy:** refreshing proofs reveals your coin ids and IP to the RPC. The UI says so. The wallet's private RPC path (Tor/anon-RPC) is the better source and can hand proofs over.

**Limit:** a recipient cannot verify a proof signed before its own first bootstrap, because committees cannot be learned backwards. Holders should refresh proofs online ("Refresh proofs of my coins"); otherwise the snapshot fallback applies.

## 8. Bluetooth without the MAC address

Android 12+ returns `02:00:00:00:00:00` from `getAddress()`, so the payee cannot put its MAC in the QR. Implemented in `BluetoothTransport`:

- **Default: BLE + L2CAP CoC.**
  1. The payee opens `listenUsingInsecureL2capChannel()`, which gives a dynamic PSM (put in the QR).
  2. It advertises only a **fresh random 128-bit session UUID**: connectable, no device name, no TX power.
  3. The payer scans with a filter on that UUID and gets the device under its rotating private LE address.
  4. The payer opens `createInsecureL2capChannel(psm)` (3 tries).

  No MAC, no pairing, no discoverability.
- **Fallback: classic RFCOMM.**
  1. The payee listens on insecure RFCOMM with the session UUID as its SDP service and becomes discoverable for 3 minutes (system dialog).
  2. The QR carries the phone's Bluetooth name.
  3. The payer runs classic discovery and connects RFCOMM by SDP to devices with that name.
- **Harness interop:** RFCOMM to a known MAC with the fixed harness UUID, plaintext, as before.

**Privacy.**

| Mode | Who can see what |
|---|---|
| BLE | Nearby observers see an advertisement with a random UUID that is never reused, from a rotating private address. A session cannot be linked to the phone or to other sessions |
| Classic | The phone's name and its stable public BR/EDR address are broadcast for 3 minutes to everyone nearby. Use it only when BLE fails |
| Both | The payment content is encrypted with the QR secret. Without encryption, the attestation chains would identify the paying phone (RESULTS v2: 14-day RKP / factory-key linkability) |
| The QR itself | Its holder (the payer) learns the request id, the one-time key hash and the session secret. Someone photographing it could at most read that one session's traffic, and cannot redirect the payment, because of the key-hash check |

## 9. Screens

All are dark only, mirroring the Tailwind tokens:
- zinc-950 page, max-w-xl, 16 dp padding;
- cards rounded 16 dp, zinc-800 border, zinc-900/60 fill;
- 14 sp medium headings, 12 sp zinc-500 secondary text;
- emerald-400 primary buttons with zinc-950 text, zinc-700-bordered secondary buttons;
- monospace amounts and addresses;
- emerald / amber / red status colours.

The screenshots are rendered on the JVM with Robolectric native graphics and Roborazzi (`ScreenshotTest`), in `docs/screenshots/`:

| Screen | File | Content |
|---|---|---|
| Offline balance | `1_balance.png`, `0_balance_empty_wallet.png` (live, empty store) | Spendable total, notes (value, hop n/3, expiry countdown, fingerprint flag), "refresh before expiry" warning, awaiting-deposit list, stale-revocation and no-deposit-data warnings |
| Receive | `2a_receive_new.png`, `2_receive_code.png`, `3_receive_accepted.png` | Optional amount, BLE/classic choice → QR (`prawl://offline/pay?d=…`) → waiting → accepted/rejected with **every verification line** in plain words. "Try again" reuses the pending key |
| Pay | `4_pay_verdict.png` | CameraX + ZXing scanner (or a `prawl://offline/pay` link) → amount (pre-filled if requested), showing which note is spent and the change → connect → BiometricPrompt + CryptoObject if the note's key needs it → the payee's verdict and check lines. "Verdict lost" explains the safe resend |
| Load | `5_load_code.png` (real handoff vector) | Depositor from an EIP-681 scan or paste, amount, lifetime 1–29 d → coin → HANDOFF `load` QR/link → "Check deposit (online)" (light client) or "Mark as deposited" / "Discard" |
| Cash out | `6_cashout_signed.png` (real redeem vector) | Pick a note, payout address (scan/paste), approve → HANDOFF `redeem` QR/link, Copy link, Open wallet, **Save file / Copy file** (full redeem3 JSON). Signed redemptions are kept and re-showable |
| Device check | `7_device_check.png` | Self-test: key → own attestation through the recipient policy → sign once → second signature refused. Shows security level, hardware- vs software-enforced limit, patch level, StrongBox, boot state, the single_use_key feature and the BLS library |
| Settings | `8_settings.png` (live) | Cap, minimum lifetime, owner approval per spend, Bluetooth mode, light-client sync/proofs, revocation list (update online, with a privacy warning), deposit-snapshot import (with a trust warning), about (harness activity name in debug builds) |

The permission screens (`PermissionGate`) explain why before the system dialog and link to app settings if permission was denied for good:
- BLUETOOTH_CONNECT + ADVERTISE to receive (CONNECT only for classic);
- SCAN + CONNECT to pay (`neverForLocation`);
- CAMERA to scan.

## 10. TWA hook

- **Open the offline-cash part:**
  - explicit intent, action `xyz.prawl.offline.action.OPEN`, extra `screen` = `balance|receive|pay|load|cashout|device|settings` (plus optional `depositor` / `payout`);
  - or deep links `prawl://offline/<screen>`, `prawl://offline/pay?d=…` (a receive code: pre-fills, never pays by itself), `prawl://offline/load?depositor=0x…`;
  - `prawl://offline/deposited?coinId=…&tx=…` (an optional extension) only shows a banner; the user still confirms.
- **Hand data in:** `OfflineDataSyncActivity`, action `xyz.prawl.offline.action.SYNC`, protected by `<applicationId>.permission.SYNC_OFFLINE_DATA` (signature level). The TWA in the same APK, or an app signed with the same key, can call it; a web page cannot. Extras:
  - `deposits`: commitments snapshot `{"v":1,"t":"deposits","chainId","escrow","commitments":{coinId:commitment}}`;
  - `revoked` + `revokedFetchedAt`;
  - `depositProof`.
- **Standalone:** the launcher icon opens `OfflineCashActivity` directly.

## 11. What was tested on the JVM (`./gradlew test`: all pass)

**`:core`: 67 tests,** run for both debug and release.

| Suite | What it covers |
|---|---|
| AttestationVectorsTest (11) | **Real chains:** Samsung StrongBox factory chain and OnePlus TEE RKP chain pass. Wrong package, wrong signing cert, revoked serial, unpinned root, truncated chain, swapped intermediate and an expired RKP certificate (clock after 2026-11-17) all fail. Policies cannot be weakened |
| PaymentVectorsTest (28) | **Real bundles accepted:** 1-hop Samsung→OnePlus, 2-hop OnePlus→Samsung (`pay3_s_dave1`), change-note spend, Sepolia e2e 1- and 2-hop, handoff run. The e2e coin passes against its **on-chain commitment** `0xe5c62e05…57aa` |
| | **Tampered copies rejected (19):** the phone's own tamper vector, inflated output, broken conservation, following the change output, a flipped signature byte, extended expiry, other coinId, inflated deposit, swapped header key, replay to another payee, substituted next key, missing or corrupted certificates, unknown deposit, hop limit, expiry, cap, stale revocation list → 0.05 cap, wrong escrow, a dropped spend, malformed input |
| HandoffAndProtocolTest (11) | HANDOFF vectors byte-identical; link parsing and the version check. Every real phone redemption signature verifies under the Kotlin message format. 311 Keccak vectors. The real Sepolia commitment and storage key. EIP-55/681, wei formatting, cert ids |
| LightClientTest (7) | 49 of the 50 shared DepositProof vectors (the 50th needs a package-private threshold override). The **real escrow-v3 proof of coin web1 backs the real coin**, and altered value/depositor/expiry, a proof of another coin, a look-alike escrow, no cache and a swapped key all fail. The **real bundle `pay3_web1_bobw` is accepted on the proof alone, with no snapshot**. A 3-periods-stale recipient accepts after the payer attaches the stored updates, and learns the committees. Bootstrap needs an independent confirmation. The RLP of the real Gloas/Amsterdam header re-encodes exactly |
| WalletFlowTest (10) | Software keys with single use emulated, three phones. Mint, then pending deposit → split/change → retry resends identical bytes → malicious re-spend refused (change key cleaned up) → 2nd hop over an **encrypted in-memory link** (rich verdict) → conservation across phones → redeem → HANDOFF payload. Also: payee-key check before signing, QR key-hash mismatch, one note per receive key, owner approval (a silent sign is refused), hop/lifetime pre-checks, wrong session secret → link lost with the key kept, label reuse, deposit-proof forwarding |

**`:app`: 12 tests** per debug variant.
- `QrRoundTripTest`: the real handoff links and receive codes encode and decode back exactly.
- `ScreenshotTest`: 10 renders.
- Release variants run only `QrRoundTripTest`.

## 12. Device checklist (for the coordinator)

**Install**
1. Install the **compat** APK over the harness on both phones: `adb install -r app-compat-debug.apk`. Then `w3 $A -e cmd show` should list the existing notes; this proves the same files and keystore are used.
2. Run `w3_split.sh` unchanged as the regression test (mint/request/pay/accept/redeem through the `Wallet3Activity` alias). Expect the same verdicts as `run3_split_105852.log`, including S5 REFUSED and S6 REJECTED.

**Interop**
3. Interop: one phone on the compat APK, the other on the **old harness APK**: pay in both directions with files and with `bt3_receive`/`bt3_pay`.

**Self-test**
4. `-e cmd selftest` on both phones, or the Device check screen. Expected:
   - Samsung: StrongBox, hardware limit, PASS;
   - OnePlus: TEE, RKP, hardware limit, PASS.

**Permissions**
5. `-e cmd perm`. Grant Nearby devices and Camera.

**Bluetooth**
6. New BLE path in harness mode:
   - `ble_receive name=x snapshot=snapshot.json` on B; pull `out/qr_x.txt`, push it to A;
   - `ble_pay coin=… amount=… qr=qr_x.txt` on A;
   - expect `PAID:ACCEPTED` and timings.
   - Then try classic: `transport=rfcomm` (B must be discoverable: accept the dialog, or `adb shell am start -a android.bluetooth.adapter.action.REQUEST_DISCOVERABLE`).
7. UI end to end on the **prawl** APK on both phones:
   - Load: scan the website's EIP-681 address QR, create the coin, deposit through the website using the load QR;
   - **Check deposit (online)** about 15 min later;
   - **Receive** on B (QR), **Pay** on A (scan, amount, fingerprint prompt), the verdict screen on both;
   - **Cash out** (QR → website submits → payout arrives).

**Light client**
8. Light client: Settings → Sync committees on both phones (watch logcat for the checkpoint confirmation).
   - Pay a coin with a proof to a phone **without** any snapshot: the receive screen's step 1 should say "light-client deposit proof: finalized block …".
   - Make one phone's cache stale (sync only once, days earlier) to see updates attached.

**Failure cases**
9. Failure UX:
   - Bluetooth off;
   - permission denied (then "Open settings");
   - payee walks away mid-payment (payer shows "verdict lost"; repeat → resend);
   - payee's "Try again" reuses the key;
   - a 4th hop is refused on the payer;
   - owner approval cancelled → refused, note intact.
10. Rotation during receive/pay (the activity handles config changes; flows run in ViewModels).

## 13. Known gaps

**Not tested on a device**
- **Nothing has run on a phone yet.** Not yet run on a phone, by component:
  - BLE advertising + L2CAP CoC between the Samsung (Android 17) and the OnePlus (Android 16): the main transport risk;
  - classic discovery;
  - BiometricPrompt per spend in the new app;
  - CameraX scanning;
  - Compose rendering on device.
- **Light-client online code is untested against live servers.** `syncCommittees`/`buildProof` were tested with recorded real data behind a fake HTTP layer, not against Nimbus/Geth. The endpoints' JSON shapes are taken from the Python builder.

**Light-client design limits**
- Proof age: a recipient can verify only proofs signed after its own first bootstrap. Holders must refresh proofs online; there is no automatic refresh.
- First bootstrap trust is "two independent servers agree" (trust on first use). The wallet can supply a checkpoint through the sync intent in future (not built).

**Missing pieces**
- The **commitments snapshot** format is defined and verified (including against the real on-chain commitment), but the wallet side that produces it is not built. File import exists.
- **RAILGUN payout:** the v3 protocol only has address payouts; the UI says it arrives with escrow v3.1.

**Release and trust inputs**
- **Release builds** are unsigned and still allowlist the debug key. A production release needs its own key in `ALLOWED_APPS` (and the harness keys removed).
- The revocation-list **file/intent install** trusts its input; only the in-app fetch from Google is over authenticated TLS. A newer list never drops serials from the bundled list. The bundled list was fetched 2026-11-05 11:37 UTC, so phones drop to the 0.05 ETH cap after **2026-11-07 11:37 UTC** until updated.

**Smaller gaps**
- There is a crash window between the hardware signature and the persisted note write (atomic, but after signing). A crash there loses that note's value; it cannot cause a double spend.
- The payer cannot know the payee's own cap or revocation staleness, so a payment can still be signed and then rejected. The bundle stays resendable to the same key.
- A `min_participants` vector of the 50 was skipped on the JVM; it needs a package-private field.
- The debug APK is 41 MB (Compose, not minified).
