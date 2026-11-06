# Prowl offline pay

Pay ETH phone to phone with no network, without a double spend.

> **Naming.** The product is **Prowl**. Some identifiers still say `prawl` on purpose: the Android package `xyz.prawl.offline`, the key and
> message labels (`prawl/v1/...`, `PRAWL-OTK-v3`), the site's domain and the `window.prawlOffline` bridge. Keys, passkeys and coins are bound
> to them, so changing them would mean a new wallet. The repository is `satyaorz/prawl`.

Each coin is owned by a key that the phone's secure hardware will sign with **only once**
(Android Keystore `setMaxUsageCount(1)`, StrongBox where available). The recipient checks the
phone's Google-signed key attestation offline, so a copied wallet or a rooted phone cannot
spend the same coin twice. A coin is backed by an ETH deposit in an escrow contract, and a
recipient can check that deposit offline too, from a light-client proof of a finalized
Ethereum block.

The website never holds offline cash. It sends the two on-chain steps: **load** (deposit) and
**cash out** (redeem). The Android app does everything in between, with no network.

## How a payment works

1. **Load (online).** The phone creates a coin key and shows a *load* code. The website scans it
   and sends `deposit(...)` to the escrow, or, privately, funds the coin from a RAILGUN unshield
   (`commitDeposit` → unshield → `activate`).
2. **Pay (offline).** The receiver shows a one-time code. The payer scans it, signs one spend
   (the amount to the receiver plus change to a fresh key of its own) and sends it over Bluetooth
   Low Energy. The receiver verifies, entirely offline:
   - the coin's deposit (light-client proof, or a synced snapshot);
   - every key in the chain: hardware one-time key, genuine Prowl app, locked bootloader,
     recent security patch, not on the revocation list;
   - every signature, value conservation, expiry, hop limit and value cap.
3. **Cash out (online).** The holder's phone signs a *redeem* spend naming a payout address (or
   a RAILGUN shield). The website simulates and submits it to the escrow.

A second spend of the same coin is refused by the phone's own secure hardware. If a broken
or faked device ever signs twice, the two signatures are public proof, the coin's branch is
frozen on-chain and (with device bonds) the device's bond is slashed.

## What is guaranteed, and what is not

| | |
|---|---|
| Prevention of double spending | **Yes**, given that the phone's secure hardware enforces the one-use limit (verified per key from its attestation) |
| Detection and punishment if hardware fails | Yes: equivocation evidence freezes the branch; device bonds are slashable |
| Payments reveal the payer's phone | **Yes today.** Every key in a coin's history carries its attestation chain. A zero-knowledge proof of the attestation hides the device (circuits in `zk-attestation/`; they cover RKP chains, with factory StrongBox chains in progress) |
| Coins can be lost | A wiped app or lost phone loses its coins. They expire (default 14 days, at most 30); the depositor reclaims what was never redeemed. Holders refresh a coin before it expires |
| Trust | Google's attestation and each phone model's secure hardware; Ethereum's sync-committee honesty for deposit proofs |

## Layout

| Path | What |
|---|---|
| `app/` | The Android app (Kotlin, Compose). `:core` is the protocol library (also runs on the JVM), `:app` the screens |
| `android/` | The older Java test app and the adb scripts that drive two phones |
| `contracts-v3/` | Escrow **v3** (split notes, phone-signed redeem, equivocation freeze) and its Sepolia tooling |
| `contracts/` | Earlier on-chain pieces: attestation parsing, device-bond registry |
| `deposit-proofs/` | Offline light-client proof of an escrow deposit (Python reference, Java verifier, blst via JNI) |
| `zk-attestation/` | Zero-knowledge proof that a coin key is a hardware single-use key, without revealing the phone |
| `tools/` | `handoff.py`, `handoff_sim.py`: build and simulate the phone↔website payloads |
| `SPEC-v3.md`, `HANDOFF.md`, `INTERFACE.md`, `DEPLOYMENTS.md` | Protocol, link formats, what the wallet calls, deployed addresses |
| `prototypes/` | Earlier prototypes and simulations |

## Deployed (Sepolia, chain 11155111)

See `DEPLOYMENTS.md`. Escrow v3 `0x70b3B7EdCD18087C999ec80e3C3B0227c7e0D6E5`; escrow v3.1 (RAILGUN load and
cash-out, refresh) `0x236b1dC3b1a90E23728DA6E361b0Ab1C386cd779`.

## Run it

Needs: Android SDK (build-tools 35), JDK 17, Foundry (forge/anvil), Python 3 with `cryptography`,
and for the phone tests two Android 12+ phones (one with StrongBox helps) on USB with debugging on.

```
# The Android app
cd app                                      # see app/README.md; the debug key is created by the first build
./gradlew :core:test                        # JVM tests
./gradlew :app:assemblePrawlDebug -Pprawl.site=https://<your-wallet-site>   # app/build/outputs/apk/prawl/debug

# Phone regression (compat APK installed over the old test app, package xyz.prawl.otktest)
cd android && export A=<phone A adb serial> B=<phone B adb serial>
./w3_split.sh                               # split, change, double-spend refusals, tamper
./w3_ble_loop.sh                            # ten BLE payments between the two phones

# Contracts
cd contracts-v3 && forge test               # evm_version = osaka
```

The contract and app tests also use fixtures built from real phone runs (`tools/*_to_foundry.py`).
Those hold the phones' attestation chains, which identify the devices, so they are not in the
repo. Run the phone scripts first to make your own. This directory is the source of truth for the
app (the local research tree only links here).

## Demo script (about 5 minutes)

1. **Device check** on both phones: Device → Run self-test. It shows "This phone can hold offline cash",
   with the hardware one-use limit proven.
2. **Load:** website → Offline cash → show the wallet QR. Phone A → Load → scan it, enter an
   amount, show the load code. The website scans it and deposits on Sepolia.
3. **Pay offline** with airplane mode on (Bluetooth only): phone B → Receive; phone A → Pay → scan →
   amount → fingerprint. Both phones show the verification lines.
4. **Try to cheat:** with a note already paid, try to pay it again. The phone's secure hardware refuses to sign.
5. **Cash out:** phone B → Cash out → code → the website submits it. The payout arrives on Sepolia.
6. **Private cash out** (RAILGUN, v3.1): the website shows a shield target; the phone signs the redemption
   over it; the escrow shields the funds into the wallet's private balance.
