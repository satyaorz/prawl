import { createServer } from 'node:http';
import { access, readFile, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
// Tests point VEIL_DIST_ROOT at an empty temp dir so the fallback project root
// would serve index.html; production always serves the vite build from dist/.
const distRoot = process.env.VEIL_DIST_ROOT ? resolve(root, process.env.VEIL_DIST_ROOT) : resolve(root, 'dist');
const staticRoot = await access(distRoot).then(() => distRoot).catch(() => root);
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 4173);

try {
  const envText = await readFile(resolve(root, '.env.local'), 'utf8');
  for (const line of envText.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.abi': 'application/json; charset=utf-8',
  '.bin': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

// ---------------------------------------------------------------------------
// Batch-swap protocol: shared deployment config + hardhat artifacts.
// batch-config.json lets every visitor see the same deployed contract set;
// /protocol-artifacts serves ABI + creation bytecode for MetaMask deploys.
// ---------------------------------------------------------------------------
const batchConfigPath = resolve(root, 'batch-config.json');
const protocolArtifacts = {
  VeilBatchSwap: resolve(root, 'protocol/artifacts/contracts/VeilBatchSwap.sol/VeilBatchSwap.json'),
  VeilConfidentialWrapper: resolve(root, 'protocol/artifacts/contracts/VeilConfidentialWrapper.sol/VeilConfidentialWrapper.json'),
};

async function readJsonIfExists(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${host}:${port}`);
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, chainId: 11155111, rpcConfigured: Boolean(process.env.SEPOLIA_RPC_URL) }));
      return;
    }

    if (url.pathname === '/pipeline-status' && req.method === 'GET') {
      // Surface the auto-runner / demo pipeline log so the website can show
      // live deployment + settlement progress.
      const logPath = resolve(root, 'protocol', 'autorun.log');
      let lines = [];
      try {
        const raw = await readFile(logPath, "utf8");
        lines = raw.split('\n').filter(Boolean).slice(-120);
      } catch {
        // no log yet — empty list is fine
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ lines }));
      return;
    }

    if (url.pathname === '/batch-config' && req.method === 'GET') {
      const config = await readJsonIfExists(batchConfigPath);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(config || { deployed: false }));
      return;
    }

    if (url.pathname === '/batch-config' && req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }
      const isAddress = (value) => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
      if (!isAddress(body.batch) || !isAddress(body.cTokenA) || !isAddress(body.cTokenB)
        || !isAddress(body.tokenA) || !isAddress(body.tokenB) || body.chainId !== 11155111) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'batch, cTokenA, cTokenB, tokenA, tokenB (addresses) and chainId=11155111 are required' }));
        return;
      }
      const record = {
        chainId: 11155111,
        deployed: true,
        protocolVersion: Number.isInteger(body.protocolVersion) ? body.protocolVersion : null,
        batch: body.batch,
        cTokenA: body.cTokenA,
        cTokenB: body.cTokenB,
        tokenA: body.tokenA,
        tokenB: body.tokenB,
        settler: isAddress(body.settler) ? body.settler : null,
        deployedBlock: Number.isSafeInteger(body.deployedBlock) && body.deployedBlock >= 0 ? body.deployedBlock : null,
        poolKey: typeof body.poolKey === 'object' && body.poolKey ? body.poolKey : null,
        deployedBy: isAddress(body.deployedBy) ? body.deployedBy : null,
        deployedAt: new Date().toISOString(),
      };
      await writeFile(batchConfigPath, JSON.stringify(record, null, 2));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(record));
      return;
    }

    const artifactMatch = url.pathname.match(/^\/protocol-artifacts\/([A-Za-z0-9_]+)\.json$/);
    if (artifactMatch && req.method === 'GET') {
      const path = protocolArtifacts[artifactMatch[1]];
      const artifact = path ? await readJsonIfExists(path) : null;
      if (!artifact?.abi || !artifact?.bytecode) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `Artifact ${artifactMatch[1]} not compiled. Run: cd protocol && npx hardhat compile` }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ abi: artifact.abi, bytecode: artifact.bytecode }));
      return;
    }

    if (url.pathname === '/rpc' && req.method === 'POST') {
      if (!process.env.SEPOLIA_RPC_URL) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Set SEPOLIA_RPC_URL in .env.local to use the local RPC proxy.' }));
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const rawBody = Buffer.concat(chunks);
      // Alchemy's free tier rejects eth_getLogs beyond a 10-block range. Route
      // log queries to a public full node (50k-block cap) and clamp oversized
      // fromBlock values so `fromBlock: 0` scans work transparently.
      let upstreamUrl = process.env.SEPOLIA_RPC_URL;
      let body = rawBody;
      try {
        const parsed = JSON.parse(rawBody.toString('utf8'));
        if (parsed?.method === 'eth_getLogs' && Array.isArray(parsed.params) && parsed.params[0]) {
          upstreamUrl = process.env.SEPOLIA_LOGS_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';
          const filter = { ...parsed.params[0] };
          const headRes = await fetch(upstreamUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
          });
          const headJson = await headRes.json();
          const head = parseInt(headJson.result, 16);
          const fromRaw = filter.fromBlock;
          const from = fromRaw === 'earliest' || fromRaw === '0x0' || fromRaw == null ? 0 : parseInt(fromRaw, 16);
          if (!Number.isFinite(from) || head - from > 5000) {
            filter.fromBlock = '0x' + Math.max(0, head - 5000).toString(16);
          }
          parsed.params = [filter];
          body = JSON.stringify(parsed);
        }
      } catch {
        // Malformed body or head lookup failure: forward untouched.
      }
      const upstream = await fetch(upstreamUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json' });
      res.end(Buffer.from(await upstream.arrayBuffer()));
      return;
    }

    const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    if (pathname.split('/').some(part => part.startsWith('.'))) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const filePath = resolve(staticRoot, `.${pathname}`);
    if (!filePath.startsWith(`${staticRoot}${sep}`)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    const body = await readFile(filePath);
    res.writeHead(200, { 'content-type': mime[extname(filePath)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch (error) {
    const status = error?.code === 'ENOENT' ? 404 : 500;
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(status === 404 ? 'Not found' : 'Server error');
  }
});

server.listen(port, host, () => {
  process.stdout.write(`Veil Sepolia demo: http://${host}:${port}\n`);
});
