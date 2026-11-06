import { afterEach, describe, expect, it, vi } from "vitest";
import type { FromFheWorker, ToFheWorker } from "../src/swap/fhe-protocol";

const account = "0x1111111111111111111111111111111111111111";
const contract = "0x2222222222222222222222222222222222222222" as const;
const identity = { key: "isolated-account" };
const read = vi.fn(async () => "0x1");
const http = vi.fn(async (_id: unknown, req: { url: string }) => ({
  status: 200, statusText: "OK", headers: new Headers(), body: new TextEncoder().encode("ok"), url: req.url,
}));
vi.mock("../src/lib/anon", () => ({ anon: { identities: { account: () => identity }, read, http } }));

class FakeWorker {
  static last: FakeWorker;
  onmessage?: (event: MessageEvent<FromFheWorker>) => void;
  onerror?: () => void;
  onmessageerror?: () => void;
  sent: ToFheWorker[] = [];
  terminated = false;
  constructor() { FakeWorker.last = this; }
  postMessage(message: ToFheWorker) {
    this.sent.push(message);
    if (message.type === "call" && message.call.op === "init") {
      queueMicrotask(() => this.emit({ type: "result", id: message.id, ok: true, value: true }));
    }
  }
  emit(message: FromFheWorker) { this.onmessage?.({ data: message } as MessageEvent<FromFheWorker>); }
  terminate() { this.terminated = true; }
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("FHE controller", () => {
  it("keeps encryption in its worker and rejects pending work when closed", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const { FheController } = await import("../src/swap/fhe-controller");
    const controller = await FheController.open(account, 11155111);
    const result = controller.encrypt(contract, 42n, 1, 35n);
    const worker = FakeWorker.last;
    expect(worker.sent.at(-1)).toMatchObject({ type: "call", call: { op: "encrypt", contract, amount: "42", direction: 1, minimumOutput: "35" } });
    controller.close();
    await expect(result).rejects.toThrow("FHE session closed");
    expect(worker.terminated).toBe(true);
    await expect(controller.encrypt(contract, 1n)).rejects.toThrow("FHE session closed");
  });

  it("forwards worker RPC and relayer requests only through the isolated transport", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const { FheController } = await import("../src/swap/fhe-controller");
    const controller = await FheController.open(account, 11155111);
    const worker = FakeWorker.last;
    worker.emit({ type: "rpc", id: 51, method: "eth_call", params: [] });
    worker.emit({ type: "fetch", id: 52, url: "https://relayer.testnet.zama.org/v2/keyurl", method: "GET", headers: [], body: null });
    await vi.waitFor(() => expect(worker.sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "rpc-result", id: 51, ok: true }),
      expect.objectContaining({ type: "fetch-result", id: 52, ok: true }),
    ])));
    expect(read).toHaveBeenCalledWith(identity, 11155111, "eth_call", []);
    expect(http).toHaveBeenCalledWith(identity, expect.objectContaining({ method: "GET" }));
    controller.close();
  });
});
