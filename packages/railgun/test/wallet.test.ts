import { describe, expect, it } from "vitest";
import { RailgunWallet } from "../src";
import { fakeWasm } from "./fake-wasm";

const keys = { spendingKey: `0x${"11".repeat(32)}`, viewingKey: `0x${"22".repeat(32)}` } as const;

async function open(syncDelayMs = 1) {
  const f = fakeWasm({ syncDelayMs });
  const wallet = await RailgunWallet.open({ wasm: f.wasm, chainId: 11155111, rpcUrl: "https://rpc.test/11155111", ...keys });
  return { wallet, ...f };
}

describe("RailgunWallet", () => {
  it("serialises calls so a getter never runs while a sync holds the session", async () => {
    const { wallet } = await open(20);
    const sync = wallet.sync({ head: 5_000_100n, windowBlocks: 50n });
    // These would throw "recursive use" against the raw bindings.
    const [balances, checkpoint] = await Promise.all([wallet.balances(), wallet.checkpoint()]);
    await sync;
    expect(balances[0]).toEqual({ asset: "0xtoken", amount: "100", poiStatus: "Valid" });
    expect(JSON.parse(checkpoint)).toHaveProperty("synced");
    expect(wallet.syncedBlock).toBe(5_000_100n);
  });

  it("syncs in windows from the deployment block and hands over a checkpoint after each", async () => {
    const { wallet, log } = await open();
    const progress: bigint[] = [];
    const checkpoints: string[] = [];
    await wallet.sync({
      head: 5_000_250n,
      windowBlocks: 100n,
      onProgress: (p) => progress.push(p.synced),
      onCheckpoint: (c) => void checkpoints.push(c),
    });
    expect(log).toEqual(["syncTo 5000100", "syncTo 5000200", "syncTo 5000250"]);
    expect(progress).toEqual([5_000_100n, 5_000_200n, 5_000_250n]);
    expect(checkpoints).toHaveLength(3);
  });

  it("resumes from the synced block", async () => {
    const { wallet, log } = await open();
    await wallet.sync({ head: 5_000_100n, windowBlocks: 100n });
    await wallet.sync({ head: 5_000_150n, windowBlocks: 100n });
    expect(log).toEqual(["syncTo 5000100", "syncTo 5000150"]);
  });

  it("stops between windows when aborted", async () => {
    const { wallet, log } = await open();
    const ac = new AbortController();
    await expect(
      wallet.sync({ head: 5_001_000n, windowBlocks: 100n, signal: ac.signal, onProgress: () => ac.abort(new Error("stop")) }),
    ).rejects.toThrow("stop");
    expect(log).toHaveLength(1);
  });

  it("builds shield calls and frees the parsed address", async () => {
    const { wallet, freed } = await open();
    const before = freed();
    const calls = wallet.buildShield("0zk1recipient", [
      { token: "native", amount: 10n },
      { token: "0x1234", amount: 5n },
    ]);
    expect(calls).toHaveLength(2);
    expect(freed()).toBe(before + 1);
  });

  it("refuses empty or non-positive shields and frees the builder", async () => {
    const { wallet, freed } = await open();
    expect(() => wallet.buildShield("0zk1r", [])).toThrow(/nothing/);
    const before = freed();
    expect(() => wallet.buildShield("0zk1r", [{ token: "native", amount: 0n }])).toThrow(/positive/);
    expect(freed()).toBe(before + 2); // address + unbuilt shield
  });

  it("prepares transfer and unshield user operations", async () => {
    const { wallet } = await open();
    const t = await wallet.prepareTransfer({ recipient: "0zk1bob", token: "0x1234", amount: 7n, accountPrivateKey: `0x${"33".repeat(32)}`, bundlerUrl: "https://b" });
    expect(t.userOpHash).toBe("0xabc");
    const u = await wallet.prepareUnshield({ recipient: "0x1234", token: "0x1234", amount: 8n, accountPrivateKey: `0x${"33".repeat(32)}`, bundlerUrl: "https://b" });
    expect(u.userOpHash).toBe("0xdef");
  });

  it("rejects calls after close and frees once", async () => {
    const { wallet, freed } = await open();
    await wallet.close();
    await wallet.close();
    expect(freed()).toBe(2); // session + chain
    await expect(wallet.balances()).rejects.toThrow(/closed/);
  });

  it("refuses chains without a RAILGUN deployment", async () => {
    const { wasm } = fakeWasm();
    await expect(RailgunWallet.open({ wasm, chainId: 10, rpcUrl: "https://r/10", ...keys })).rejects.toThrow(/no deployment/);
  });
});
