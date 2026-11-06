import { describe, expect, it } from "vitest";
import { isIdempotent } from "../src/client";
import { AnonRpcError, DESTINATION_TOR_KINDS, EXIT_SIDE_TOR_KINDS, fromWorkerError, retryAction, torKindOf } from "../src/errors";
import { createRailgunFetch } from "../src/railgun-fetch";
import { ADDR_A, okRpc, setup, type Behavior } from "./fake-worker";

// --------------------------------------------------------------- idempotent

describe("anonOptions.idempotent: reads only, never writes", () => {
  it("marks JSON-RPC reads, batches, multicall reads and HTTP GETs", async () => {
    const s = setup((c) => (c.host === "ppoi.fdi.network" ? { bytes: "ok" } : okRpc(c)), { client: { httpHosts: ["ppoi.fdi.network"] } });
    const a = s.client.identities.account(ADDR_A);
    await s.client.read(a, 1, "eth_getBalance", [ADDR_A, "latest"]);
    await s.client.batch(a, 1, [{ method: "eth_getBalance", params: [ADDR_A, "latest"] }, { method: "eth_getCode", params: [ADDR_A, "latest"] }]);
    await s.client.http(s.client.identities.publicScope("railgun"), { url: "https://ppoi.fdi.network/health" });
    expect(s.log).toHaveLength(3);
    for (const c of s.log) expect(c.anonOptions).toEqual({ isolationKey: c.key, idempotent: true });
    expect(s.traces.every((t) => t.idempotent)).toBe(true);
  });

  it("never marks eth_sendRawTransaction or eth_sendUserOperation", async () => {
    const s = setup();
    await s.client.write(s.client.identities.ephemeral("send"), 1, "eth_sendRawTransaction", ["0x02f8"]);
    await s.client.write(s.client.identities.ephemeral("uo"), 1, "eth_sendUserOperation", [{ sender: ADDR_A }, ADDR_A]);
    expect(s.log).toHaveLength(2);
    for (const c of s.log) {
      expect(c.anonOptions).toEqual({ isolationKey: c.key });
      expect("idempotent" in c.anonOptions!).toBe(false);
    }
    expect(s.traces.map((t) => t.idempotent)).toEqual([false, false]);
  });

  it("never marks a write that failed, and still sends it once only", async () => {
    const s = setup(() => ({ error: { code: "HTTP_REQUEST", message: "peer closed connection", name: "TorError.RemoteStreamClosed" } }));
    await expect(s.client.write(s.client.identities.ephemeral("send"), 1, "eth_sendRawTransaction", ["0x02"])).rejects.toBeTruthy();
    expect(s.log).toHaveLength(1);
    expect(s.log[0]!.anonOptions!.idempotent).toBeUndefined();
  });

  it("never marks HTTP writes: proof submission and eth_sendUserOperation through the RAILGUN shim; bundler reads are reads", async () => {
    const POI = "ppoi.fdi.network";
    const BUNDLER = "public.pimlico.io";
    const s = setup(() => ({ json: { jsonrpc: "2.0", id: 1, result: true } }), { client: { httpHosts: [POI, BUNDLER] } });
    const f = createRailgunFetch({ client: s.client, squidHosts: [], poiHosts: [POI], artifactHosts: [], bundlerHosts: [BUNDLER] });
    await f(`https://${POI}/`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ppoi_submit_transact_proof", params: {} }) });
    await f(`https://${BUNDLER}/`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "eth_sendUserOperation", params: [] }) });
    await f(`https://${BUNDLER}/`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "eth_supportedEntryPoints", params: [] }) });
    // A POI read is a read.
    await f(`https://${POI}/`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ppoi_validated_txid", params: {} }) });
    expect(s.log.map((c) => c.anonOptions!.idempotent ?? false)).toEqual([false, false, true, true]);
  });

  it("a body naming a sending or submitting method is never marked, whatever the request kind", () => {
    const body = (method: string) => JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] });
    for (const m of ["eth_sendRawTransaction", "eth_sendUserOperation", "eth_sendBundle", "ppoi_submit_poi", "relay_transact", "railgun_submit_proof"]) {
      expect(isIdempotent({ kind: "read", body: body(m) })).toBe(false);
      expect(isIdempotent({ kind: "get", body: body(m) })).toBe(false);
    }
    expect(isIdempotent({ kind: "read", body: JSON.stringify([{ method: "eth_call" }, { method: "eth_sendRawTransaction" }]) })).toBe(false);
    expect(isIdempotent({ kind: "write", body: body("eth_call") })).toBe(false);
    expect(isIdempotent({ kind: "read", body: body("eth_call") })).toBe(true);
    expect(isIdempotent({ kind: "get" })).toBe(true);
  });

  it("retries of a read stay marked; the flag never crosses into a write on the same identity", async () => {
    let n = 0;
    const s = setup((c) => (n++ === 0 ? { error: { code: "CONNECTION", message: "x" } } : okRpc(c)));
    const id = s.client.identities.ephemeral("mixed");
    await s.client.read(id, 1, "eth_blockNumber");
    await s.client.write(id, 1, "eth_sendRawTransaction", ["0x02"]);
    expect(s.log.map((c) => c.anonOptions!.idempotent ?? false)).toEqual([true, true, false]);
  });
});

