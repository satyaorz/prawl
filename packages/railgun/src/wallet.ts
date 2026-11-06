/**
 * One user's RAILGUN wallet on one chain. Wraps kohaku-railgun-wasm's
 * PoiSession: queued access, windowed sync with progress, and a checkpoint
 * handed to the caller after every successful step (the caller encrypts it;
 * it holds private wallet data).
 */
import { Serial } from "./serial";
import type { Call, Hex, RailgunWasm, WasmChain, WasmPoiSession } from "./wasm-types";

export interface Balance {
  /** Token address (lower-case hex), as the core prints it. */
  asset: string;
  /** Decimal string, base units. */
  amount: string;
  /** PPOI status for this amount, e.g. "Valid", "ShieldPending"; null when unknown. */
  poiStatus: string | null;
}

export interface Note extends Balance {
  treeNumber: number;
  leafIndex: number;
  blindedCommitment: string;
  commitmentType: string;
  memo: string;
}

export interface SyncProgress {
  from: bigint;
  to: bigint;
  synced: bigint;
  head: bigint;
  ms: number;
}

export interface OpenOptions {
  wasm: RailgunWasm;
  chainId: number;
  /** URL the core's JSON-RPC provider calls; Prawl passes a virtual URL bridged to Anon-RPC. */
  rpcUrl: string;
  spendingKey: Hex;
  viewingKey: Hex;
  /** Decrypted checkpoint from an earlier session, or undefined for a fresh wallet. */
  checkpoint?: string;
  /** Mirror for circuit artifacts (default: the core's pinned GitHub URL). */
  artifactBaseUrl?: string;
}

export interface SyncOptions {
  /** Target block; usually the chain head. */
  head: bigint;
  /** Blocks per window (default 1,000,000). */
  windowBlocks?: bigint;
  onProgress?: (p: SyncProgress) => void;
  /** Called with the plaintext checkpoint after each window. Encrypt before storing. */
  onCheckpoint?: (checkpoint: string) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface PreparedUserOp {
  signed: unknown;
  userOpHash: Hex;
}

function chainFor(wasm: RailgunWasm, chainId: number): WasmChain {
  const chain = wasm.Chain.fromChainId(BigInt(chainId));
  if (!chain) throw new Error(`RAILGUN has no deployment for chain ${chainId}`);
  return chain;
}

export class RailgunWallet {
  readonly address: string;
  readonly chainId: number;
  readonly #wasm: RailgunWasm;
  readonly #chain: WasmChain;
  readonly #session: WasmPoiSession;
  readonly #serial = new Serial();
  #syncedBlock: bigint;
  #closed = false;

  private constructor(wasm: RailgunWasm, chainId: number, chain: WasmChain, session: WasmPoiSession) {
    this.#wasm = wasm;
    this.chainId = chainId;
    this.#chain = chain;
    this.#session = session;
    this.address = session.address;
    this.#syncedBlock = session.syncedBlock;
  }

  static async open(opts: OpenOptions): Promise<RailgunWallet> {
    const chain = chainFor(opts.wasm, opts.chainId);
    try {
      const session = await opts.wasm.PoiSession.open(
        chain,
        opts.rpcUrl,
        opts.spendingKey,
        opts.viewingKey,
        opts.checkpoint ?? null,
        opts.artifactBaseUrl ?? null,
      );
      return new RailgunWallet(opts.wasm, opts.chainId, chain, session);
    } catch (e) {
      chain.free();
      throw e;
    }
  }

  /** Public deployment facts for this chain. */
  get deployment() {
    const c = this.#chain;
    return {
      deploymentBlock: c.deploymentBlock,
      poiStartBlock: c.poiStartBlock,
      smartWallet: c.railgunSmartWallet,
      wrappedBaseToken: c.wrappedBaseToken,
      unshieldFeeBps: c.unshieldFeeBps,
      subsquidEndpoint: c.subsquidEndpoint,
      poiEndpoint: c.poiEndpoint,
    };
  }

  /** Last block synced, as of the last finished call (never touches the session mid-call). */
  get syncedBlock(): bigint {
    return this.#syncedBlock;
  }

  #run<T>(job: (s: WasmPoiSession) => Promise<T> | T): Promise<T> {
    return this.#serial.run(() => {
      if (this.#closed) throw new Error("RAILGUN wallet is closed");
      return job(this.#session);
    });
  }

