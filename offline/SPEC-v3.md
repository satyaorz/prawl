# Prowl offline coins: protocol v3 (draft, 2026-11-06)

v3 makes two changes to v2:
1. **Deposit proofs.** A recipient checks offline that a coin is backed by a real on-chain deposit, using an Ethereum light-client proof. This replaces the laptop-built snapshot.
2. **Splitting and change.** One signature can create several outputs.

Everything else from v2 stays:
- hardware one-time keys (`setMaxUsageCount(1)`), with attestation checked by the recipient;
- expiry, hop limit, value cap;
- per-spend owner approval;
- safe retry;
- phone-signed redemption.

## 1. Deposit (on-chain, escrow v3)
`deposit(bytes32 coinId, uint64 expiry, uint256 k0x, uint256 k0y)` with `msg.value = value` (wei).

The escrow stores `deposits[coinId] = keccak256(abi.encode(value, expiry, k0x, k0y, depositor))`. It is a `mapping(bytes32 => bytes32)` in **storage slot 0**, so its storage key is `keccak256(abi.encode(coinId, uint256(0)))`. coinId is 32 random bytes chosen by the depositor's phone; reusing one reverts.

## 2. Deposit proof (carried with the coin, verified offline)
`DepositProof` = {
- `beacon`: a finalized beacon block header, plus a sync-committee aggregate signature over it (SyncAggregate: participation bits + BLS signature) and the signing slot. If the recipient's cached committee is older, it also carries any `LightClientUpdate`s needed to step the recipient's cached sync committee forward to the signing period.
- `execution`: the execution payload header fields needed (at least `state_root` and `block_number`), plus the SSZ Merkle branch proving them against the beacon header's body root (Capella+ `execution_branch`).
- `account`: `eth_getProof` account proof for the escrow address against `state_root`, giving `storageRoot`.
- `storage`: storage proof for `keccak256(abi.encode(coinId, 0))` against `storageRoot`, giving the 32-byte value.

}

The recipient recomputes `keccak256(abi.encode(value, expiry, k0x, k0y, depositor))` from the coin and compares it with the storage value.

> **Amended 2026-11-06 for Gloas (ePBS).** Sepolia runs Gloas from epoch 353024 (fork version `0x90000076`), and the beacon block body no longer holds the execution payload.
> - **Execution step:** the light-client header proves `execution_block_hash` (gindex 2856, the last executed payload). The proof therefore also carries the RLP execution header. The verifier checks `keccak(header) == execution_block_hash` and reads `stateRoot` and `number` from it.
> - **Domain:** the signing domain uses the fork of `epoch(signature_slot − 1)`.
> - **Participation:** at least 342 of 512 signers.
> - **Reference:** `deposit_proofs/` (Python reference + `DepositProof.java` with blst via JNI). Measured on a Samsung S25 Ultra: 19.5 ms with the committee cached, 63 ms with 3 committee steps. On 2026-11-06 a real escrow deposit was proven and verified on the phone.

**Trust:** Ethereum's sync-committee honest-majority assumption, which is standard for light clients, plus the recipient's sync-committee cache from its last online sync.

## 3. Notes and spends (splitting)
A *note* is a spendable piece of a coin: (value in wei, one-time key K).
- The genesis note is (deposit value, k0).
- Spending a note with its one-time key K creates `n ≥ 1` output notes.

Spend message (UTF-8; integers in decimal; hashes in lowercase hex):
```
PRAWL-OTK-v3|<chainId>|<escrow40>|<coinIdHex64>|<expiry>|<depth>|<parentNoteId>|<outputsHash>
```
- `depth` = number of spends from genesis to this note.
- `parentNoteId`: `sha256hex("genesis|" + coinIdHex64)` for the genesis note; `sha256hex(sigDER_of_parent_spend + "|" + outputIndex)` for every other note. The signature is hex-encoded inside the hashed string.
- `outputsHash = sha256hex(join(";", [valueWei_i + ":" + keyHash_i]))`.
  - `keyHash_i` is the SPKI-DER SHA-256 of output i's one-time key, or, for a redemption output, `sha256hex("PRAWL-REDEEM|" + chainId + "|" + escrow40 + "|" + payout40)`.
- Rule: `Σ valueWei_i == value of the note being spent`; every `valueWei_i > 0`.
- Change is just another output, paid to a fresh one-time key on the payer's own phone.

The recipient of output j receives the bundle:
- coin header: coinId, expiry, deposit value, k0, depositor, DepositProof;
- for each spend on the path from genesis to its note: the signer's attestation chain (v2 compact cert references), the full outputs list, the index taken, and the signature.

The recipient verifies everything v2 verifies, plus:
- the DepositProof;
- per-spend value conservation;
- that the output it receives pays its own pending receive key.

## 4. Redemption and conflicts (escrow v3)
- **Redemption.** A note is redeemed only through a spend whose output is a PRAWL-REDEEM output, signed by the note's own one-time key ("tip auth", the default and only mode). The escrow verifies the path with P256VERIFY, the conservation rule and the expiry, then pays each REDEEM output once.
- **Total payout per coin ≤ the deposit**, enforced by an explicit counter.
- **Conflict.** Two different valid spend messages under the same one-time key are equivocation (hardware or attestation failure). Either branch reaching the escrow, or `proveEquivocation`, freezes the coin, and the evidence can slash the device bond.
- **Expiry.** After expiry plus a grace period, unredeemed value can be reclaimed by the depositor. Recipients therefore require a minimum remaining lifetime (v2 rule).
