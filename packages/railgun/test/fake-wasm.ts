import type { Call, Hex, RailgunWasm, WasmChain, WasmPoiSession, WasmRailgunAddress, WasmShield } from "../src/wasm-types";

/** A fake of the wasm bindings that, like wasm-bindgen, throws on access while an async call holds the session. */
export function fakeWasm(opts: { syncDelayMs?: number } = {}) {
  const log: string[] = [];
  let freed = 0;
  const chain = (): WasmChain => ({
    free: () => void freed++,
    chainId: 11155111n,
    deploymentBlock: 5_000_000n,
    poiEndpoint: "https://ppoi.example/",
    poiStartBlock: 5_000_000n,
    railgunSmartWallet: "0xrail",
    subsquidEndpoint: "https://squid.example/graphql",
    unshieldFeeBps: 25,
    wrappedBaseToken: "0xweth",
  });
  const address = (text: string): WasmRailgunAddress => ({ free: () => void freed++, toString: () => text });

  class Session implements WasmPoiSession {
    #busy = false;
    #synced = 0n;
    readonly address = "0zk1fake";
    #guard() {
      if (this.#busy) throw new Error("recursive use of an object detected which would lead to unsafe aliasing in rust");
    }
    get syncedBlock() {
      this.#guard();
      return this.#synced;
    }
    async #hold<T>(fn: () => T): Promise<T> {
      this.#guard();
      this.#busy = true;
      try {
        await new Promise((r) => setTimeout(r, opts.syncDelayMs ?? 1));
        return fn();
      } finally {
        this.#busy = false;
      }
    }
    free() {
      freed++;
    }
    balancesJson() {
      return this.#hold(() => JSON.stringify([{ asset: "erc20:0xFFF9976782d46CC05630D1f6eBAb18b2324d6B14", amount: "100", poiStatus: "Valid" }, { asset: "erc721:0x0000000000000000000000000000000000000001/7", amount: "1", poiStatus: null }]));
    }
    notesJson() {
      return this.#hold(() => "[]");
    }
    checkpointJson() {
      this.#guard();
      return JSON.stringify({ synced: this.#synced.toString() });
    }
    poiPendingJson() {
      this.#guard();
      return "[]";
    }
    poiListKeysJson() {
      return "[]";
    }
    syncWithoutPoiSubmission() {
      return this.#hold(() => undefined);
    }
    syncToWithoutPoiSubmission(block: bigint) {
      log.push(`syncTo ${block}`);
      return this.#hold(() => {
        this.#synced = block;
      });
    }
    refreshPoi() {
      return this.#hold(() => undefined);
    }
    processPendingPoiJson() {
      return this.#hold(() => "{}");
    }
    prepareTransferUserOpJson(_r: WasmRailgunAddress, _t: string, amount: bigint) {
      return this.#hold(() => JSON.stringify({ signed: { amount: amount.toString() }, userOpHash: "0xabc" }));
    }
    prepareUnshieldUserOpJson(recipient: string, _t: string, amount: bigint, unwrap: boolean, tail: string) {
      return this.#hold(() => JSON.stringify({ signed: { amount: amount.toString(), recipient, unwrap, tail: JSON.parse(tail) }, userOpHash: "0xdef" }));
    }
  }

  class Shield implements WasmShield {
    items: string[] = [];
    constructor(_c: WasmChain) {}
    free() {
      freed++;
    }
    addErc20(_r: WasmRailgunAddress, token: Hex, amount: bigint) {
      this.items.push(`${token}:${amount}`);
    }
    addNative(_r: WasmRailgunAddress, amount: bigint) {
      this.items.push(`native:${amount}`);
    }
    build(): Call[] {
      return this.items.map((i) => ({ to: "0xrail", data: `0x${[...new TextEncoder().encode(i)].map((b) => b.toString(16).padStart(2, "0")).join("")}`, value: 0n }));
    }
  }

  const wasm: RailgunWasm = {
    Chain: { mainnet: chain, sepolia: chain, fromChainId: (id) => (id === 11155111n || id === 1n ? chain() : undefined) },
    RailgunAddress: {
      parse: (t) => {
        if (!t.startsWith("0zk")) throw new Error("invalid address");
        return address(t);
      },
      fromPrivateKeys: () => address("0zk1fake"),
    },
    Shield,
    PoiSession: {
      open: async (_c, _rpc, spending) => {
        if (!/^0x[0-9a-f]{64}$/.test(spending)) throw new Error("expected 32 bytes");
        return new Session();
      },
    },
  };
  return { wasm, log, freed: () => freed };
}
