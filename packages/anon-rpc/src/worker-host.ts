/**
 * Owns the worker's lifecycle.
 *
 *  - Boot has its own deadline (default 90 s), separate from request
 *    deadlines, which only start once a worker is ready.
 *  - A worker is replaced only when its boot fails or misses the deadline, or
 *    after `failureThreshold` consecutive requests failed on two fresh
 *    circuits each. A single request timeout never closes a worker.
 *  - On replacement the old worker keeps serving its in-flight requests and
 *    is closed once they drain (or after `drainMs`).
 *
 * One worker serves every chain: it is a Tor HTTP client and isolation comes
 * from per-identity keys, not from separate workers.
 */
import { AnonRpcError } from "./errors";
import type { WorkerFactory, WorkerLike } from "./types";

export type HostEvent =
  | { type: "boot-start"; generation: number; bootstrapBytes: number }
  | { type: "boot-ready"; generation: number; ms: number }
  | { type: "boot-failed"; generation: number; ms: number; code: string; message: string }
  | { type: "replace"; generation: number; reason: string }
  | { type: "closed"; generation: number };

export interface WorkerHostOptions {
  factory: WorkerFactory;
  /** Returns our own snapshot bytes, or undefined to let the worker fetch one. */
  bootstrapLoader?: () => Promise<Uint8Array | undefined>;
  bootDeadlineMs?: number;
  /** Boot attempts per acquire() before giving up. */
  maxBootAttempts?: number;
  /** Consecutive "failed on two fresh circuits" outcomes before replacing the worker. */
  failureThreshold?: number;
  drainMs?: number;
  /**
   * After a whole boot cycle failed (maxBootAttempts boots in a row), acquire()
   * fails immediately for this long instead of making every caller wait
   * through more boots. The next call after it re-boots.
   */
  coolDownMs?: number;
  onEvent?: (event: HostEvent) => void;
  now?: () => number;
}

interface Slot {
  worker: WorkerLike;
  generation: number;
  inflight: number;
  retired: boolean;
}

export interface Lease {
  worker: WorkerLike;
  generation: number;
  release(): void;
}

export class WorkerHost {
  readonly #opts: Required<Omit<WorkerHostOptions, "bootstrapLoader" | "onEvent">> &
    Pick<WorkerHostOptions, "bootstrapLoader" | "onEvent">;
  #generation = 0;
  #current: Promise<Slot> | undefined;
  #bootstrap: Promise<Uint8Array | undefined> | undefined;
  #consecutiveFailures = 0;
  #closed = false;
  #downUntil = 0;
  #downError: AnonRpcError | undefined;
  readonly stats = { boots: 0, bootFailures: 0, replacements: 0 };

