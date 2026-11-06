import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

function startServer(port, distRoot) {
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      VEIL_DIST_ROOT: distRoot || '',
      SEPOLIA_RPC_URL: process.env.SEPOLIA_RPC_URL || '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', chunk => process.stderr.write(chunk));
  return child;
}

async function waitForServer(port) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return response;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Server on port ${port} did not become healthy`);
}

test('server exposes /health JSON and serves the built app', async () => {
  const port = 43991;
  const server = startServer(port);
  try {
    const health = await waitForServer(port);
    const healthBody = await health.json();
    assert.equal(healthBody.ok, true);
    assert.equal(healthBody.chainId, 11155111);

    const index = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(index.status, 200);
    const html = await index.text();
    assert.match(html, /Veil — Private Swap/);

    // Missing static files must 404 instead of serving the app shell.
    const missing = await fetch(`http://127.0.0.1:${port}/definitely-not-a-file.js`);
    assert.equal(missing.status, 404);
  } finally {
    server.kill();
    await new Promise(resolve => server.once('exit', resolve));
  }
});

test('server fails closed on /rpc when SEPOLIA_RPC_URL is unset', async () => {
  const port = 43992;
  const server = startServer(port, '');
  try {
    await waitForServer(port);
    const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.match(body.error, /SEPOLIA_RPC_URL/);
  } finally {
    server.kill();
    await new Promise(resolve => server.once('exit', resolve));
  }
});
