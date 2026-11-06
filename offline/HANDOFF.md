# Phone ↔ website handoff (v1, 2026-11-06)

The Android offline-cash app and the Prawl website exchange small payloads by **QR code** or **link**. The website never holds offline cash. It only sends the on-chain transactions: deposit ("load") and redeem ("cash out"). Both sides must build to this exact format.

Network: Sepolia (chainId 11155111). Escrow v3: `0x70b3B7EdCD18087C999ec80e3C3B0227c7e0D6E5`.

## Encoding
- **Payload:** UTF-8 JSON, then base64url without padding. That string is `<d>`.
- **QR content:** the https link `https://<site>/#/offline/<kind>?d=<d>`. A fragment keeps the payload out of server logs. The website reads it on load, or by scanning with its webcam scanner. The Android app also accepts `prawl://offline/<kind>?d=<d>`.
- **Hex:** every hex field is `0x`-prefixed. bytes32 values are 64 hex chars lowercase; addresses are EIP-55 or lowercase. Amounts are decimal strings in wei.
- **Version:** `"v":1` always. Unknown fields are ignored, and an unknown `v` is rejected.

## 1. Website → phone: depositor address
Before minting, the phone must know which account will send the deposit, because the depositor is inside the on-chain commitment. The website shows its public address as an EIP-681 QR: `ethereum:0xABC…@11155111`. The phone scans it.

## 2. Phone → website: load (`kind = load`)
```json
{"v":1,"t":"load","chainId":11155111,"escrow":"0x70b3…d6e5",
 "coinId":"0x…32 bytes","value":"10000000000000000","expiry":1794810431,
 "k0x":"0x…32 bytes","k0y":"0x…32 bytes","depositor":"0x03a6…b47b"}
```
**Website:**
1. Check that chainId and escrow match its config, and that `depositor` is the account it will send from. Refuse otherwise, because a mismatched depositor makes the coin unprovable.
2. Check that `deposits[coinId]` is zero and `now < expiry ≤ now + maxLifetime()`.
3. Simulate `deposit(coinId, expiry, k0x, k0y)` with `value` wei, then send.
4. Show the tx hash. When the user taps "Deposited" on the phone, the phone treats the coin as live. Light-client deposit proofs will later replace this manual step.

Private loading through a RAILGUN unshield waits for escrow v3.1, which adds commit-then-fund. Its payload will be `t:"load-private"`, defined when v3.1 lands.

## 3. Phone → website: cash out (`kind = redeem`)
The phone builds the exact arguments of `redeem(Header, Spend[], Redemption)`, so the website needs no certificates and no protocol logic:
```json
{"v":1,"t":"redeem","chainId":11155111,"escrow":"0x70b3…d6e5",
 "header":{"coinId":"0x…","value":"…","expiry":1794810431,"k0x":"0x…","k0y":"0x…","depositor":"0x…"},
 "path":[{"outputs":[{"value":"…","keyHash":"0x…"},{"value":"…","keyHash":"0x…"}],
          "index":0,"r":"0x…","s":"0x…","nextX":"0x…","nextY":"0x…"}],
 "redemption":{"outputs":[{"value":"…","keyHash":"0x…"}],"index":0,"payout":"0x…","r":"0x…","s":"0x…"}}
```
- **Website:**
  1. ABI-encode `redeem(header, path, redemption)` against the escrow ABI.
  2. Simulate with `eth_call`. If it returns `false`, it would freeze rather than pay: show an error and do not send.
  3. Send from any account. The payout is fixed by the phone's signature, so the sender can't redirect it.
  4. Show the payout received.
- **Gas on Sepolia:** about 360k–540k.
- **Size:** about 1–1.5 KB of base64 for a depth-2 note, which fits one QR (byte mode, version ≤ 30).
- `redeemToShield` (cash out straight into RAILGUN) waits for v3.1. Its payload will be `t:"redeem-shield"`.

## 4. Status (website, read-only)
`deposits(coinId)` (bytes32, non-zero means deposited) and `coins(coinId)` (paid wei, frozen, closed).

## Test vectors
`raw/v3/handoff_vectors/` holds payloads made from real phone bundles: a load, and a redeem for a coin that is not yet redeemed.
