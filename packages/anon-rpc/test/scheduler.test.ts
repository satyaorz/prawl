import { describe, expect, it } from "vitest";
import { Scheduler } from "../src/scheduler";
import { okRpc, setup, sleep } from "./fake-worker";

const addr = (i: number) => `0x${i.toString(16).padStart(40, "0")}`;

describe("rule 5: scheduler", () => {
  it("caps one identity at 4 in flight by default", async () => {
    const s = setup((c) => ({ ...(okRpc(c) as object), delayMs: 15 }) as never, { client: { deadlines: { headersMs: 500, totalMs: 1000 } } });
    const a = s.client.identities.account(addr(1));
    await Promise.all(Array.from({ length: 10 }, (_, i) => s.client.read(a, 1, "eth_getStorageAt", [addr(1), `0x${i}`, "latest"])));
    expect(s.workers[0]!.maxInflightByIdentity.get(`acct:${addr(1)}`)).toBe(4);
  });

  it("caps the total at 12 across identities", async () => {
    const s = setup((c) => ({ ...(okRpc(c) as object), delayMs: 15 }) as never, { client: { deadlines: { headersMs: 500, totalMs: 1000 } } });
    const ids = Array.from({ length: 6 }, (_, i) => s.client.identities.account(addr(i + 1)));
    await Promise.all(ids.flatMap((id, j) => Array.from({ length: 4 }, (_, i) => s.client.read(id, 1, "eth_getStorageAt", [addr(j + 1), `0x${i}`, "latest"]))));
    expect(s.workers[0]!.maxInflight).toBe(12);
    expect(s.client.stats().scheduler.maxActive).toBe(12);
  });

  it("spaces starts by a random delay only when the identity switches", async () => {
    const sch = new Scheduler({ switchJitterMs: [40, 40] });
    const starts: Array<[string, number]> = [];
    const t0 = performance.now();
    const job = (id: string) => sch.run(id, async () => void starts.push([id, performance.now() - t0]));
    await Promise.all([job("A"), job("A"), job("B"), job("B")]);
    const [a1, a2, b1, b2] = starts.map((x) => x[1]);
    expect(a2! - a1!).toBeLessThan(20); // same identity: no delay
    expect(b1! - a2!).toBeGreaterThanOrEqual(35); // switch: delayed
    expect(b2! - b1!).toBeLessThan(20);
    expect(sch.stats.identitySwitches).toBe(1);
  });

  it("does not over-throttle: a slot frees as soon as a request ends", async () => {
    const sch = new Scheduler({ perIdentity: 1, switchJitterMs: [0, 0] });
    const t0 = performance.now();
    await Promise.all([1, 2, 3].map(() => sch.run("A", () => sleep(10))));
    expect(performance.now() - t0).toBeLessThan(80);
  });

  it("a retry holds the slot, so retries never exceed the limits", async () => {
    // Every request's first circuit fails, so each one needs a retry.
    const s = setup((c) => (c.key!.endsWith("#0") ? { error: { code: "CONNECTION", message: "x" }, delayMs: 5 } : { ...(okRpc(c) as object), delayMs: 5 }) as never, {
      client: { scheduler: { perIdentity: 2, switchJitterMs: [0, 0] } },
    });
    const a = s.client.identities.account(addr(9));
    await Promise.all(Array.from({ length: 6 }, (_, i) => s.client.read(a, 1, "eth_getStorageAt", [addr(9), `0x${i}`, "latest"])));
    expect(s.log.length).toBeGreaterThan(6);
    expect(s.workers[0]!.maxInflightByIdentity.get(`acct:${addr(9)}`)).toBeLessThanOrEqual(2);
  });
});
