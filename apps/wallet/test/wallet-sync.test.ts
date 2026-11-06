import { beforeEach, describe, expect, it, vi } from "vitest";

// The RAILGUN worker, Tor client, storage and passkey are all faked: this tests
// the wallet session logic only (single-flight sync, PPOI queue submission).
const calls: string[] = [];
const openArgs: Array<Record<string, unknown>> = [];
const answers: Record<string, unknown> = {};
const rg = {
  onProgress: vi.fn(),
  prepare: vi.fn(async () => ({ deployment: { deploymentBlock: "1", wrappedBaseToken: "0xWETH" }, rpcUrl: "https://rpc.invalid" })),
  call: vi.fn(async (op: string, args: unknown) => {
    calls.push(op);
    if (op === "open") openArgs.push(args as Record<string, unknown>);
    if (op === "sync") await new Promise((r) => setTimeout(r, 20));
    const a = answers[op];
    return typeof a === "function" ? (a as () => unknown)() : a;
  }),
  useAccount: vi.fn(),
};
vi.mock("../src/railgun/controller", () => ({ railgun: () => rg }));
vi.mock("../src/lib/anon", () => ({ anon: { head: vi.fn(async () => 100n) } }));
const kv = new Map<string, unknown>();
vi.mock("../src/lib/store", () => ({ store: { get: vi.fn(async (k: string) => kv.get(k)), set: vi.fn(async (k: string, v: unknown) => kv.set(k, v)) } }));
vi.mock("../src/lib/tx", () => ({
  publicBalance: vi.fn(async () => 0n),
  sendCalls: vi.fn(async () => [{ hash: `0x${"cd".repeat(32)}`, status: "success", blockNumber: 1n, gasUsed: 21000n }]),
  sendUserOp: vi.fn(),
}));
const storageKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
vi.mock("@prawl/keys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@prawl/keys")>()),
  createPasskey: vi.fn(async () => ({ root: new Uint8Array(32), credentialId: "cred", bornAt: 1_794_000_000 })),
  unlockWithPasskey: vi.fn(),
  deriveWalletKeys: vi.fn(async () => ({
    railgunSpending: `0x${"01".repeat(32)}`,
    railgunViewing: `0x${"02".repeat(32)}`,
    evmAccount: `0x${"03".repeat(32)}`,
    storage: storageKey,
  })),
}));

const wallet = await import("../src/lib/wallet");

function reset(pending: number, report?: object) {
  calls.length = 0;
  Object.assign(answers, {
    open: { address: "0zk1me", syncedBlock: "50", restored: false },
    sync: { syncedBlock: "100" },
    balances: [],
    poiPendingCount: pending,
    processPendingPoi: report,
    refreshPoi: undefined,
    close: undefined,
  });
}

describe("wallet sync", () => {
  beforeEach(async () => {
    await wallet.lockWallet();
  });

  it("runs one sync at a time and skips PPOI submission when nothing is queued", async () => {
    reset(0);
    await wallet.createWallet();
    calls.length = 0;
    await Promise.all([wallet.sync(), wallet.sync(), wallet.sync()]);
    expect(calls.filter((c) => c === "sync")).toHaveLength(1);
    expect(calls).not.toContain("processPendingPoi");
    expect(wallet.walletState.get().phase).toBe("ready");
    expect(wallet.walletState.get().poiQueue).toBe(0);
  });

  it("submits queued PPOI proofs after a sync and refreshes balances once they are taken", async () => {
    reset(2, { pendingBefore: 2, submitted: ["0xaa"], waitingForTxid: ["0xbb"], waitingForInputPoi: [], failed: [], pendingAfter: 1 });
    await wallet.createWallet();
    expect(calls.indexOf("processPendingPoi")).toBeGreaterThan(calls.indexOf("sync"));
    expect(calls.slice(calls.indexOf("processPendingPoi"))).toEqual(["processPendingPoi", "refreshPoi", "balances"]);
    expect(wallet.walletState.get().poiQueue).toBe(1);
  });

  it("keeps the wallet ready when PPOI submission fails", async () => {
    reset(1);
    answers.processPendingPoi = () => {
      throw new Error("PPOI node down");
    };
    await wallet.createWallet();
    const s = wallet.walletState.get();
    expect(s.phase).toBe("ready");
    expect(s.poiError).toBe("PPOI node down");
    expect(calls).not.toContain("refreshPoi");
  });

  it("passes the passkey's creation time to the worker, and a full rescan drops it with the checkpoint", async () => {
    reset(0);
    openArgs.length = 0;
    await wallet.createWallet();
    expect(openArgs[0]).toMatchObject({ fresh: true, bornAt: 1_794_000_000 });
    expect(openArgs[0]).not.toHaveProperty("discardCheckpoint");
    await wallet.rescanWallet();
    expect(openArgs[1]).toMatchObject({ fresh: false, discardCheckpoint: true });
    expect(openArgs[1]).not.toHaveProperty("bornAt");
    expect(calls.lastIndexOf("close")).toBeLessThan(calls.lastIndexOf("open"));
    expect(wallet.walletState.get().phase).toBe("ready");
  });
});

