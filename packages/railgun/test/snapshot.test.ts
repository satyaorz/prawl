import { describe, expect, it } from "vitest";
import { isPublicSnapshot, restoreStartBlock, seedFreshAccount, snapshotBlock, stripCheckpoint } from "../src";

const full = JSON.stringify({
  railgun: { utxo: { synced_block: 12073054, trees: { "0": { leaves: ["0x1"] } }, accounts: { "0zk1me": { notes: [{ v: 1 }], synced_block: 12073054 } } } },
  poi: {
    provider: { pending: [{ txid: "0x1" }], submitted: { list: ["0x2"] }, recovered_valid: ["0x3"] },
    txid: { synced_block: 1, trees: {}, pending: [{ public: true }], txid_to_utxo_position: {}, txid_to_txid_position: {}, own_ops: { "0x4": {} } },
    lists: { abc: { trees: {}, next_index: 3 } },
  },
});

describe("pool snapshots", () => {
  it("strips every wallet-specific part and keeps the public state", () => {
    const s = JSON.parse(stripCheckpoint(full));
    expect(s.railgun.utxo.accounts).toEqual({});
    expect(s.poi.provider).toEqual({ pending: [], submitted: {}, recovered_valid: [] });
    expect(s.poi.txid.own_ops).toEqual({});
    expect(s.railgun.utxo.trees).toEqual({ "0": { leaves: ["0x1"] } });
    expect(s.poi.txid.pending).toEqual([{ public: true }]);
    expect(s.poi.lists.abc.next_index).toBe(3);
  });

  it("accepts only snapshots without account data", () => {
    expect(isPublicSnapshot(full)).toBe(false);
    expect(isPublicSnapshot(stripCheckpoint(full))).toBe(true);
    const sneaky = JSON.parse(stripCheckpoint(full));
    sneaky.poi.txid.own_ops = { x: 1 };
    expect(isPublicSnapshot(JSON.stringify(sneaky))).toBe(false);
    expect(isPublicSnapshot("not json")).toBe(false);
    expect(isPublicSnapshot("{}")).toBe(false);
  });

  it("reads the snapshot block", () => {
    expect(snapshotBlock(full)).toBe(12073054n);
    expect(snapshotBlock("{}")).toBeUndefined();
  });

  it("refuses something that is not a checkpoint", () => {
    expect(() => stripCheckpoint("{}")).toThrow(/not a RAILGUN checkpoint/);
  });
});

describe("seedFreshAccount", () => {
  it("adds one empty account at the snapshot block", () => {
    const seeded = JSON.parse(seedFreshAccount(stripCheckpoint(full), "0zk1qnew"));
    expect(seeded.railgun.utxo.accounts).toEqual({ "0zk1qnew": { notes: [], synced_block: 12073054, spent: [], sent: [] } });
    expect(seeded.railgun.utxo.trees).toEqual({ "0": { leaves: ["0x1"] } });
  });

  it("only seeds clean public snapshots and real addresses", () => {
    expect(() => seedFreshAccount(full, "0zk1qnew")).toThrow(/public snapshot/);
    expect(() => seedFreshAccount(stripCheckpoint(full), "0xabc")).toThrow(/RAILGUN address/);
  });
});

describe("seeding a restored wallet", () => {
  it("can start the account before the snapshot block, never after it", () => {
    const snap = stripCheckpoint(full);
    expect(JSON.parse(seedFreshAccount(snap, "0zk1qold", 12_000_000n)).railgun.utxo.accounts["0zk1qold"].synced_block).toBe(12_000_000);
    expect(JSON.parse(seedFreshAccount(snap, "0zk1qold", 99_000_000n)).railgun.utxo.accounts["0zk1qold"].synced_block).toBe(12073054);
    // The public indexer state stays at the snapshot block; the core replays from the account.
    expect(JSON.parse(seedFreshAccount(snap, "0zk1qold", 12_000_000n)).railgun.utxo.synced_block).toBe(12073054);
    expect(() => seedFreshAccount(snap, "0zk1qold", -1n)).toThrow(/negative/);
  });
});

describe("restoreStartBlock", () => {
  const base = { chainId: 11_155_111, snapshotBlock: 12_074_320n, snapshotTime: 1_794_000_000, deploymentBlock: 5_784_866n, slackS: 0 };

  it("stays at or before the birth block even if every slot had a block", () => {
    // Born 1 h before the snapshot: at most 300 blocks + 1 lie in between.
    expect(restoreStartBlock({ ...base, bornAt: base.snapshotTime - 3600 })).toBe(12_074_320n - 300n - 1n);
  });

  it("subtracts the clock slack", () => {
    expect(restoreStartBlock({ ...base, slackS: 7200, bornAt: base.snapshotTime - 3600 })).toBe(12_074_320n - 900n - 1n);
  });

  it("caps a wallet born after the snapshot at the snapshot block's neighbourhood", () => {
    const start = restoreStartBlock({ ...base, bornAt: base.snapshotTime + 86_400 })!;
    expect(start).toBeLessThanOrEqual(base.snapshotBlock);
    expect(start).toBeGreaterThanOrEqual(base.snapshotBlock - 1n);
  });

  it("gives up on chains without 12 s slots and on wallets older than the deployment", () => {
    expect(restoreStartBlock({ ...base, chainId: 137, bornAt: base.snapshotTime })).toBeUndefined();
    expect(restoreStartBlock({ ...base, bornAt: base.snapshotTime - 400 * 86_400 * 365 })).toBeUndefined();
  });
});
