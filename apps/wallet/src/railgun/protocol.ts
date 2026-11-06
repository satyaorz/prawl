/** Messages between the wallet page and the RAILGUN worker. */
import type { Balance, Call, Hex, Note, PoiReport, PreparedUserOp, SyncProgress } from "@prawl/railgun";

export interface Deployment {
  chainId: number;
  deploymentBlock: string;
  smartWallet: string;
  wrappedBaseToken: string;
  unshieldFeeBps: number;
  subsquidEndpoint: string;
  poiEndpoint: string;
}

export interface OpenArgs {
  chainId: number;
  rpcUrl: string;
  spendingKey: Hex;
  viewingKey: Hex;
  /** Non-extractable AES-GCM key; the worker seals checkpoints with it. */
  storageKey: CryptoKey;
  /** Record name the sealed checkpoint is stored under. */
  checkpointName: string;
  /**
   * True only for a wallet created just now: it cannot own notes from before
   * it existed, so with no saved checkpoint it may start from our public pool
   * snapshot instead of replaying all history. Never for a restored wallet.
   */
  fresh: boolean;
  /**
   * When the wallet was created (unix seconds, from the passkey). A restore
   * starts from the pool snapshot and replays only from a block before this.
   */
  bornAt?: number;
  /** Drop the saved checkpoint and scan all history again. */
  discardCheckpoint?: boolean;
}

export interface Ops {
  deployment(chainId: number): Deployment;
  open(args: OpenArgs): { address: string; syncedBlock: string; restored: boolean; snapshotBlock?: string; fullScan: boolean; replayFrom?: string };
  sync(args: { head: string; windowBlocks?: string }): { syncedBlock: string };
  refreshPoi(): void;
  /** Number of our own operations whose PPOI proofs are not submitted yet. */
  poiPendingCount(): number;
  /** Prove and submit queued PPOI proofs (after a private send or unshield lands). */
  processPendingPoi(): PoiReport;
  balances(): Balance[];
  notes(): Note[];
  buildShield(args: { recipient: string; items: Array<{ token: "native" | Hex; amount: string }> }): Call[];
  prepareTransfer(args: { recipient: string; token: Hex; amount: string; memo?: string; accountPrivateKey: Hex; bundlerUrl: string }): PreparedUserOp;
  prepareUnshield(args: { recipient: Hex; token: Hex; amount: string; unwrapNative?: boolean; accountPrivateKey: Hex; bundlerUrl: string }): PreparedUserOp;
  close(): void;
}

export type OpName = keyof Ops;

export type ToWorker =
  | { t: "call"; id: number; op: OpName; args: unknown }
  | { t: "fetch-result"; id: number; ok: true; status: number; statusText: string; headers: [string, string][]; body: ArrayBuffer | null; url: string }
  | { t: "fetch-result"; id: number; ok: false; error: string };

export type FromWorker =
  | { t: "result"; id: number; ok: true; value: unknown }
  | { t: "result"; id: number; ok: false; error: string }
  | { t: "progress"; progress: { from: string; to: string; synced: string; head: string; ms: number } }
  | { t: "fetch"; id: number; url: string; method: string; headers: [string, string][]; body: ArrayBuffer | null };

export type ProgressMessage = Extract<FromWorker, { t: "progress" }>["progress"];
export type { PoiReport, SyncProgress };
