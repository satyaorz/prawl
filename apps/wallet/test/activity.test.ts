import { describe, expect, it } from "vitest";
import { ActivityLog, MAX_ACTIVITY, type Activity } from "../src/lib/activity";

function memStore() {
  const m = new Map<string, unknown>();
  return { m, get: async <T,>(k: string) => m.get(k) as T | undefined, set: async (k: string, v: unknown) => m.set(k, v) };
}
const aesKey = () => crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
const entry = (at: number, kind: Activity["kind"] = "shield"): Activity => ({ at, kind, amount: "1000", txHash: `0x${at.toString(16).padStart(64, "0")}`, ok: true });

describe("activity log", () => {
  it("stores entries sealed (no plaintext on disk) and reads them back newest first", async () => {
    const store = memStore();
    const key = await aesKey();
    const log = new ActivityLog(store, key, "activity:1:abc");
    await log.add(entry(1, "shield"));
    await log.add({ ...entry(2, "send"), to: "0zk1qrecipient" });
    const raw = JSON.stringify(store.m.get("activity:1:abc"));
    expect(raw).not.toContain("0zk1qrecipient");
    expect(raw).not.toContain("shield");
    const again = new ActivityLog(store, key, "activity:1:abc");
    expect((await again.load()).map((a) => a.kind)).toEqual(["send", "shield"]);
  });

  it("reads as empty under another wallet's key or record name", async () => {
    const store = memStore();
    const log = new ActivityLog(store, await aesKey(), "activity:1:abc");
    await log.add(entry(1));
    expect(await new ActivityLog(store, await aesKey(), "activity:1:abc").load()).toEqual([]);
    // Same bytes under another name fail the AAD check.
    store.m.set("activity:1:other", store.m.get("activity:1:abc"));
    expect(await new ActivityLog(store, await aesKey(), "activity:1:other").load()).toEqual([]);
  });

  it("keeps every concurrent write and caps the history", async () => {
    const store = memStore();
    const key = await aesKey();
    const log = new ActivityLog(store, key, "a");
    await Promise.all(Array.from({ length: 5 }, (_, i) => log.add(entry(i + 1))));
    expect(await new ActivityLog(store, key, "a").load()).toHaveLength(5);
    for (let i = 0; i < MAX_ACTIVITY + 5; i++) await log.add(entry(100 + i));
    const all = await new ActivityLog(store, key, "a").load();
    expect(all).toHaveLength(MAX_ACTIVITY);
    expect(all.at(-1)!.at).toBe(105);
  });
});
