# Prawl offline pay

Pay ETH phone to phone with no network, without a double spend. Each coin is a key
the phone's secure hardware will sign with only once (Android Keystore
`setMaxUsageCount(1)`), and the chain checks the phone's attestation that the limit
is enforced in hardware.

Tested on a Samsung S25 Ultra (StrongBox) and a OnePlus CPH2487 (TEE): transfers
over Bluetooth RFCOMM, and every double spend, replay and tamper attempt blocked.

## Layout

| Path | What |
|---|---|
| `android/` | Test app (`WalletActivity`, `Wallet2Activity`, `OtkVerify`) and the adb scripts that drive two phones |
| `contracts/` | Foundry: escrow that redeems phone-signed payment chains with P256VERIFY, on-chain Android attestation, device bond registry |
| `prototypes/` | Earlier prototypes and simulations: lock certificates, designated notes, counter-cheques, privacy sizing |

## Run

```
cd android && ./build.sh                          # needs Android SDK build-tools 35
A=<phone A adb serial> B=<phone B adb serial> ./two_phone_test.sh
cd ../contracts && forge install foundry-rs/forge-std --no-git && forge test
```

The contract tests read fixtures built from the phones' runs (`tools/vectors*_to_foundry.py`).
Those fixtures hold the phones' attestation chains, which identify the devices, so they are
not in the repo. Run the phone scripts first to generate your own.

`scripts/sync-offline.sh` copies this code in from the local research tree.
