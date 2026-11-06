# Prawl offline cash: the Android app (v3 and v3.1), 2026-11-06

This folder is a Gradle project (Kotlin, Jetpack Compose). It has a `:core` protocol library, ported from the Java harness with the same wire formats, and an `:app` with the user-facing screens. The app also has a debug "harness mode" that the existing adb scripts can drive.

**Status:**
- Built and tested on the JVM here. The coordinator has since run the compat APK on the two phones (the v3 protocol, BLE+L2CAP and the verdict-delivery fix are verified there).
- The v3.1 additions (§14: shield cash-out, refresh, private load) have only been tested on the JVM so far.
- The device checklist is in §12; the v3.1 items are in §14.6.

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

**`:core`: 99 tests,** run for both debug and release (v3.1 adds 14, verdict delivery 5, audit F1/F2 13; see §14.5, §15, §16).

| Suite | What it covers |
|---|---|
| AttestationVectorsTest (11) | **Real chains:** Samsung StrongBox factory chain and OnePlus TEE RKP chain pass. Wrong package, wrong signing cert, revoked serial, unpinned root, truncated chain, swapped intermediate and an expired RKP certificate (clock after 2026-11-17) all fail. Policies cannot be weakened |
| PaymentVectorsTest (28) | **Real bundles accepted:** 1-hop Samsung→OnePlus, 2-hop OnePlus→Samsung (`pay3_s_dave1`), change-note spend, Sepolia e2e 1- and 2-hop, handoff run. The e2e coin passes against its **on-chain commitment** `0xe5c62e05…57aa` |
| | **Tampered copies rejected (19):** the phone's own tamper vector, inflated output, broken conservation, following the change output, a flipped signature byte, extended expiry, other coinId, inflated deposit, swapped header key, replay to another payee, substituted next key, missing or corrupted certificates, unknown deposit, hop limit, expiry, cap, stale revocation list → 0.05 cap, wrong escrow, a dropped spend, malformed input |
| HandoffAndProtocolTest (11) | HANDOFF vectors byte-identical; link parsing and the version check. Every real phone redemption signature verifies under the Kotlin message format. 311 Keccak vectors. The real Sepolia commitment and storage key. EIP-55/681, wei formatting, cert ids |
| LightClientTest (7) | 49 of the 50 shared DepositProof vectors (the 50th needs a package-private threshold override). The **real escrow-v3 proof of coin web1 backs the real coin**, and altered value/depositor/expiry, a proof of another coin, a look-alike escrow, no cache and a swapped key all fail. The **real bundle `pay3_web1_bobw` is accepted on the proof alone, with no snapshot**. A 3-periods-stale recipient accepts after the payer attaches the stored updates, and learns the committees. Bootstrap needs an independent confirmation. The RLP of the real Gloas/Amsterdam header re-encodes exactly |
| WalletFlowTest (10) | Software keys with single use emulated, three phones. Mint, then pending deposit → split/change → retry resends identical bytes → malicious re-spend refused (change key cleaned up) → 2nd hop over an **encrypted in-memory link** (rich verdict) → conservation across phones → redeem → HANDOFF payload. Also: payee-key check before signing, QR key-hash mismatch, one note per receive key, owner approval (a silent sign is refused), hop/lifetime pre-checks, wrong session secret → link lost with the key kept, label reuse, deposit-proof forwarding |

**`:app`: 19 tests** per debug variant (12 earlier + 6 v3.1 screenshots + 1 QR-size test; 3 in release variants).
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


## 14. v3.1 phone side (added 2026-11-06): shield cash-out, refresh, private load

Escrows: **v3.1 `0x236b1dC3b1a90E23728DA6E361b0Ab1C386cd779`** and **v3 `0x70b3B7EdCD18087C999ec80e3C3B0227c7e0D6E5`** (Sepolia). Specs followed: `escrow_v31/RESULTS.md` §3.5, §3.6, §6 and `HANDOFF.md` v1.1 §5–§9.

### 14.1 Escrow rules
- The product accepts and spends coins of **both** escrows for plain kinds (`Escrows.PRODUCT`: deposit/load, pay, redeem). That includes the receive-side escrow allowlist and the light-client trust set.
- **Shield cash-out, refresh and private load need v3.1 and are refused on v3.** The wallet refuses them before signing anything, so no key is burnt. The UI hides or explains them for v3 coins.
- New coins default to v3.1 (a Load-screen choice, v3 optional). Private load forces v3.1.
- Proof building uses each coin's **own** escrow. This fixed a latent bug: the Load screen passed the default escrow, which would have mis-proven v3 coins once two escrows exist.
- `mint` re-draws a coin id that starts with `RFSH` (0x52465348, reserved for refreshed coins).

