/**
 * Public pool snapshots for a fast first sync of new and restored wallets.
 *
 * The RAILGUN core syncs globally and a newly registered account starts at the
 * indexer's current block (UtxoIndexer::register/sync_to), so a wallet that
 * was just created can open from a checkpoint holding only public state (UTXO
 * and TXID merkle trees, PPOI lists) at block X: it cannot own notes from
 * before it existed. The core re-verifies tree roots on-chain at the next
 * sync. A restored wallet may use one too, seeded at its birth block (see
 * restoreStartBlock): the core then replays from that block, and re-inserting
 * tree leaves it already has is a no-op (merkle-tree splice is idempotent).
 *
 * A snapshot must contain no account data. stripCheckpoint() removes it and
 * isPublicSnapshot() refuses anything that still has some.
 */
type Json = Record<string, unknown>;

function obj(v: unknown): Json | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined;
}

function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (Array.isArray(v)) return v.length === 0;
  const o = obj(v);
  return o ? Object.keys(o).length === 0 : false;
}

/** Remove all wallet-specific parts of a checkpoint, keeping the public pool state. */
export function stripCheckpoint(checkpointJson: string): string {
  const cp = JSON.parse(checkpointJson) as Json;
  const utxo = obj(obj(cp.railgun)?.utxo);
  const poi = obj(cp.poi);
  const txid = obj(poi?.txid);
  if (!utxo || !poi || !txid) throw new Error("not a RAILGUN checkpoint");
  utxo.accounts = {};
  poi.provider = { pending: [], submitted: {}, recovered_valid: [] };
  txid.own_ops = {};
  return JSON.stringify(cp);
}

/** True only for a checkpoint with public state and no account, pending proof or own operation. */
export function isPublicSnapshot(checkpointJson: string): boolean {
  let cp: Json;
  try {
    cp = JSON.parse(checkpointJson) as Json;
  } catch {
    return false;
  }
  const utxo = obj(obj(cp.railgun)?.utxo);
  const poi = obj(cp.poi);
  const provider = obj(poi?.provider);
  const txid = obj(poi?.txid);
  if (!utxo || !poi || !provider || !txid) return false;
  return (
    isEmpty(utxo.accounts) &&
    isEmpty(provider.pending) &&
    isEmpty(provider.submitted) &&
    isEmpty(provider.recovered_valid) &&
    isEmpty(txid.own_ops)
  );
}

/** Block a snapshot is synced to (UTXO indexer), or undefined. */
export function snapshotBlock(checkpointJson: string): bigint | undefined {
  try {
    const n = obj(obj(obj(JSON.parse(checkpointJson))?.railgun)?.utxo)?.synced_block;
    return typeof n === "number" || typeof n === "string" ? BigInt(n) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Prepare a public snapshot for one wallet: add its account with no notes,
 * synced to `fromBlock` (default and maximum: the snapshot block). Without
 * this the core registers the account at block 0 and wallet.synced_block()
 * (the minimum over the indexer and its accounts) sends the next sync back to
 * the start of history. With an earlier `fromBlock` the next sync replays
 * from there, so pass a block no later than the wallet's birth.
 */
export function seedFreshAccount(snapshotJson: string, railgunAddress: string, fromBlock?: bigint): string {
  if (!isPublicSnapshot(snapshotJson)) throw new Error("not a public snapshot");
  if (!/^0zk1[0-9a-z]+$/.test(railgunAddress)) throw new Error("not a RAILGUN address");
  const cp = JSON.parse(snapshotJson) as { railgun: { utxo: { synced_block: number; accounts: Record<string, unknown> } } };
  const utxo = cp.railgun.utxo;
  if (fromBlock !== undefined && fromBlock < 0n) throw new Error("fromBlock must not be negative");
  const start = fromBlock === undefined ? utxo.synced_block : Math.min(utxo.synced_block, Number(fromBlock));
  utxo.accounts = { [railgunAddress]: { notes: [], synced_block: start, spent: [], sent: [] } };
  return JSON.stringify(cp);
}

/** Chains with a fixed 12 s slot and at most one block per slot (post-merge Ethereum L1). */
const TWELVE_SECOND_SLOTS: ReadonlySet<number> = new Set([1, 11_155_111]);

/**
 * The block a restored wallet's scan can start from: a block no later than
 * the wallet's birth, from the snapshot's block and timestamp alone. On
 * these chains at most one block is made per 12 s slot, so at most
 * floor((snapshotTime - bornAt) / 12) + 1 blocks lie after the birth up to the
 * snapshot; `slackS` covers a wrong clock on the creating device. Returns
 * undefined where that bound does not hold (unknown chain) or the result
 * would be before the RAILGUN deployment (scan everything instead).
 */
export function restoreStartBlock(opts: {
  chainId: number;
  snapshotBlock: bigint;
  snapshotTime: number;
  bornAt: number;
  deploymentBlock: bigint;
  slackS?: number;
}): bigint | undefined {
  if (!TWELVE_SECOND_SLOTS.has(opts.chainId)) return undefined;
  const slack = opts.slackS ?? 2 * 3600;
  const before = Math.max(0, opts.snapshotTime - (opts.bornAt - slack));
  const start = opts.snapshotBlock - BigInt(Math.floor(before / 12)) - 1n;
  if (start <= opts.deploymentBlock) return undefined;
  return start > opts.snapshotBlock ? opts.snapshotBlock : start;
}
