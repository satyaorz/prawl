import { decodeAbiParameters, toFunctionSelector, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { workerBundleResponse } from "../src/bundle-serving";
import { DEFAULT_WORKER, pinnedSpecifier, resolveWorker, SPECIFIER_ADDRESS, WORKER_BUILDS } from "../src/worker-choice";

const ORIGIN = "https://wallet.example";
const call = (data: string, to: string = SPECIFIER_ADDRESS) => ({ method: "eth_call", params: [{ to, data }, "latest"] });

async function specifierAnswers(bundleUrl: string, hash: string) {
  const spec = pinnedSpecifier(bundleUrl, hash);
  const h = (await spec.request(call(toFunctionSelector("workerHash()")))) as Hex;
  const r = (await spec.request(call(toFunctionSelector("workerResolvers()")))) as Hex;
  return {
    hash: decodeAbiParameters([{ type: "bytes32" }], h)[0],
    resolvers: decodeAbiParameters([{ type: "string[]" }], r)[0],
  };
}

describe("worker selectable by config", () => {
  it("defaults to the stock 0.4.4 worker", () => {
    expect(DEFAULT_WORKER).toBe("stock");
    const w = resolveWorker(undefined, ORIGIN);
    expect(w).toEqual({
      name: "stock",
      hash: "0x5b62f358ce7a2b94ee9bc3a0e6a08757db68fa08fc348276f31eda788aec818b",
      bundleUrl: `${ORIGIN}/anon-rpc/worker-0x5b62f358ce7a2b94ee9bc3a0e6a08757db68fa08fc348276f31eda788aec818b.js`,
    });
  });

  it("selects the fork (cap 8), the cap-4 fork, or any keccak-named bundle we serve", () => {
    expect(resolveWorker("fork", ORIGIN).hash).toBe(WORKER_BUILDS.fork.hash);
    expect(resolveWorker("fork", ORIGIN).bundleUrl).toBe(`${ORIGIN}/anon-rpc/worker-${WORKER_BUILDS.fork.hash}.js`);
    expect(resolveWorker("fork-cap4", ORIGIN).hash).toBe("0x23cb6c8d580b26e8a054fcd6840e62631f06b4cb2c24253e14f2f886b3761ebc");
    expect(resolveWorker("fork-v3", ORIGIN).hash).toBe("0x65de36bd50200d9b988a7a81b8da63186cb9efc3ab54c0dbef1f71825df3d744");
    expect(resolveWorker("fork-v3", ORIGIN).bundleUrl).toBe(`${ORIGIN}/anon-rpc/worker-${WORKER_BUILDS["fork-v3"].hash}.js`);
    const custom = `0x${"ab".repeat(32)}`;
    expect(resolveWorker({ hash: custom.toUpperCase().replace("0X", "0x") }, ORIGIN)).toMatchObject({ name: "custom", hash: custom });
  });

  it("all known builds have distinct, well-formed hashes", () => {
    const hashes = Object.values(WORKER_BUILDS).map((b) => b.hash);
    expect(new Set(hashes).size).toBe(hashes.length);
    for (const h of hashes) expect(h).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("refuses unknown names, malformed hashes and non-http origins", () => {
    expect(() => resolveWorker("fork-cap16" as never, ORIGIN)).toThrow(/unknown worker/);
    expect(() => resolveWorker("toString" as never, ORIGIN)).toThrow(/unknown worker/);
    expect(() => resolveWorker({ hash: "0x1234" }, ORIGIN)).toThrow(/64 hex/);
    expect(() => resolveWorker("fork", "javascript:alert(1)")).toThrow();
  });

  it("always serves the bundle from our own origin, never a path from elsewhere", () => {
    const w = resolveWorker("fork", "https://wallet.example/some/page?x=1");
    expect(new URL(w.bundleUrl).origin).toBe(ORIGIN);
    expect(new URL(w.bundleUrl).pathname).toBe(`/anon-rpc/worker-${WORKER_BUILDS.fork.hash}.js`);
    // and the serving rules accept exactly that path
    expect(workerBundleResponse(new URL(w.bundleUrl).pathname, "br", { br: true, gz: true })).toMatchObject({ suffix: ".br" });
  });

  for (const name of ["stock", "fork", "fork-cap4", "fork-v3"] as const) {
    it(`the pinned specifier answers for the chosen hash (${name}) and lists only our local file`, async () => {
      const w = resolveWorker(name, ORIGIN);
      const got = await specifierAnswers(w.bundleUrl, w.hash);
      expect(got.hash).toBe(WORKER_BUILDS[name].hash);
      expect(got.resolvers).toEqual([w.bundleUrl]);
    });
  }

  it("the specifier answers nothing else", async () => {
    const w = resolveWorker("fork", ORIGIN);
    const spec = pinnedSpecifier(w.bundleUrl, w.hash);
    await expect(spec.request({ method: "eth_getBalance", params: [] })).rejects.toThrow();
    await expect(spec.request(call(toFunctionSelector("workerHash()"), "0x0000000000000000000000000000000000000001"))).rejects.toThrow(/wrong address/);
    await expect(spec.request(call("0xdeadbeef"))).rejects.toThrow(/unknown call/);
    expect(await spec.request({ method: "eth_chainId" })).toBe("0x1");
    expect(() => pinnedSpecifier(w.bundleUrl, "0x12")).toThrow();
  });
});