### 14.2 Shield cash-out (`OfflineWallet.redeemShield`, `ShieldRequest`, `checkShield`)
- Output key `sha256hex("PRAWL-REDEEM-SHIELD|chainId|escrow40|" + sha256(abi.encode(ShieldRequest)))`; the encoding is the 9 static words (288 bytes).
- Request parsing is strict: hex lengths, decimal forms, value ≤ uint120, `encryptedBundle` has exactly 3 words.
- **Refusals** (all shown as green or red value-check lines in the UI, all enforced in `:core`):
  - the coin is on v3.1;
  - the target names this coin's chain and escrow (when it names them);
  - `tokenType == 0`, token = the chain's WETH (Sepolia `0xfff9…6b14`), `tokenSubID == 0`;
  - the shield value equals the note's value **exactly**;
  - and, as for any redemption, the note must be unspent, deposited and unexpired.
- Bundle: `redeem.kind = "shield"`, `redeem.shield` (the request exactly as the website sent it), `redeem.shieldHash`, payout `0x0000…0000`.
- Website payload: `t:"redeem-shield"` = the `redeem` payload plus `shield`. This follows HANDOFF §7.
- **Interpretation to confirm with the wallet session:** `shield` is the bare `request` object (not the whole `shield-target`), as the Java reference stores it and as `redeemToShield` consumes it.

### 14.3 Refresh (`OfflineWallet.refresh` / `markRefreshed`, `Refresh`)
- Output key `sha256hex("PRAWL-REFRESH|chainId|escrow40|newExpiry|newK0Hash|depositor40")`.
- The new coin id is derived, not chosen: `"RFSH" + sha256hex("PRAWL-REFRESH-ID|" + sha256hex(message) + "|" + index)[8:]` (index 0).
- The phone makes the new genesis key (same hardening: single-use, StrongBox if present, owner approval if set), takes a new expiry (1–28 days; the escrow needs ≤ 30 days at submission) and the new reclaim address, then signs. It refuses a zero or invalid reclaim address, a v3 coin, an expired note, and an out-of-range lifetime. If the hardware refuses the signature, the new key is deleted again.
- Bundle: `redeem.kind = "refresh"`, `redeem.refresh = {expiry, k0:[cert ids], k0x, k0y, depositor, coinId}` (`coinId` is an extra, derived field), payout = the new depositor. The new key's certificate chain is carried in `certs`.
- **State after submission** (the new coin does not exist as a spendable note yet):
  - the old note is marked spent with `refreshedTo`;
  - a pending record (`rec_refresh_<coinId>.json`) holds the new header, the new key alias and the signed bundle, and survives restarts;
  - `markRefreshed(coinId)` creates the new genesis note and consumes the record. The UI calls it after an online light-client check of the new coin, or after the user confirms manually.
  - The new coin's label is the old label plus `r` (`xr`, `xrr`, …), unique among live coins.
- **Provisional website payload** (HANDOFF.md has none yet): `t:"refresh"` = the `redeem` payload plus `refresh:{newCoinId, newExpiry, newK0x, newK0y}`, with `redemption.payout` = the new depositor. These are exactly the extra arguments of `refresh(header, path, redemption, newCoinId, newExpiry, newK0x, newK0y)`. **This needs agreeing with the wallet session.**

### 14.4 Private load (`load-private`, HANDOFF §5)
- `mint(…, privateLoad = true, tipWei)`: the header's `depositor` is the **reclaim address** (the user enters a fresh public address). It requires v3.1. Exact mode: `minValue = maxValue = value`; the tip is added to what must be unshielded.
- `Handoff.loadPrivate` produces `{v, t:"load-private", chainId, escrow, params{coinId, expiry, k0x, k0y, depositor, minValue, maxValue, tip}, depositAddress}`. `depositAddress` is computed on the phone as the CREATE2 address of the 56-byte forwarder (`DepositParamsV31`), so the website can check it against `depositAddress(params)` before sending funds.
- The Load screen shows the QR/link and the deposit address, and explains the unshield amount (value + tip). "Check deposit (online)" works as before (the deposit slot is the same).

