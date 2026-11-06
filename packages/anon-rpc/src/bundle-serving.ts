/**
 * Serving rules for the two files the client boots from. Framework-agnostic:
 * returns the headers and which pre-compressed variant to send, so any
 * server (Node, a CDN config, a service worker) can apply them.
 *
 * Worker bundle `/anon-rpc/worker-0x<keccak>.js`
 *   - the name carries the content hash, so the file never changes:
 *     `cache-control: public, max-age=31536000, immutable`;
 *   - pre-compress at build time with brotli q11 (6.87 MB → 1.91 MB, −72%;
 *     q11 costs ~10 s of CPU, so never compress on the fly); gzip-9 as the
 *     fallback (2.72 MB);
 *   - `vary: accept-encoding`.
 *   The harness re-checks the keccak of the decoded bytes, so a stale or
 *   tampered cache entry fails closed.
 *
 * Tor snapshot `/tor/bootstrap.zip.zst`
 *   - already zstd-compressed: no extra content-encoding;
 *   - it goes stale (about 3 days of validity), so `no-cache` plus an ETag.
 */
export const WORKER_PATH = /^\/anon-rpc\/worker-0x[0-9a-f]{64}\.js$/;
export const BOOTSTRAP_PATH = "/tor/bootstrap.zip.zst";

export interface Variant {
  /** Suffix of the file to send: "" (raw), ".br" or ".gz". */
  suffix: "" | ".br" | ".gz";
  headers: Record<string, string>;
}

export function workerBundleResponse(
  path: string,
  acceptEncoding: string | null | undefined,
  available: { br: boolean; gz: boolean },
): Variant | undefined {
  if (!WORKER_PATH.test(path)) return undefined;
  const accepts = parseAcceptEncoding(acceptEncoding);
  const base = {
    "content-type": "text/javascript; charset=utf-8",
    "cache-control": "public, max-age=31536000, immutable",
    vary: "accept-encoding",
    "x-content-type-options": "nosniff",
  };
  if (available.br && accepts.has("br")) return { suffix: ".br", headers: { ...base, "content-encoding": "br" } };
  if (available.gz && accepts.has("gzip")) return { suffix: ".gz", headers: { ...base, "content-encoding": "gzip" } };
  return { suffix: "", headers: base };
}

export function bootstrapResponseHeaders(etag: string): Record<string, string> {
  return {
    "content-type": "application/zstd",
    "cache-control": "no-cache",
    etag,
    "x-content-type-options": "nosniff",
  };
}

function parseAcceptEncoding(value: string | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const part of (value ?? "").split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    if (!name) continue;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    if (q && Number(q.slice(2)) === 0) continue;
    out.add(name);
  }
  return out;
}
