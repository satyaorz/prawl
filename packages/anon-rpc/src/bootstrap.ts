/**
 * Loads the Tor directory snapshot from our own origin so the worker can skip
 * fetching it through the gateway (`config.bootstrap`). Measured: ready p50
 * 4.0 s with our snapshot against 8.2 s with the gateway's, in alternating
 * runs. Any problem (404, wrong type, too big, timeout) returns undefined and
 * the worker falls back to its normal fetch; it never blocks the boot.
 */
export const DEFAULT_BOOTSTRAP_PATH = "/tor/bootstrap.zip.zst";
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

export interface BootstrapOptions {
  url?: string;
  timeoutMs?: number;
  maxBytes?: number;
  fetchFn?: typeof fetch;
  /** The page origin. A snapshot from any other origin is refused. */
  origin?: string;
}

export async function loadOwnBootstrap(options: BootstrapOptions = {}): Promise<Uint8Array | undefined> {
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  const origin = options.origin ?? globalThis.location?.origin;
  const path = options.url ?? DEFAULT_BOOTSTRAP_PATH;
  let url: URL;
  try {
    url = new URL(path, origin);
  } catch {
    return undefined;
  }
  if (origin && url.origin !== new URL(origin).origin) return undefined; // own origin only
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    const res = await fetchFn(url.href, { signal: controller.signal, credentials: "omit" });
    if (!res.ok) return undefined;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength < 4 || bytes.byteLength > (options.maxBytes ?? 16 * 1024 * 1024)) return undefined;
    if (!ZSTD_MAGIC.every((b, i) => bytes[i] === b)) return undefined;
    return bytes;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