### 14.5 Tests (JVM, 14 new in `V31Test`; all pass)
| Test | What |
|---|---|
| kohakuShieldHash | The **real kohaku ShieldRequest** hashes to `0x2b5ff8a94e78d1c735aa2ff9bee40b7497fa4b90d8faaedbc1beb0218255cd7c`; the 288 abi bytes equal the fixture's `abiEncoded`; also accepted wrapped in a `shield-target` |
| shieldVectorsMatchPython | 4 requests (1 real, 3 synthetic, one with a value near uint120) x 2 escrows: abi, hash and output key equal `v31_vectors.json` (generated by `tools/prawl_v3.py`) |
| refreshVectorsMatchPython | 4 refresh output keys x 2 escrows, and 6 derived `RFSH` coin ids, equal the Python vectors; the SPKI hash of a point equals the key's encoded hash |
| depositAddressesMatchPython | 4 DepositParams x 2 escrows: the CREATE2 deposit address equals the Python value |
| shieldRequestIsParsedStrictly | 8 malformed requests rejected |
| shieldCashOutOfTheKohakuRequest | End to end: the signed bundle's output key, shieldHash, payout `0x0`, signature (verified under the genesis key) and the `redeem-shield` payload |
| shieldRefusals | Value above or below the note, ERC721, another token, subID ≠ 0, another chain, another escrow, malformed, a **v3 coin**, an expired note: all refused with the note unspent and the key untouched |
| plainRedeemStillWorksOnBothEscrows | Plain redeem on v3 and v3.1 |
| refreshSigns… | Output key, derived coin id, signature, carried certs, the pending record, the new key kept, `markRefreshed` creating a spendable genesis note, the new coin cashable, an already-refreshed note refused |
| refreshRefusals | Lifetimes 0 / 60 s / > 28 d, zero or bad reclaim, v3 coin, a hardware refusal (the new key is deleted again), an expired note |
| refreshedLabelsStayUnique, privateLoadPayload, shieldTargetLinkParses | Labels; the `load-private` payload and deposit address; link parsing |

`:app` additions: six new screenshots (`9`, `9a`, `10`, `11`, `12`, `1a` in `docs/screenshots/`) and `QrRoundTripTest.redeemShieldQrSize` (7 tests).

### 14.6 UI changes
- **Cash out:** a switch "To an address / To a private balance". The private mode:
  1. shows the note's value V and a QR for the wallet;
  2. takes a `shield-target` (scan, or paste a link or JSON), and auto-selects the note whose value equals the request;
  3. shows the value-check lines (`9_cashout_private.png`; `9a_…mismatch.png` shows the red case);
  4. signs and shows the `redeem-shield` QR / copy / open / save file.
  Deep link: `prawl://offline/shield-target?d=…` opens it pre-filled (and never signs).
- **Balance:** each v3.1 note has a **Refresh** button; the warning appears when a note has less than **3 days** left (it was 48 h); v3 notes are labelled "v3" and can only be cashed out and loaded again; a "Refreshing" card lists signed refreshes awaiting confirmation. `prawl://offline/refreshed?coinId=…` opens one.
- **Refresh screen:** pick a note, lifetime, reclaim address → sign → QR/link/file for the wallet → "Check on-chain (online)" / "Mark as refreshed".
- **Load:** "Public deposit / Private (RAILGUN)" switch and an escrow choice (v3.1 default).
- **Provisional, not in HANDOFF.md:** the QR showing V (`t:"shield-ask"`, `{chainId, escrow, value}`) that HANDOFF §6.1 describes in words only.

### 14.7 Harness commands (debug builds; same activity as before)
| Command | Extras | Output |
|---|---|---|
| `redeem` with a shield | `coin`, `shield=<file in files/in>` (shield-target JSON or bare request) | The first unspent note of `coin` worth exactly the request value → `out/redeem3_<coin>_<alias>.json`, `out/handoff_redeem_shield_<coin>_<alias>.json`. REFUSED with the Java reference's messages |
| `refresh` | `coin`, `depositor=<reclaim>`, `expiresIn` (s, default 14 d), `note=<alias>`, `label=<new label>` | `out/refresh3_<coin>_<alias>.json`, `out/handoff_refresh_….json`; logs `REFRESH newCoinId 0x… newExpiry …` |
| `mark_refreshed` | `newcoin=<hex coin id>` | The new coin's genesis note appears (label `<coin>r`) |
| `load_private` | `coin`, `eth`, `depositor=<reclaim>`, `expiresIn`, `chainId`, `escrow` (default v3.1), `tip=<eth>` | `out/mint3_<coin>.json`, `out/handoff_load_private_<coin>.json`; logs the deposit address |
| any command | `v31escrow=<addr>` (+ `chainId`) | Treats that escrow as v3.1 as well (a local anvil deployment) |