describe("private op costs", () => {
  it("matches kohaku's gross_up vectors (railgun-wasm userop.rs tests)", () => {
    expect(wallet.grossUp(9_975n, 25n)).toBe(9_999n);
    expect(wallet.grossUp(1n, 25n)).toBe(1n);
    expect(wallet.grossUp(1_000n, 25n)).toBe(1_002n);
    expect(wallet.grossUp(310_000_000_000_000_000n, 25n)).toBe(310_776_942_355_889_724n);
    expect(wallet.grossUp(12_345n, 0n)).toBe(12_345n);
    for (let a = 1n; a < 3_000n; a += 7n) {
      const g = wallet.grossUp(a, 25n);
      expect(g - (g * 25n) / 10_000n).toBeGreaterThanOrEqual(a);
      expect(g - 1n - ((g - 1n) * 25n) / 10_000n).toBeLessThan(a);
    }
  });

  it("fits amount, 0.25% fee and gas inside the spendable balance", () => {
    const available = 43_890_000_000_000_000n; // 0.04389 ETH, as in the live run
    for (const kind of ["send", "unshield"] as const) {
      const max = wallet.maxPrivateAmountWei(kind, available);
      expect(max).toBeGreaterThan(0n);
      expect(max + wallet.privateFeeWei(kind, max) + wallet.privateGasEstimateWei()).toBeLessThanOrEqual(available);
      // One more gwei-scale step would not fit.
      expect(max + 1_000_000_000n + wallet.privateFeeWei(kind, max + 1_000_000_000n) + wallet.privateGasEstimateWei()).toBeGreaterThan(available);
    }
    expect(wallet.privateFeeWei("send", 10n ** 18n)).toBe(0n);
    // kohaku's gross_up: the recipient gets exactly the amount, so the fee is grossed up (not amount * 0.25%).
    expect(wallet.privateFeeWei("unshield", 10n ** 18n)).toBe(wallet.grossUp(10n ** 18n) - 10n ** 18n);
  });

  it("has nothing to offer when gas alone exceeds the balance", () => {
    expect(wallet.maxPrivateAmountWei("unshield", 1_000_000_000_000_000n)).toBe(0n);
  });
});

describe("activity history", () => {
  it("records a finished public send in the sealed log and clears it on lock", async () => {
    await wallet.lockWallet();
    reset(0);
    await wallet.createWallet();
    expect(wallet.walletState.get().activity).toEqual([]);
    await wallet.sendPublicEth("0x00000000000000000000000000000000000000e5", 1000n);
    const [entry] = wallet.walletState.get().activity ?? [];
    expect(entry).toMatchObject({ kind: "public-send", amount: "1000", to: "0x00000000000000000000000000000000000000e5", ok: true, txHash: `0x${"cd".repeat(32)}` });
    const sealed = [...kv.entries()].find(([k]) => k.startsWith("activity:"));
    expect(sealed).toBeDefined();
    expect(JSON.stringify(sealed![1])).not.toContain("00e5");
    await wallet.lockWallet();
    expect(wallet.walletState.get().activity).toBeUndefined();
  });
});
