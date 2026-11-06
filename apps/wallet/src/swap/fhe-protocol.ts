import type { Hex } from "viem";

export type WorkerCall =
  | { op: "init"; account: string; chainId: number }
  | { op: "encrypt"; contract: string; amount: string; direction?: 1 | 2; minimumOutput?: string }
  | { op: "prepare-decrypt"; contracts: string[] }
  | { op: "public-decrypt"; handles: Hex[] }
  | { op: "decrypt"; handles: Array<{ handle: Hex; contractAddress: string }>; signature: Hex };

export type ToFheWorker =
  | { type: "call"; id: number; call: WorkerCall }
  | { type: "rpc-result"; id: number; ok: true; value: unknown }
  | { type: "rpc-result"; id: number; ok: false; error: string }
  | { type: "fetch-result"; id: number; ok: true; status: number; statusText: string; headers: [string, string][]; body: ArrayBuffer | null; url: string }
  | { type: "fetch-result"; id: number; ok: false; error: string };

export type FromFheWorker =
  | { type: "result"; id: number; ok: true; value: unknown }
  | { type: "result"; id: number; ok: false; error: string }
  | { type: "rpc"; id: number; method: string; params: unknown[] }
  | { type: "fetch"; id: number; url: string; method: string; headers: [string, string][]; body: ArrayBuffer | null };

export interface EncryptedInput {
  handles: Hex[];
  proof: Hex;
}