// ------------------------------------------------------------------ torKind

const tor = (kind: string, code = "CONNECTION"): Behavior => ({ error: { code, message: `failed: ${kind}`, name: `TorError.${kind}` } });

describe("TorError.<kind> in the retry decision", () => {
  it("reads the kind from the fork's error name, and from a torKind property; rejects junk", () => {
    expect(torKindOf({ name: "TorError.RemoteConnectionRefused" })).toBe("RemoteConnectionRefused");
    expect(torKindOf({ name: "Error", torKind: "ExitTimeout" })).toBe("ExitTimeout");
    expect(torKindOf({ name: "Error" })).toBeUndefined();
    expect(torKindOf({ name: "TorError." })).toBeUndefined();
    expect(torKindOf({ name: "TorError.a b<script>" })).toBeUndefined();
    const e = fromWorkerError(Object.assign(new Error("m"), { name: "TorError.CircuitCollapse", code: "CONNECTION" }));
    expect(e).toMatchObject({ code: "CONNECTION", torKind: "CircuitCollapse" });
    // An unclassified code keeps the kind too.
    expect(fromWorkerError(Object.assign(new Error("m"), { name: "TorError.ExitTimeout" }))).toMatchObject({ code: "WORKER_ERROR", torKind: "ExitTimeout" });
  });

  it("decides: exit-side rotates, destination answers go to the next provider, fatal stops, no kind falls back to the code", () => {
    const err = (code: string, torKind?: string) => new AnonRpcError("x", code as never, torKind ? { torKind } : {});
    for (const k of EXIT_SIDE_TOR_KINDS) expect(retryAction(err("CONNECTION", k))).toBe("rotate");
    for (const k of DESTINATION_TOR_KINDS) expect(retryAction(err("CONNECTION", k))).toBe("next-provider");
    expect(retryAction(err("CONNECTION", "InvalidStreamTarget"))).toBe("stop");
    expect(retryAction(err("WORKER_ERROR", "ExitTimeout"))).toBe("rotate"); // the kind upgrades an unknown code
    expect(retryAction(err("CONNECTION"))).toBe("rotate"); // stock worker: code rule unchanged
    expect(retryAction(err("CONNECTION", "SomeFutureKind"))).toBe("rotate"); // unlisted kind: code rule
    expect(retryAction(err("WORKER_ERROR", "SomeFutureKind"))).toBe("stop");
    expect(retryAction(err("WORKER_ERROR"))).toBe("stop");
    expect(retryAction(err("ABORTED", "ExitTimeout"))).toBe("stop");
  });

  for (const kind of ["ExitTimeout", "RemoteNetworkFailed", "ExitPolicyRejected", "CircuitCollapse", "RemoteHostResolutionFailed", "RemoteStreamReset"]) {
    it(`rotates the circuit on exit-side ${kind}`, async () => {
      let n = 0;
      const s = setup((c) => (n++ === 0 ? tor(kind) : okRpc(c)));
      await expect(s.client.read(s.client.identities.account(ADDR_A), 1, "eth_blockNumber")).resolves.toBe("0x1000");
      expect(s.log.map((c) => c.key)).toEqual([`acct:${ADDR_A}@publicnode-mainnet#0`, `acct:${ADDR_A}@publicnode-mainnet#1`]);
      expect(s.traces[0]).toMatchObject({ ok: false, code: "CONNECTION", torKind: kind, retry: "rotate" });
    });
  }

  it("does not rotate on RemoteConnectionRefused: no same-provider retry, failover to the next provider, circuit kept", async () => {
    let n = 0;
    const s = setup((c) => (n++ === 0 ? tor("RemoteConnectionRefused") : okRpc(c)));
    const a = s.client.identities.account(ADDR_A);
    await expect(s.client.read(a, 1, "eth_blockNumber")).resolves.toBe("0x1000");
    expect(s.log.map((c) => c.key)).toEqual([`acct:${ADDR_A}@publicnode-mainnet#0`, `acct:${ADDR_A}@drpc-mainnet#0`]);
    expect(s.log[1]!.host).not.toBe(s.log[0]!.host);
    expect(s.traces[0]).toMatchObject({ torKind: "RemoteConnectionRefused", retry: "next-provider" });
    // The primary circuit was not rotated: the next read uses generation 0 again.
    await s.client.read(a, 1, "eth_chainId");
    expect(s.log[2]!.key).toBe(`acct:${ADDR_A}@publicnode-mainnet#0`);
  });

  it("with failover off, RemoteConnectionRefused fails after one attempt", async () => {
    const s = setup(() => tor("RemoteConnectionRefused"), { client: { failover: false } });
    await expect(s.client.read(s.client.identities.account(ADDR_A), 1, "eth_blockNumber")).rejects.toMatchObject({
      code: "CONNECTION",
      torKind: "RemoteConnectionRefused",
    });
    expect(s.log).toHaveLength(1);
  });

  it("an exit-side kind on an unclassified code is still retried on a fresh circuit", async () => {
    let n = 0;
    const s = setup((c) => (n++ === 0 ? tor("TorNetworkTimeout", "INTERNAL") : okRpc(c)));
    await expect(s.client.read(s.client.identities.account(ADDR_A), 1, "eth_blockNumber")).resolves.toBe("0x1000");
    expect(s.log.map((c) => c.key!.split("#")[1])).toEqual(["0", "1"]);
  });

  it("a fatal kind (InvalidStreamTarget) is not retried even though its code is CONNECTION", async () => {
    const s = setup(() => tor("InvalidStreamTarget"));
    await expect(s.client.read(s.client.identities.account(ADDR_A), 1, "eth_blockNumber")).rejects.toMatchObject({ torKind: "InvalidStreamTarget" });
    expect(s.log).toHaveLength(1);
  });

  it("destination answers do not count against the worker; exit-side failures do", async () => {
    const refused = setup(() => tor("RemoteConnectionRefused"), { client: { failover: false } });
    const a = refused.client.identities.account(ADDR_A);
    for (let i = 0; i < 4; i++) await expect(refused.client.read(a, 1, "eth_blockNumber")).rejects.toBeTruthy();
    expect(refused.host.stats.replacements).toBe(0);
    expect(refused.workers).toHaveLength(1);

    const exit = setup(() => tor("ExitTimeout"), { client: { failover: false } });
    const b = exit.client.identities.account(ADDR_A);
    for (let i = 0; i < 3; i++) await expect(exit.client.read(b, 1, "eth_blockNumber")).rejects.toBeTruthy();
    expect(exit.host.stats.replacements).toBe(1);
  });

  it("writes stay single-attempt whatever the kind", async () => {
    for (const kind of ["ExitTimeout", "RemoteConnectionRefused", "CircuitCollapse"]) {
      const s = setup(() => tor(kind));
      await expect(s.client.write(s.client.identities.ephemeral("send"), 1, "eth_sendRawTransaction", ["0x02"])).rejects.toMatchObject({ torKind: kind });
      expect(s.log).toHaveLength(1);
    }
  });
});
