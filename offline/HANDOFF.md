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

---
# v1.1 additions for escrow v3.1 (RAILGUN), 2026-11-06
Escrow v3.1: `0x236b1dC3b1a90E23728DA6E361b0Ab1C386cd779` on Sepolia. Its full interface is `escrow_v31/RESULTS.md` §6. Plain `load` and `redeem` (above) work unchanged against v3.1 too.

## 5. Phone → website: private load (`kind = load-private`)
```json
{"v":1,"t":"load-private","chainId":11155111,"escrow":"0x236b…d779",
 "params":{"coinId":"0x…","expiry":1794812810,"k0x":"0x…","k0y":"0x…",
           "depositor":"0x…reclaim address","minValue":"…","maxValue":"…","tip":"0"},
 "depositAddress":"0x…"}
```
**Website:**
1. `commitDeposit(params)`.
2. Check that `depositAddress(params)` equals the payload's `depositAddress`.
3. RAILGUN unshield of WETH, amount = `maxValue + tip`, recipient `depositAddress`. Kohaku grosses up the 0.25 % fee.
4. `activate(params)`.

For the default exact mode, `minValue == maxValue` = the coin value printed on the phone. `depositor` is only the reclaim/refund address. Use a fresh public address to keep the private link, and expect the usual exit-link caveat that an unshield amount and time are public.

## 6. Website → phone: shield target (`kind = shield-target`)
The phone must sign over the exact RAILGUN ShieldRequest:
1. The user picks a note on the phone. The phone shows its value V, and a QR saying "cash out V to a private balance".
2. The website builds a ShieldRequest (kohaku `Shield.addErc20(0zk, WETH, V)`) and shows:
```json
{"v":1,"t":"shield-target","chainId":11155111,"escrow":"0x236b…d779",
 "request":{"npk":"0x…","tokenType":0,"tokenAddress":"0xfff9…6b14","tokenSubID":"0","value":"V",
            "encryptedBundle":["0x…","0x…","0x…"],"shieldKey":"0x…"}}
```
3. The phone checks that `value == V`, the token is WETH and the type is ERC20. It computes `shieldHash = sha256(abi.encode(request))` (288 B, 9 static words), signs a REDEEM output with key `sha256hex("PRAWL-REDEEM-SHIELD|chainId|escrow40|" + shieldHash_hex)`, and returns:

## 7. Phone → website: cash out to a private balance (`kind = redeem-shield`)
The same object as `redeem`, plus `"shield": <the request above>`, with `redemption.payout` = `0x0000…0000`. The website simulates, then calls `redeemToShield(header, path, redemption, request)`. RAILGUN keeps its 25 bps shield fee.

## 8. Exact encoding of `shieldHash` (agreed with the wallet session)
`shield-target.request` is `{npk, tokenType, tokenAddress, tokenSubID, value, encryptedBundle[3], shieldKey}`:
- bytes32 and address fields as `0x` hex, and `tokenType`, `tokenSubID` and `value` as decimal strings.
- The tuple is Solidity `ShieldRequest = ((bytes32 npk, (uint8 tokenType, address tokenAddress, uint256 tokenSubID), uint120 value), (bytes32[3] encryptedBundle, bytes32 shieldKey))`.
- Every member is static, so `abi.encode(request)` is exactly **9 big-endian 32-byte words** in this order, with no offsets:
  `npk, tokenType, tokenAddress, tokenSubID, value, encryptedBundle[0], encryptedBundle[1], encryptedBundle[2], shieldKey`.
- `shieldHash = sha256(those 288 bytes)`, hex lowercase without `0x`.
- Output key: `sha256hex("PRAWL-REDEEM-SHIELD|" + chainId + "|" + escrow40 + "|" + shieldHash)`, where escrow40 is the lowercase 40-hex escrow address without `0x`.

The phone REFUSES unless: `tokenType == 0`, `tokenAddress` is WETH, `tokenSubID == 0`, `value` equals a held note's value exactly, and `escrow` matches the coin's escrow. The website should therefore ask the phone for the note value V first, then build the request for exactly V.

## 9. Deciding "paid" (agreed with the wallet session)
A mined `redeem` can return false or defer the payment while the receipt says success. Decide "paid" from the escrow's events (`Redeemed` for this coin), never from the receipt status. Our tools read `coins(coinId).paid` and the payout balance at the receipt block.
