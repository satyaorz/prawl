/**
 * Real worker factory (browser only): @anon-rpc/browser-harness with a
 * hash-pinned tor-js bundle from our own origin. Which bundle is a config
 * choice (`worker`: "stock", "fork", "fork-cap4" or `{ hash }`, see
 * worker-choice.ts). The two specifier reads are answered locally for the
 * chosen hash with only our bundle URL listed, so no resolver, CDN or
 * bootstrap RPC is contacted (same approach as wabl's pinned-specifier.ts).
 */
import { AnonRpcWorker } from "@anon-rpc/browser-harness";
import type { WorkerFactory, WorkerLike } from "./types";
import { pinnedSpecifier, resolveWorker, SPECIFIER_ADDRESS, WORKER_BUILDS, type ResolvedWorker, type WorkerChoice } from "./worker-choice";

export { pinnedSpecifier, resolveWorker, SPECIFIER_ADDRESS, WORKER_BUILDS, type WorkerChoice } from "./worker-choice";
/** The stock worker's hash (kept for existing imports). */
export const WORKER_HASH = WORKER_BUILDS.stock.hash;
export const DEMO_GATEWAY = "152.236.3.22:12298:uEiCH0VdbhryzJcMtCfB0vLA4sOvHdQ4hq5w7CopcwU59bQ";

export interface HarnessFactoryOptions {
  gateway?: string;
  /** Which worker build to boot. Default "stock". */
  worker?: WorkerChoice;
  /** Origin that serves `/anon-rpc/worker-0x<hash>.js`. Default: this page's origin. */
  origin?: string;
  /** Worker log level passed in the worker config (e.g. "debug"); default is the worker's own. */
  logLevel?: string;
  /** Receives worker log lines (boot phases). */
  onLog?: (entry: { level: string; message: string }) => void;
}

export function harnessWorkerFactory(options: HarnessFactoryOptions): WorkerFactory & { resolved: ResolvedWorker } {
  const resolved = resolveWorker(options.worker, options.origin ?? location.origin);
  const factory: WorkerFactory = ({ bootstrap }) => {
    const config: Record<string, unknown> = {};
    if (options.gateway) config.gateways = [options.gateway];
    if (bootstrap) config.bootstrap = bootstrap;
    if (options.logLevel) config.logLevel = options.logLevel;
    const worker = new AnonRpcWorker({
      address: SPECIFIER_ADDRESS,
      config,
      preExisting: { rpcProvider: pinnedSpecifier(resolved.bundleUrl, resolved.hash) },
    } as never);
    if (options.onLog) {
      const onLog = options.onLog;
      void (async () => {
        for (;;) {
          try {
            const e = (await worker.acceptLog()) as { level?: string; args?: unknown[] };
            const message = (e.args ?? []).map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
            onLog({ level: String(e.level ?? "info"), message: message.slice(0, 400) });
          } catch {
            return;
          }
        }
      })();
    }
    return worker as unknown as WorkerLike;
  };
  return Object.assign(factory, { resolved });
}
