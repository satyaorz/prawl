import { defineConfig, loadEnv } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const localPackage = name => resolve(root, 'libhelp/node_modules', name);
const installedWaku = resolve(root, 'node_modules/@railgun-community/waku-broadcaster-client-web');

function rpcProxyPlugin(rpcUrl) {
  return {
    name: 'veil-sepolia-rpc-proxy',
    configureServer(server) {
      server.middlewares.use('/rpc', async (request, response) => {
        response.setHeader('cache-control', 'no-store');
        response.setHeader('content-type', 'application/json');
        if (request.method !== 'POST') {
          response.statusCode = 405;
          response.end(JSON.stringify({ error: 'POST required' }));
          return;
        }
        if (!rpcUrl) {
          response.statusCode = 503;
          response.end(JSON.stringify({ error: 'Configure SEPOLIA_RPC_URL in .env.local.' }));
          return;
        }
        try {
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          const upstream = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: Buffer.concat(chunks),
          });
          response.statusCode = upstream.status;
          response.end(Buffer.from(await upstream.arrayBuffer()));
        } catch (error) {
          response.statusCode = 502;
          response.end(JSON.stringify({ error: error?.message || 'Sepolia RPC proxy failed.' }));
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // Load server-side settings without exposing them through VITE_* client variables.
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [
      nodePolyfills({ include: ['assert', 'buffer', 'crypto', 'events', 'http', 'https', 'os', 'process', 'stream', 'url', 'util', 'vm', 'zlib'] }),
      rpcProxyPlugin(env.SEPOLIA_RPC_URL),
    ],
    resolve: {
      alias: {
        // Build the checked-out Wallet SDK TypeScript directly. This lets the
        // demo work even while the fork's dist/ folder is being rebuilt.
        '@railgun-community/wallet': resolve(root, 'libhelp/src/index.ts'),
        '@railgun-community/engine': resolve(localPackage('@railgun-community/engine'), 'dist/index.js'),
        '@railgun-community/shared-models': resolve(localPackage('@railgun-community/shared-models'), 'dist/index.js'),
        ethers: resolve(localPackage('ethers'), 'lib.esm/index.js'),
        '@veil/waku-client': existsSync(installedWaku) ? installedWaku : resolve(root, 'src/waku-client-unavailable.js'),
      },
    },
    server: { host: '127.0.0.1', port: 4173, strictPort: true },
    build: {
      target: 'es2022',
      sourcemap: true,
      commonjsOptions: { include: [/node_modules/, /libhelp/] },
      rollupOptions: {
        input: {
          main: resolve(root, 'index.html'),
          batch: resolve(root, 'batch.html'),
        },
      },
    },
    optimizeDeps: { exclude: ['snarkjs'], include: ['ethers'] },
  };
});
