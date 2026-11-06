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
vi.mock("../src/lib/store", () => ({ store: { get: vi.fn(async () => undefined), set: vi.fn(async () => undefined) } }));
vi.mock("../src/lib/tx", () => ({ publicBalance: vi.fn(async () => 0n), sendCalls: vi.fn(), sendUserOp: vi.fn() }));
vi.mock("@prawl/keys", () => ({
  createPasskey: vi.fn(async () => ({ root: new Uint8Array(32), credentialId: "cred", bornAt: 1_794_000_000 })),
  unlockWithPasskey: vi.fn(),
  deriveWalletKeys: vi.fn(async () => ({
    railgunSpending: `0x${"01".repeat(32)}`,
    railgunViewing: `0x${"02".repeat(32)}`,
    evmAccount: `0x${"03".repeat(32)}`,
    storage: {} as CryptoKey,
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
