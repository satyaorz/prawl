/**
 * The wallet's single Anon-RPC client. Every chain read and write in the app
 * goes through it, over Tor, on a circuit chosen by the identity it names.
 *
 * Boot: our own Tor snapshot from /tor/bootstrap.zip.zst, the keep-alive
 * worker build (fork-v3) from our own origin, and our own gateway when
 * gateway/start.sh has run (VITE_PRAWL_GATEWAY), else the public demo one.
 */
import { AnonRpcClient, WorkerHost, loadOwnBootstrap, SEPOLIA, type HostEvent, type Trace, type WorkerChoice } from "@prawl/anon-rpc";
import { DEMO_GATEWAY, harnessWorkerFactory } from "@prawl/anon-rpc/harness-worker";

export type TorPhase = "idle" | "booting" | "ready" | "failed";

export interface TorStatus {
  phase: TorPhase;
  gateway: string;
  ownGateway: boolean;
  worker: string;
  bootMs?: number;
  bootstrapBytes?: number;
  error?: string;
  generation: number;
  traces: Trace[];
}

const MAX_TRACES = 200;
const env = import.meta.env as Record<string, string | undefined>;
const gateway = env.VITE_PRAWL_GATEWAY || DEMO_GATEWAY;
const worker = (env.VITE_PRAWL_WORKER as WorkerChoice | undefined) ?? "fork-v3";

let status: TorStatus = {
  phase: "idle",
  gateway,
  ownGateway: gateway !== DEMO_GATEWAY,
  worker: typeof worker === "string" ? worker : "custom",
  generation: 0,
  traces: [],
};
const listeners = new Set<() => void>();

function update(patch: Partial<TorStatus>): void {
  status = { ...status, ...patch };
  for (const l of listeners) l();
}

function onEvent(e: HostEvent): void {
  switch (e.type) {
    case "boot-start":
      update({ phase: "booting", generation: e.generation, bootstrapBytes: e.bootstrapBytes, error: undefined });
      break;
    case "boot-ready":
      update({ phase: "ready", generation: e.generation, bootMs: e.ms });
      break;
    case "boot-failed":
      update({ phase: "failed", generation: e.generation, error: `${e.code}: ${e.message}` });
      break;
    default:
      break;
  }
}

function onTrace(t: Trace): void {
  const traces = status.traces.length >= MAX_TRACES ? status.traces.slice(1) : status.traces.slice();
  traces.push(t);
  update({ traces });
}

const host = new WorkerHost({
  factory: harnessWorkerFactory({ gateway, worker }),
  bootstrapLoader: () => loadOwnBootstrap(),
  onEvent,
});

export const anon = new AnonRpcClient({
  host,
  onTrace,
  prewarmChainId: SEPOLIA,
  httpHosts: [],
});

export const torStatus = {
  get: (): TorStatus => status,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

let started = false;
export function startTor(): void {
  if (started) return;
  started = true;
  update({ phase: "booting" });
  anon.start();
}