  /** Sync in windows up to `head`, reporting progress and checkpoints between windows. */
  async sync(opts: SyncOptions): Promise<void> {
    const step = opts.windowBlocks ?? 1_000_000n;
    if (step <= 0n) throw new Error("windowBlocks must be positive");
    const start = this.#syncedBlock > 0n ? this.#syncedBlock : this.#chain.deploymentBlock;
    let from = start;
    while (from < opts.head) {
      if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("aborted");
      const to = from + step < opts.head ? from + step : opts.head;
      const t0 = performance.now();
      const checkpoint = await this.#run(async (s) => {
        await s.syncToWithoutPoiSubmission(to);
        this.#syncedBlock = s.syncedBlock;
        return opts.onCheckpoint ? s.checkpointJson() : undefined;
      });
      if (checkpoint !== undefined) await opts.onCheckpoint?.(checkpoint);
      opts.onProgress?.({ from, to, synced: this.#syncedBlock, head: opts.head, ms: performance.now() - t0 });
      from = to;
    }
  }

  /** Refresh PPOI lists and TXIDs (after a sync, before trusting a status). */
  refreshPoi(): Promise<void> {
    return this.#run((s) => s.refreshPoi());
  }

  async balances(): Promise<Balance[]> {
    const raw = await this.#run((s) => s.balancesJson());
    return (JSON.parse(raw) as Array<{ asset: string; amount: string; poiStatus?: string | null }>).map((b) => ({
      asset: b.asset,
      amount: b.amount,
      poiStatus: b.poiStatus ?? null,
    }));
  }

  async notes(): Promise<Note[]> {
    const raw = await this.#run((s) => s.notesJson());
    return (JSON.parse(raw) as Note[]).map((n) => ({ ...n, poiStatus: n.poiStatus ?? null }));
  }

  checkpoint(): Promise<string> {
    return this.#run((s) => s.checkpointJson());
  }

  async poiPending(): Promise<unknown[]> {
    return JSON.parse(await this.#run((s) => s.poiPendingJson())) as unknown[];
  }

  /** Generate and submit queued PPOI proofs. Submission is not acceptance; refresh before showing Valid. */
  async processPendingPoi(): Promise<unknown> {
    return JSON.parse(await this.#run((s) => s.processPendingPoiJson()));
  }

  /** Unsigned shield transactions into `recipient` (a 0zk address). The caller signs and sends them. */
  buildShield(recipient: string, items: ReadonlyArray<{ token: "native" | Hex; amount: bigint }>): Call[] {
    if (items.length === 0) throw new Error("nothing to shield");
    const addr = this.#wasm.RailgunAddress.parse(recipient);
    const shield = new this.#wasm.Shield(this.#chain);
    let consumed = false;
    try {
      for (const item of items) {
        if (item.amount <= 0n) throw new Error("shield amount must be positive");
        if (item.token === "native") shield.addNative(addr, item.amount);
        else shield.addErc20(addr, item.token, item.amount);
      }
      consumed = true; // build() takes ownership even when it throws
      return shield.build();
    } finally {
      if (!consumed) shield.free();
      addr.free();
    }
  }

  /** Prove a private transfer and return a signed, paymaster-sponsored UserOperation (not sent). */
  async prepareTransfer(args: {
    recipient: string;
    token: Hex;
    amount: bigint;
    memo?: string;
    accountPrivateKey: Hex;
    bundlerUrl: string;
  }): Promise<PreparedUserOp> {
    const raw = await this.#run(async (s) => {
      const to = this.#wasm.RailgunAddress.parse(args.recipient);
      try {
        return await s.prepareTransferUserOpJson(to, args.token, args.amount, args.memo ?? "", args.accountPrivateKey, args.bundlerUrl);
      } finally {
        to.free();
      }
    });
    return JSON.parse(raw) as PreparedUserOp;
  }

  /** Prove an unshield to a public address and return a signed UserOperation (not sent). */
  async prepareUnshield(args: {
    recipient: Hex;
    token: Hex;
    amount: bigint;
    unwrapNative?: boolean;
    accountPrivateKey: Hex;
    bundlerUrl: string;
  }): Promise<PreparedUserOp> {
    const raw = await this.#run((s) =>
      s.prepareUnshieldUserOpJson(args.recipient, args.token, args.amount, args.unwrapNative ?? false, "[]", args.accountPrivateKey, args.bundlerUrl),
    );
    return JSON.parse(raw) as PreparedUserOp;
  }

  async close(): Promise<void> {
    await this.#serial.run(() => {
      if (this.#closed) return;
      this.#closed = true;
      this.#session.free();
      this.#chain.free();
    });
  }
}