Notes: the harness `redeem` without `shield` and `load_private` mint notes immediately spendable, like the harness's `mint`. Harness mode accepts any escrow for plain kinds, as before.

### 14.8 Known gaps and things to confirm
- **QR size.** A signed `redeem-shield` link for the real depth-1 note is **2,498 chars and fits one QR (version 37)**. A depth-2 note (about 2,500 chars for the plain redeem already, plus the ~800-char shield request) is **too large for any QR**; the app shows "too large for one QR" and the copy / open-link / save-file actions work. The same applies to refresh payloads of deep notes. A shield target for the phone to read is about 1,000 chars as a link and fits a QR comfortably.
- **Provisional payloads** (agree with the wallet session): `t:"refresh"` (§14.3) and `t:"shield-ask"` (§14.6). The interpretation of `shield` in `redeem-shield` (§14.2) should be confirmed.
- **Range-mode private load** (`minValue < maxValue`) is not offered; exact mode only. The tip is available in harness mode only (UI sends 0).
- The refresh lifetime cap is 28 days, below the escrow's 30, to leave room between signing and submission. A refresh submitted more than about 2 days after signing may revert on the window.
- Refresh and shield cash-out are **signature-final**: once signed, the old key is used up. Keep the signed file until the website's submission is confirmed (the UI says so). An abandoned refresh stays as a pending record; there is no "cancel" because the refresh could still be submitted later.
- Not tested on a device: the new screens, `redeemToShield` / `refresh` against the real escrow, and the unshield flow. No v3.1 transaction was sent by this work.
- Light-client proofs for the **new coin of a refresh** work through the same "Check on-chain (online)" path, but have not been run against a live refresh.

## 15. Verdict delivery fix (BLE+L2CAP, found on the phones)
**Bug:** with the Samsung as payee and the OnePlus as payer, the payee accepted but the payer got EOF instead of the verdict (5 of 5; the other direction 0 of 5). The payee closed the socket right after writing, and the stack dropped the unflushed verdict.

**Fix (`PaymentSession`):**
- The payee no longer closes right after the verdict. It waits (default 4 s, on a helper thread) for the payer's close-ack (`ACK` frame) or a disconnect, then closes.
- The payer sends the ACK after reading the verdict.
- Old harness payers that just disconnect still work. The payer's extra frame is ignored by an old harness payee.
- **Idempotent accept:**
  - After accepting, the wallet keeps `accepted_<name>.json` (the receive key's chain, the final spend signature's hash, the value; 7 days).
  - A resend of the same payment returns ACCEPTED without re-verifying or crediting twice, even if the payee has already spent the note.
  - `request(name)` re-presents the same key, so the payer's wallet resends the identical signed bytes.
  - The receive screen has a "Payer didn't see it?" button.

**Tests (`VerdictDeliveryTest`, 5):** an in-memory transport whose stack buffers writes and drops them when the writer closes first reproduces the bug (the payer ends `VerdictLost` while the payee holds the note); with the ack wait the verdict arrives; a silent payer cannot hang the payee; a connection that dies after the verdict is written leads to a successful resend answered ACCEPTED with nothing credited twice; the idempotent record survives spending the note and expires after 7 days.


## 16. Audit fixes F1 and F2 (wallet side), 2026-11-06
Source: `raw/v3/audit_contracts/FINDINGS.md`. The contract is behaving as specified; both holes were in the wallet.

**F1 (High), non-canonical text.**
- **The hole:** the spend message is plain text, and the escrow rebuilds it from `uint256` / `address` / `bytes32`, so it can only print one spelling. The wallet rebuilt it from the raw strings of the bundle. Mallory could sign text with an uppercase sibling key, an uppercase coinId, a `0x`-prefixed or uppercase escrow, or a chainId with leading zeros. Bob's wallet accepted, `redeem` failed with `BadSig` forever, and Mallory reclaimed after expiry.
- **The fix:** a canonical-text gate.
  - `Canonical` (new, in `core/protocol`) is the single definition of "canonical".
  - `Protocol.spendMessage` and `outputsHash` refuse to build a message from anything else (`NonCanonicalException`).
  - `PaymentVerifier` runs the gate first (step 0b) and stops there, with a precise failing line ("Canonical text") and a fail reason starting `non-canonical text in the signed message`.
