/**
 * Dev/preview middleware that serves the two files Anon-RPC boots from, out of
 * the local-only `.local/` folder (never committed):
 *
 *   /anon-rpc/worker-0x<keccak>.js  <- .local/worker/*-0x<keccak>.js (+ .br/.gz if present)
 *   /tor/bootstrap.zip.zst          <- .local/tor/bootstrap.zip.zst (written by gateway/start.sh)
 *   /railgun/<file>                 <- .local/railgun/web/<file> (packages/railgun/scripts/build-wasm.sh)
 *
 * It also exposes the local gateway address (.local/gateway/kps-address) to
 * the app as `import.meta.env.VITE_PRAWL_GATEWAY`, unless that is already set.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { Connect, Plugin } from "vite";
import { BOOTSTRAP_PATH, WORKER_PATH, bootstrapResponseHeaders, workerBundleResponse } from "../../../packages/anon-rpc/src/bundle-serving";

export function prawlLocalAssets(root: string): Plugin {
  const local = path.join(root, ".local");
  const workerDir = path.join(local, "worker");
  const snapshot = path.join(local, "tor", "bootstrap.zip.zst");
  const kpsFile = path.join(local, "gateway", "kps-address");
  const railgunDir = path.join(local, "railgun", "web");
  const RAILGUN_FILES: Record<string, string> = {
    "kohaku_railgun_wasm.js": "text/javascript; charset=utf-8",
    "kohaku_railgun_wasm_bg.wasm": "application/wasm",
  };

  const findWorker = (hash: string): string | undefined => {
    if (!existsSync(workerDir)) return undefined;
    const name = readdirSync(workerDir).find((f) => f.endsWith(`-${hash}.js`));
    return name ? path.join(workerDir, name) : undefined;
  };

  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    const url = (req.url ?? "").split("?")[0] ?? "";
    if (WORKER_PATH.test(url)) {
      const hash = url.slice("/anon-rpc/worker-".length, -".js".length);
      const file = findWorker(hash);
      if (!file) {
        res.statusCode = 404;
        res.end(`worker ${hash} not in .local/worker (see vendor/torjs-worker/build.sh)`);
        return;
      }
      const variant = workerBundleResponse(url, req.headers["accept-encoding"], {
        br: existsSync(`${file}.br`),
        gz: existsSync(`${file}.gz`),
      });
      if (!variant) return next();
      for (const [k, v] of Object.entries(variant.headers)) res.setHeader(k, v);
      res.end(readFileSync(file + variant.suffix));
      return;
    }
    if (url.startsWith("/railgun/")) {
      const name = url.slice("/railgun/".length);
      const type = RAILGUN_FILES[name];
      const file = path.join(railgunDir, name);
      if (!type || !existsSync(file)) {
        res.statusCode = 404;
        res.end("RAILGUN wasm not built (packages/railgun/scripts/build-wasm.sh)");
        return;
      }
      res.setHeader("content-type", type);
      res.setHeader("cache-control", "no-cache");
      res.setHeader("x-content-type-options", "nosniff");
      res.end(readFileSync(file));
      return;
    }
    if (url === BOOTSTRAP_PATH) {
      if (!existsSync(snapshot)) {
        res.statusCode = 404;
        res.end("no Tor snapshot (run gateway/start.sh)");
        return;
      }
      const bytes = readFileSync(snapshot);
      const etag = `"${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}"`;
      if (req.headers["if-none-match"] === etag) {
        res.statusCode = 304;
        res.end();
        return;
      }
      for (const [k, v] of Object.entries(bootstrapResponseHeaders(etag))) res.setHeader(k, v);
      res.setHeader("last-modified", statSync(snapshot).mtime.toUTCString());
      res.end(bytes);
      return;
    }
    next();
  };

  return {
    name: "prawl-local-assets",
    config() {
      if (process.env.VITE_PRAWL_GATEWAY || !existsSync(kpsFile)) return;
      const addr = readFileSync(kpsFile, "utf8").trim();
      if (addr) return { define: { "import.meta.env.VITE_PRAWL_GATEWAY": JSON.stringify(addr) } };
    },
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
