/**
 * Bounded scheduler: at most `perIdentity` logical requests in flight per
 * identity and `global` in total. When the next task to start belongs to a
 * different identity than the last one started, it waits a small random
 * delay, so identity B's first stream does not start in the same instant
 * identity A's ends.
 *
 * Measured data (one key, 32 in flight, 96/96 OK) says one key is not the
 * bottleneck, so the defaults (4 per identity, 12 overall) are a ceiling for
 * the gateway's sake, not a throttle.
 *
 * A logical request holds its slot through its retry and failover attempts,
 * so the real number of streams never exceeds the limits.
 */
export interface SchedulerOptions {
  perIdentity?: number;
  global?: number;
  /** Random delay range in ms applied when the started identity changes. [0, 0] disables. */
  switchJitterMs?: readonly [number, number];
  random?: () => number;
}

interface Task {
  identity: string;
  run: () => void;
  jitterPaid: boolean;
}

export interface SchedulerStats {
  active: number;
  queued: number;
  maxActive: number;
  maxActivePerIdentity: number;
  identitySwitches: number;
}

export class Scheduler {
  readonly #perIdentity: number;
  readonly #global: number;
  readonly #jitter: readonly [number, number];
  readonly #random: () => number;
  readonly #queue: Task[] = [];
  readonly #active = new Map<string, number>();
  #total = 0;
  #lastIdentity: string | undefined;
  #waiting = false;
  readonly stats: SchedulerStats = {
    active: 0,
    queued: 0,
    maxActive: 0,
    maxActivePerIdentity: 0,
    identitySwitches: 0,
  };

  constructor(options: SchedulerOptions = {}) {
    this.#perIdentity = options.perIdentity ?? 4;
    this.#global = options.global ?? 12;
    this.#jitter = options.switchJitterMs ?? [15, 120];
    this.#random = options.random ?? Math.random;
    if (this.#perIdentity < 1 || this.#global < 1) throw new Error("scheduler limits must be >= 1");
  }

  run<T>(identity: string, fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const task: Task = {
        identity,
        jitterPaid: false,
        run: () => {
          let p: Promise<T>;
          try {
            p = fn();
          } catch (e) {
            p = Promise.reject(e);
          }
          p.then(resolve, reject).finally(() => this.#done(identity));
        },
      };
      this.#queue.push(task);
      this.stats.queued = this.#queue.length;
      this.#pump();
    });
  }

  #done(identity: string): void {
    const n = (this.#active.get(identity) ?? 1) - 1;
    if (n <= 0) this.#active.delete(identity);
    else this.#active.set(identity, n);
    this.#total -= 1;
    this.stats.active = this.#total;
    this.#pump();
  }

  #pump(): void {
    if (this.#waiting) return;
    while (this.#total < this.#global) {
      const index = this.#queue.findIndex(
        (t) => (this.#active.get(t.identity) ?? 0) < this.#perIdentity,
      );
      if (index === -1) return;
      const task = this.#queue[index]!;
      const switching = this.#lastIdentity !== undefined && task.identity !== this.#lastIdentity;
      if (switching && !task.jitterPaid) {
        const [lo, hi] = this.#jitter;
        const delay = lo + (hi - lo) * this.#random();
        if (delay > 0) {
          this.#waiting = true;
          setTimeout(() => {
            task.jitterPaid = true;
            this.#waiting = false;
            this.#pump();
          }, delay);
          return;
        }
      }
      this.#queue.splice(index, 1);
      if (switching) this.stats.identitySwitches += 1;
      this.#lastIdentity = task.identity;
      const n = (this.#active.get(task.identity) ?? 0) + 1;
      this.#active.set(task.identity, n);
      this.#total += 1;
      this.stats.active = this.#total;
      this.stats.queued = this.#queue.length;
      this.stats.maxActive = Math.max(this.stats.maxActive, this.#total);
      this.stats.maxActivePerIdentity = Math.max(this.stats.maxActivePerIdentity, n);
      task.run();
    }
  }
}
