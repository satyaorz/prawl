import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeFunctionResult, parseAbi, toFunctionSelector, type Address, type Hex } from "viem";
import type { AnonRpcClient } from "@prawl/anon-rpc";
import type { SwapDeployment } from "../src/swap/deployment";

const mocks = vi.hoisted(() => ({
  verify: vi.fn(async () => {}),
  encrypt: vi.fn(async (_contract: string, _amount: bigint, direction?: number) => ({
    handles: direction ? [`0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`, `0x${"33".repeat(32)}`] : [`0x${"11".repeat(32)}`], proof: "0x1234",
  })),
  prepare: vi.fn(async () => ({})),
  decrypt: vi.fn(async (handles: Array<{ handle: string }>) => Object.fromEntries(handles.map(({ handle }) => [handle, 20n]))),
  close: vi.fn(),
}));
vi.mock("../src/swap/deployment", () => ({ verifySwapDeployment: mocks.verify }));
vi.mock("../src/swap/fhe-controller", () => ({ FheController: { open: async () => ({ encrypt: mocks.encrypt, prepareDecrypt: mocks.prepare, decrypt: mocks.decrypt, close: mocks.close }) } }));

const address = (i: number) => `0x${i.toString(16).padStart(40, "0")}` as Address;
const account = address(1), batch = address(2), tokenA = address(3), tokenB = address(4), wrapperA = address(5), wrapperB = address(6), oracle = address(7);
const config = { chainId: 11155111, batch, tokenA, tokenB, wrapperA, wrapperB, oracle } as SwapDeployment;
const handle = (i: number) => `0x${i.toString(16).padStart(64, "0")}` as Hex;
const abi = parseAbi([
  "function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)",
  "function confidentialBalanceOf(address) view returns (bytes32)", "function fundedBalance(address,uint8) view returns (bytes32)",
  "function currentRound() view returns (uint256)", "function distinctSubmitters() view returns (uint256)",
  "function lastUpdateTime() view returns (uint256)", "function minRoundDuration() view returns (uint256)", "function maxPriceAge() view returns (uint256)",
  "function minDistinctSubmitters() view returns (uint256)", "function refundDelay() view returns (uint256)",
  "function closedAt(uint256) view returns (uint256)", "function refundable(uint256) view returns (bool)",
  "function orderStatus(uint256,address) view returns (bool,bool,bool)",
  "function rounds(uint256) view returns (bytes32,bytes32,bytes32,bytes32,bool,bool,bool,uint64,uint8,uint256,bytes32,uint64)",
  "function roundPrices(uint256) view returns (uint64,uint64,uint64,uint256)",
  "function latestLotPrice() view returns (uint64,uint64,uint256)",
]);
const callAbi = parseAbi(["function approve(address,uint256) returns (bool)", "function wrap(address,uint256)", "function submitOrder(bytes32,bytes,bytes32,bytes,bytes32,bytes)"]);

interface ChainState {
  stale?: boolean;
  order?: [boolean, boolean, boolean];
  rounds?: [boolean, boolean, boolean];
  refundable?: boolean;
  closedAt?: bigint;
  blockTime?: bigint;
  lastUpdate?: bigint;
}

const flags = (rounds: [boolean, boolean, boolean]) => [handle(0), handle(0), handle(0), handle(0), ...rounds, 0n, 0, 0n, handle(0), 0n] as const;

function client(state: ChainState | boolean = {}): AnonRpcClient {
  const s: ChainState = typeof state === "boolean" ? { stale: state } : state;
  const stale = s.stale ?? false;
  return {
    identities: { account: () => ({ key: "account" }) },
    read: async (_id: unknown, _chain: number, method: string, params: unknown[]) => {
      if (method === "eth_getBlockByNumber") return { timestamp: `0x${(s.blockTime ?? 1000n).toString(16)}` };
      const { to, data } = params[0] as { to: string; data: string };
      const sel = data.slice(0, 10);
      if (sel === toFunctionSelector("balanceOf(address)")) return encodeFunctionResult({ abi, functionName: "balanceOf", result: 100n * 10n ** 12n });
      if (sel === toFunctionSelector("allowance(address,address)")) return encodeFunctionResult({ abi, functionName: "allowance", result: 0n });
      if (sel === toFunctionSelector("confidentialBalanceOf(address)")) return encodeFunctionResult({ abi, functionName: "confidentialBalanceOf", result: handle(to === wrapperA ? 1 : 2) });
      if (sel === toFunctionSelector("fundedBalance(address,uint8)")) return encodeFunctionResult({ abi, functionName: "fundedBalance", result: handle(3) });
      if (sel === toFunctionSelector("currentRound()")) return encodeFunctionResult({ abi, functionName: "currentRound", result: 1n });
      if (sel === toFunctionSelector("distinctSubmitters()")) return encodeFunctionResult({ abi, functionName: "distinctSubmitters", result: 1n });
      if (sel === toFunctionSelector("lastUpdateTime()")) return encodeFunctionResult({ abi, functionName: "lastUpdateTime", result: s.lastUpdate ?? 950n });
      if (sel === toFunctionSelector("minRoundDuration()")) return encodeFunctionResult({ abi, functionName: "minRoundDuration", result: 60n });
      if (sel === toFunctionSelector("minDistinctSubmitters()")) return encodeFunctionResult({ abi, functionName: "minDistinctSubmitters", result: 2n });
      if (sel === toFunctionSelector("refundDelay()")) return encodeFunctionResult({ abi, functionName: "refundDelay", result: 3600n });
      if (sel === toFunctionSelector("closedAt(uint256)")) return encodeFunctionResult({ abi, functionName: "closedAt", result: s.closedAt ?? 0n });
      if (sel === toFunctionSelector("refundable(uint256)")) return encodeFunctionResult({ abi, functionName: "refundable", result: s.refundable ?? false });
      if (sel === toFunctionSelector("orderStatus(uint256,address)")) return encodeFunctionResult({ abi, functionName: "orderStatus", result: s.order ?? [true, false, false] });
      if (sel === toFunctionSelector("rounds(uint256)")) return encodeFunctionResult({ abi, functionName: "rounds", result: flags(s.rounds ?? [true, false, false]) });
      if (sel === toFunctionSelector("maxPriceAge()")) return encodeFunctionResult({ abi, functionName: "maxPriceAge", result: 1000n });
      if (sel === toFunctionSelector("roundPrices(uint256)")) return encodeFunctionResult({ abi, functionName: "roundPrices", result: [2n, 5n, 100n, stale ? 900n : 1500n] });
      throw new Error(`unexpected call ${sel}`);
    },
  } as unknown as AnonRpcClient;
}

