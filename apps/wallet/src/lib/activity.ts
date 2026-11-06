/**
 * Local activity history: what this wallet did (shields, private sends,
 * withdrawals, public sends, offline loads and cash-outs). It is private data,
 * so it is sealed with the passkey-derived storage key, like the RAILGUN
 * checkpoints, and never leaves the device. Transactions are shown by hash
 * only: no explorer links, since opening one would tell that site your IP
 * and which transaction is yours.
 */
import { open, seal, type Sealed } from "@prawl/keys";

export type ActivityKind = "shield" | "send" | "unshield" | "public-send" | "offline-load" | "offline-redeem";

export interface Activity {
  /** Unix ms. */
  at: number;
  kind: ActivityKind;
  /** Wei, decimal string. */
  amount: string;
  /** Recipient (0zk or 0x) where there is one. */
  to?: string;
  txHash: string;
  ok: boolean;
}

export interface KvStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<unknown>;
}

/** Most entries kept; the oldest are dropped first. */
export const MAX_ACTIVITY = 200;

export class ActivityLog {
  #items: Activity[] = [];
  #write: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: KvStore,
    private readonly key: CryptoKey,
    private readonly name: string,
  ) {}

  /** Load and open the sealed history. A record this key cannot open (another wallet, corrupt) reads as empty. */
  async load(): Promise<Activity[]> {
    const sealed = await this.store.get<Sealed>(this.name);
    if (!sealed) return (this.#items = []);
    try {
      const parsed = JSON.parse(await open(this.key, this.name, sealed)) as unknown;
      this.#items = Array.isArray(parsed) ? (parsed as Activity[]).filter(isActivity) : [];
    } catch {
      this.#items = [];
    }
    return this.list();
  }

  /** Newest first. */
  list(): Activity[] {
    return [...this.#items].sort((a, b) => b.at - a.at);
  }

  /** Add an entry and save; writes are serialized so none is lost. */
  async add(entry: Activity): Promise<Activity[]> {
    this.#items = [...this.#items, entry].sort((a, b) => a.at - b.at).slice(-MAX_ACTIVITY);
    const snapshot = JSON.stringify(this.#items);
    this.#write = this.#write.then(async () => this.store.set(this.name, await seal(this.key, this.name, snapshot)));
    await this.#write;
    return this.list();
  }
}

function isActivity(v: unknown): v is Activity {
  const a = v as Partial<Activity>;
  return !!a && typeof a.at === "number" && typeof a.kind === "string" && typeof a.amount === "string" && typeof a.txHash === "string";
}
