/**
 * Page side of the RAILGUN worker: typed calls, sync progress, and the fetch
 * bridge. Every request the worker makes is answered here through the RAILGUN
 * transport, i.e. over Anon-RPC; there is no other way out of the worker.
 */
import { createRailgunTransport, type RailgunTransport } from "@prawl/railgun";
import { anon } from "../lib/anon";
import type { Deployment, FromWorker, OpName, Ops, ProgressMessage, ToWorker } from "./protocol";

export const BUNDLER_HOSTS = ["public.pimlico.io"];

type Args<K extends OpName> = Parameters<Ops[K]>[0];
type Result<K extends OpName> = ReturnType<Ops[K]>;

export class RailgunController {
  readonly #worker: Worker;
  #seq = 0;
  readonly #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  readonly #progress = new Set<(p: ProgressMessage) => void>();
  #transport: RailgunTransport | undefined;

  constructor() {
    this.#worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "railgun" });
    this.#worker.onmessage = (ev: MessageEvent<FromWorker>) => void this.#onMessage(ev.data);
  }

  onProgress(fn: (p: ProgressMessage) => void): () => void {
    this.#progress.add(fn);
    return () => this.#progress.delete(fn);
  }

  call<K extends OpName>(op: K, args: Args<K>): Promise<Result<K>> {
    const id = ++this.#seq;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.#post({ t: "call", id, op, args });
    });
  }

  /** Set up the transport for a chain and account; returns the virtual RPC URL to open the wallet with. */
  async prepare(chainId: number, accountAddress?: string): Promise<{ deployment: Deployment; rpcUrl: string }> {
    const deployment = await this.call("deployment", chainId);
    this.#transport = createRailgunTransport({
      client: anon,
      chainId,
      subsquidEndpoint: deployment.subsquidEndpoint,
      poiEndpoint: deployment.poiEndpoint,
      bundlerHosts: BUNDLER_HOSTS,
      ...(accountAddress ? { accountAddress } : {}),
    });
    return { deployment, rpcUrl: this.#transport.rpcUrl };
  }

  /** Route RPC calls that name `address` (a one-time sender) to its own identity. */
  useAccount(address: string): void {
    if (!this.#transport) throw new Error("RAILGUN transport not prepared");
    this.#transport.addAccount(address);
  }

  #post(m: ToWorker, transfer: Transferable[] = []): void {
    this.#worker.postMessage(m, transfer);
  }

  async #onMessage(m: FromWorker): Promise<void> {
    switch (m.t) {
      case "result": {
        const p = this.#pending.get(m.id);
        if (!p) return;
        this.#pending.delete(m.id);
        if (m.ok) p.resolve(m.value);
        else p.reject(new Error(m.error));
        return;
      }
      case "progress":
        for (const fn of this.#progress) fn(m.progress);
        return;
      case "fetch": {
        try {
          if (!this.#transport) throw new Error("RAILGUN transport not prepared");
          const res = await this.#transport.fetch(m.url, {
            method: m.method,
            headers: m.headers,
            ...(m.body ? { body: m.body } : {}),
          });
          const body = res.body ? await res.arrayBuffer() : null;
          const headers: [string, string][] = [];
          res.headers.forEach((v, k) => headers.push([k, v]));
          this.#post(
            { t: "fetch-result", id: m.id, ok: true, status: res.status, statusText: res.statusText, headers, body, url: res.url || m.url },
            body ? [body] : [],
          );
        } catch (e) {
          this.#post({ t: "fetch-result", id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) });
        }
        return;
      }
    }
  }
}

let controller: RailgunController | undefined;
export function railgun(): RailgunController {
  controller ??= new RailgunController();
  return controller;
}
