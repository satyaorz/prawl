/**
 * The wallet's single Anon-RPC client. Every chain read and write in the app
 * goes through it, over Tor, on a circuit chosen by the identity it names.
 *
 * Boot: our own Tor snapshot from /tor/bootstrap.zip.zst, the keep-alive
 * worker build (fork-v3) from our own origin, and a gateway chosen in this
 * order: one the user confirmed from a `?gateway=` link (remembered in this
 * browser), the build's VITE_PRAWL_GATEWAY (our own, when gateway/start.sh
 * has run), else the public demo one.
 */
import { AnonRpcClient, WorkerHost, loadOwnBootstrap, SEPOLIA, type HostEvent, type Trace, type WorkerChoice } from "@prawl/anon-rpc";
import { DEMO_GATEWAY, harnessWorkerFactory } from "@prawl/anon-rpc/harness-worker";

export type TorPhase = "idle" | "booting" | "ready" | "failed";

export interface TorStatus {
  phase: TorPhase;
  gateway: string;
  ownGateway: boolean;
  /** Picked by the user from a ?gateway= link rather than built in. */
  chosenGateway: boolean;
  worker: string;
  bootMs?: number;
  bootstrapBytes?: number;
  error?: string;
  generation: number;
  traces: Trace[];
}

const MAX_TRACES = 200;
const env = import.meta.env as Record<string, string | undefined>;
const GATEWAY_KEY = "prawl:gateway";
/** tor-js gateway address: IPv4, port, then the multihash of its certificate. */
export const GATEWAY_RE = /^(\d{1,3}\.){3}\d{1,3}:\d{1,5}:[A-Za-z0-9_-]{20,}$/;
const buildGateway = env.VITE_PRAWL_GATEWAY || DEMO_GATEWAY;

/**
 * A gateway sees the user's IP address (never what goes over Tor), so a link
 * can only propose one: the user must confirm it. `?gateway=default` forgets
 * the choice. The query is removed from the address bar either way.
 */
function chooseGateway(): string {
  if (typeof window === "undefined") return buildGateway;
  try {
    const url = new URL(window.location.href);
    const proposed = url.searchParams.get("gateway");
    if (proposed !== null) {
      if (proposed === "" || proposed === "default") window.localStorage.removeItem(GATEWAY_KEY);
      else if (
        GATEWAY_RE.test(proposed) &&
        window.confirm(
          `Connect to Tor through the gateway ${proposed}?\n\nA gateway sees your IP address, not what you do over Tor. Only accept a gateway you run or trust.`,
        )
      )
        window.localStorage.setItem(GATEWAY_KEY, proposed);
      url.searchParams.delete("gateway");
      window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    }
    const saved = window.localStorage.getItem(GATEWAY_KEY);
    if (saved && GATEWAY_RE.test(saved)) return saved;
  } catch {
    // Storage blocked: use the build's gateway.
  }
  return buildGateway;
}

const gateway = chooseGateway();
const worker = (env.VITE_PRAWL_WORKER as WorkerChoice | undefined) ?? "fork-v3";

let status: TorStatus = {
  phase: "idle",
  gateway,
  ownGateway: gateway !== DEMO_GATEWAY,
  chosenGateway: gateway !== buildGateway,
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

/** HTTPS hosts the wallet may reach (besides JSON-RPC providers): RAILGUN's indexer, PPOI node, circuit artifacts, bundler. */
export const HTTP_HOSTS = [
  "rail-squid.squids.live",
  "ppoi.fdi.network",
  "raw.githubusercontent.com",
  "ipfs-lb.com",
  "public.pimlico.io",
];

export const anon = new AnonRpcClient({
  host,
  onTrace,
  prewarmChainId: SEPOLIA,
  httpHosts: HTTP_HOSTS,
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