function signer() {
  return {
    signDecrypt: vi.fn(async () => "0x1234" as Hex),
    send: vi.fn(async (calls: readonly unknown[]) => calls.map(() => ({ hash: handle(9), status: "success" as const, blockNumber: 1n, gasUsed: 1n }))),
  };
}

describe("swap service", () => {
  it("constructs exact ERC-20 approval and wrapper calls", async () => {
    const { SwapService } = await import("../src/swap/service");
    const sign = signer();
    const service = await SwapService.open(client(), account, config, sign);
    await service.wrap(0, 10n);
    const calls = sign.send.mock.calls[0]![0] as Array<{ to: Address; data: Hex }>;
    expect(calls.map((call) => call.to)).toEqual([tokenA, wrapperA]);
    expect(decodeFunctionData({ abi: callAbi, data: calls[0]!.data }).args).toEqual([wrapperA, 10n * 10n ** 12n]);
    expect(decodeFunctionData({ abi: callAbi, data: calls[1]!.data }).args).toEqual([account, 10n * 10n ** 12n]);
    service.close();
  });

  it("encrypts direction, amount and minimum for a valid whole-lot order", async () => {
    const { SwapService } = await import("../src/swap/service");
    const sign = signer();
    const service = await SwapService.open(client(), account, config, sign);
    await service.order(1, 10n, 22n);
    expect(mocks.encrypt).toHaveBeenCalledWith(batch, 10n, 1, 22n);
    const calls = sign.send.mock.calls[0]![0] as Array<{ to: Address; data: Hex }>;
    expect(calls[0]!.to).toBe(batch);
    expect(decodeFunctionData({ abi: callAbi, data: calls[0]!.data }).functionName).toBe("submitOrder");
    service.close();
  });

  it("refuses stale prices and unaffordable minimums before encrypting or sending", async () => {
    const { SwapService } = await import("../src/swap/service");
    mocks.encrypt.mockClear();
    const sign = signer();
    const service = await SwapService.open(client(true), account, config, sign);
    await expect(service.order(1, 10n, 22n)).rejects.toThrow("expired");
    expect(mocks.encrypt).not.toHaveBeenCalled();
    expect(sign.send).not.toHaveBeenCalled();
    service.close();
  });

  it("reports the order's public lifecycle without decrypting it", async () => {
    const { SwapService } = await import("../src/swap/service");
    const cases: Array<[ChainState, string]> = [
      [{ order: [false, false, false] }, "none"],
      [{ order: [true, false, false], blockTime: 950n, lastUpdate: 950n, rounds: [false, false, false] }, "open"],
      [{ order: [true, false, false], rounds: [true, false, false], blockTime: 2000n, closedAt: 1000n }, "awaiting-settlement"],
      [{ order: [true, false, false], rounds: [true, false, true], blockTime: 2000n, closedAt: 1000n }, "awaiting-settlement"],
      [{ order: [true, false, false], refundable: true }, "refundable"],
      [{ order: [true, false, false], rounds: [true, true, false], blockTime: 99_999n, closedAt: 1000n }, "refundable"],
      [{ order: [true, true, false] }, "settled"],
      [{ order: [true, false, true] }, "refunded"],
    ];
    for (const [state, phase] of cases) {
      const service = await SwapService.open(client(state), account, config, signer());
      const status = await service.orderStatus();
      expect(status.phase, `${phase}`).toBe(phase);
      expect(status.detail.length).toBeGreaterThan(10);
      expect(status.canOrder).toBe(phase === "open" || phase === "none");
      expect(status.canRefund).toBe(phase === "refundable");
      service.close();
    }
  });

  it("counts down to a close time that is still in the future", async () => {
    const { SwapService } = await import("../src/swap/service");
    const service = await SwapService.open(client({ order: [true, false, false], lastUpdate: 1000n, blockTime: 1010n, rounds: [false, false, false] }), account, config, signer());
    const status = await service.orderStatus();
    expect(status.phase).toBe("open");
    expect(status.closesIn).toBe(50n); // lastUpdate 1000 + duration 60 - now 1010
    service.close();
  });

  it("refuses a refund before the round is refundable", async () => {
    const { SwapService } = await import("../src/swap/service");
    const sign = signer();
    const service = await SwapService.open(client({ order: [true, false, false], rounds: [false, false, false] }), account, config, sign);
    await expect(service.refund(1n)).rejects.toThrow("can close in");
    expect(sign.send).not.toHaveBeenCalled();
    service.close();
  });
});