- **What is checked, on the raw JSON strings:**
  - header: `chainId` decimal without leading zeros; `escrow` 40 lowercase hex; `coinId` 64 lowercase hex; `expiry` an integer literal (no `1.7E9`, `.0`, sign or zeros); deposit `value` positive decimal;
  - every output `value` (positive decimal, fits uint256) and `key` (64 lowercase hex);
  - the followed `index`;
  - the parent note id (when building).
- **One class beyond the finding:** every spend signature must be **strict, minimal DER** (`EcdsaDer.isCanonical`). Its hex goes into the child note id, and the escrow rebuilds DER from (r, s), so a padded or long-form signature would change every descendant's message in the same way.
- **Signing paths:** pay, redeem, shield and refresh refuse to sign from a note whose header, parent id or path is not canonical (`canonicalRefusal`), before any key is created or used. This also covers notes stored by older apps.
- **Payer side:** the message is built only from values the payer computes itself (lowercase key hashes), and `Protocol.spendMessage` would throw otherwise.

**F2 (Medium), fan-out.**
- **The constant:** `Protocol.MAX_OUTPUTS = 32`.
- **The recipient:** it refuses a spend with more outputs. The count is checked first, from the array length alone, so an oversized list is never parsed or hashed. A test checks the verdict's last line is the count check.
- **The payer:** the wallet's own spends have at most two outputs, and `Protocol` throws above 32.

**Tests (`CanonicalTest`, 13).**

| Test | What |
|---|---|
| messagesEqualTheEscrowFixtures | The wallet's message equals the escrow's `spendMessage()` **byte for byte** for **171 messages**: every spend and redemption in `escrow_v3/fixtures/v3_phone.json` and `v3_synthetic.json`. Those messages come from `prawl_v3.spend_message`, which the Foundry tests assert equal the contract's output. The one invalid vector (a zero-value output) is refused |
| typedModelOfTheEscrowEqualsTheWallet | 300 random typed inputs (uint256 values up to 2^256-1, up to 32 outputs, deep paths) through an independent model of `PrawlV3Codec` and through the wallet |
| headerStringsMustBeCanonical, protocolNeverBuilds…, strictDer | Unit negatives: uppercase / `0x` / short coinId; uppercase, `0x` and EIP-55 escrow; chainId `0…`, hex, exponent, negative, empty; value `01`, `0`, `+5`, `1.0`, 2^256; expiry as `…0`, `E9`, leading zero, 0, negative; uppercase or `0x` parent id and output key; padded, trailing-byte, truncated and long-form DER. Every real phone signature is canonical |
| control_canonicalBundleIsAccepted | The same forged-bundle machinery with canonical text is accepted |
| nonCanonicalSpellingsAreRefusedEvenWhenTheSignatureVerifies | **The attack:** a bundle genuinely signed by the genesis key over the attacker's spelling (the signature verifies over that text, asserted). Ten spellings, including the PoCs' uppercase sibling key, uppercase coinId, `0x` / uppercase escrow and `0…` chainId: all refused for non-canonical text, Bob's receive key stays pending |
| nonCanonicalJsonFieldsAreRefused… | Fields the wallet re-canonicalises itself (`+` value, index `00`, out-of-range index, float expiry, header value `0…`), and a padded or trailing-byte signature |
| thirtyTwoOutputsAreAccepted / thirtyThreeOutputsAreRefused | **32 accepted, 33 refused** (and 5,000 refused at the count) |
| thePayerNeverBuildsMoreThanTheLimit, walletRefusesToSignFromANonCanonicalNote, realPhoneBundlesAreCanonical | The payer side; notes with non-canonical data are never signed from (pay, redeem, shield, refresh all refuse, key untouched); every real phone bundle passes the gate |

**Mutation check (done, not kept):** with the gate and the `Protocol` checks removed, the "uppercase sibling output key" bundle is **accepted**, and 8 of the 13 tests fail. So the tests reproduce the audit's exploit against the old logic, and the fix closes it. The remaining tests fail only when the new checks are missing, not by accident.

**Legacy Java harness:**
- `Wallet3Activity.accept3` now has the same two checks (`canonProblem`, `strictDer`, `MAX_OUTPUTS = 32`), run before anything else.
- This is a change outside `v3/app/`, made at the coordinator's request.
- It was **only compile-checked** (`javac` into a scratch directory). It was not run or rebuilt into a harness APK, and the payer side (`pay3`) was not changed.

**Not done:** the contract-side F3/F4 hardening needs a redeploy, and the second reviewer's findings are still to come.
