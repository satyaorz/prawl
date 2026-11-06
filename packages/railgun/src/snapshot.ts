/**
 * Public pool snapshots for fast first sync of NEW wallets.
 *
 * The RAILGUN core syncs globally and a newly registered account starts at the
 * indexer's current block (UtxoIndexer::register/sync_to), so a wallet that
 * was just created can open from a checkpoint holding only public state (UTXO
 * and TXID merkle trees, PPOI lists) at block X: it cannot own notes from
 * before it existed. The core re-verifies tree roots on-chain at the next
 * sync. A restored wallet must NOT use a snapshot; it needs the full scan.
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
 * Prepare a public snapshot for one brand-new wallet: add its account with no
 * notes, synced to the snapshot block. Without this the core registers the
 * account at block 0 and wallet.synced_block() (the minimum over the indexer
 * and its accounts) sends the next sync back to the start of history.
 * Only valid for a wallet created after the snapshot block.
 */
export function seedFreshAccount(snapshotJson: string, railgunAddress: string): string {
  if (!isPublicSnapshot(snapshotJson)) throw new Error("not a public snapshot");
  if (!/^0zk1[0-9a-z]+$/.test(railgunAddress)) throw new Error("not a RAILGUN address");
  const cp = JSON.parse(snapshotJson) as { railgun: { utxo: { synced_block: number; accounts: Record<string, unknown> } } };
  const utxo = cp.railgun.utxo;
  utxo.accounts = { [railgunAddress]: { notes: [], synced_block: utxo.synced_block, spent: [], sent: [] } };
  return JSON.stringify(cp);
}