  constructor(options: WorkerHostOptions) {
    this.#opts = {
      bootDeadlineMs: 90_000,
      maxBootAttempts: 2,
      failureThreshold: 3,
      drainMs: 35_000,
      coolDownMs: 30_000,
      now: () => performance.now(),
      ...options,
    };
  }

  /** Start booting now (call at app load). Idempotent. */
  start(): void {
    if (this.#closed) throw new AnonRpcError("host closed", "WORKER_CLOSED");
    if (!this.#current) this.#current = this.#boot();
  }

  /** Waits for a ready worker. Boot failures are retried up to maxBootAttempts. */
  async acquire(): Promise<Lease> {
    if (this.#downError && this.#opts.now() < this.#downUntil) throw this.#downError;
    let lastError: unknown;
    for (let attempt = 0; attempt < this.#opts.maxBootAttempts; attempt++) {
      this.start();
      const pending = this.#current!;
      try {
        const slot = await pending;
        if (slot.retired) continue; // replaced while we waited
        this.#downError = undefined;
        slot.inflight += 1;
        let released = false;
        return {
          worker: slot.worker,
          generation: slot.generation,
          release: () => {
            if (released) return;
            released = true;
            slot.inflight -= 1;
            if (slot.retired && slot.inflight === 0) this.#closeSlot(slot);
          },
        };
      } catch (error) {
        lastError = error;
        // Boot failed: drop it so the next attempt (here or in another caller) re-boots.
        if (this.#current === pending) this.#current = undefined;
      }
    }
    const error =
      lastError instanceof AnonRpcError ? lastError : new AnonRpcError("worker unavailable", "BOOT_FAILED", { cause: lastError });
    this.#downError = error;
    this.#downUntil = this.#opts.now() + this.#opts.coolDownMs;
    throw error;
  }

  /** A request succeeded on this worker generation. */
  reportSuccess(generation: number): void {
    if (generation === this.#generation) this.#consecutiveFailures = 0;
  }

  /** A request failed on two fresh circuits of this worker generation. */
  reportCircuitFailure(generation: number): void {
    if (generation !== this.#generation) return;
    this.#consecutiveFailures += 1;
    if (this.#consecutiveFailures >= this.#opts.failureThreshold) {
      this.#replace(`${this.#consecutiveFailures} requests failed on fresh circuits in a row`);
    }
  }

  get generation(): number {
    return this.#generation;
  }

  close(): void {
    this.#closed = true;
    const current = this.#current;
    this.#current = undefined;
    current?.then((slot) => this.#closeSlot(slot)).catch(() => undefined);
  }

  #replace(reason: string): void {
    const old = this.#current;
    this.#consecutiveFailures = 0;
    this.stats.replacements += 1;
    this.#opts.onEvent?.({ type: "replace", generation: this.#generation, reason });
    this.#current = this.#boot();
    old
      ?.then((slot) => {
        slot.retired = true;
        if (slot.inflight === 0) this.#closeSlot(slot);
        else setTimeout(() => this.#closeSlot(slot), this.#opts.drainMs);
      })
      .catch(() => undefined);
  }

  #closeSlot(slot: Slot): void {
    if ((slot as { closed?: boolean }).closed) return;
    (slot as { closed?: boolean }).closed = true;
    slot.retired = true;
    try {
      slot.worker.close();
    } catch {
      /* already closed */
    }
    this.#opts.onEvent?.({ type: "closed", generation: slot.generation });
  }

  #boot(): Promise<Slot> {
    const generation = ++this.#generation;
    const now = this.#opts.now;
    const started = now();
    this.stats.boots += 1;
    const promise = (async () => {
      // The snapshot is loaded once and reused by later boots.
      this.#bootstrap ??= (this.#opts.bootstrapLoader?.() ?? Promise.resolve(undefined)).catch(() => undefined);
      const bootstrap = await this.#bootstrap;
      this.#opts.onEvent?.({ type: "boot-start", generation, bootstrapBytes: bootstrap?.byteLength ?? 0 });
      const worker = this.#opts.factory(bootstrap ? { bootstrap } : {});
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          worker.ready,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new AnonRpcError(`worker not ready within ${this.#opts.bootDeadlineMs} ms`, "BOOT_TIMEOUT")),
              this.#opts.bootDeadlineMs,
            );
          }),
        ]);
      } catch (error) {
        try {
          worker.close();
        } catch {
          /* ignore */
        }
        this.stats.bootFailures += 1;
        const e =
          error instanceof AnonRpcError
            ? error
            : new AnonRpcError(`worker boot failed: ${(error as Error)?.message ?? error}`, "BOOT_FAILED", { cause: error });
        this.#opts.onEvent?.({ type: "boot-failed", generation, ms: now() - started, code: e.code, message: e.message });
        throw e;
      } finally {
        clearTimeout(timer);
      }
      this.#opts.onEvent?.({ type: "boot-ready", generation, ms: now() - started });
      return { worker, generation, inflight: 0, retired: false } satisfies Slot;
    })();
    promise.catch(() => undefined);
    return promise;
  }
}
