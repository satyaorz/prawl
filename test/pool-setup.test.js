import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSepoliaDemoPool, mintDemoTokens } from '../src/pool-setup.js';

test('demo pool setup builds sequential MetaMask calls for a fresh test pair', async () => {
  const bytecode = (await readFile(new URL('../artifacts/MockERC20.bin', import.meta.url), 'utf8')).trim();
  const oldFetch = globalThis.fetch;
  const oldStorage = globalThis.localStorage;
  let txIndex = 0;
  const sent = [];
  globalThis.fetch = async path => path === '/artifacts/MockERC20.bin'
    ? { ok: true, text: async () => bytecode }
    : { ok: false };
  const saved = new Map();
  globalThis.localStorage = { setItem: (key, value) => saved.set(key, value) };
  const provider = {
    async request({ method, params }) {
      if (method === 'eth_chainId') return '0xaa36a7';
      if (method === 'eth_sendTransaction') {
        sent.push(params[0]);
        txIndex += 1;
        return `0x${txIndex.toString(16).padStart(64, '0')}`;
      }
      if (method === 'eth_getTransactionReceipt') {
        const index = Number(BigInt(params[0]));
        return {
          status: '0x1',
          contractAddress: index === 1 ? '0x0000000000000000000000000000000000000011' : index === 2 ? '0x0000000000000000000000000000000000000022' : null,
        };
      }
      throw new Error(`Unexpected RPC method ${method}`);
    },
  };
  try {
    const pool = await createSepoliaDemoPool(provider, '0x00000000000000000000000000000000000000aa');
    assert.equal(sent.length, 8);
    assert.ok(sent[0].data.startsWith(`0x${bytecode}`));
    assert.equal(sent[4].to, '0xE03A1074c86CFeDd5C142C4F04F1a1536e203543');
    assert.equal(sent[7].to, '0x0c478023803a644c94c4ce1c1e7b9a087e411b0a');
    assert.equal(pool.fee, 3000);
    assert.equal(pool.tickSpacing, 60);
    assert.equal(pool.sqrtPriceX96, (1n << 96n).toString());
    assert.equal(JSON.parse(saved.get('veil.sepolia.demoPool')).tokens.length, 2);
  } finally {
    globalThis.fetch = oldFetch;
    globalThis.localStorage = oldStorage;
  }
});

test('demo pool refuses to send anything on a non-Sepolia network', async () => {
  let sent = false;
  const provider = { async request({ method }) { if (method === 'eth_chainId') return '0x1'; sent = true; } };
  await assert.rejects(createSepoliaDemoPool(provider, '0x00000000000000000000000000000000000000aa'), /Switch MetaMask to Sepolia/);
  assert.equal(sent, false);
});

test('demo faucet mints 1,000 units of each custom token to the connected Sepolia account', async () => {
  const sent = [];
  let txIndex = 0;
  const provider = {
    async request({ method, params }) {
      if (method === 'eth_chainId') return '0xaa36a7';
      if (method === 'eth_sendTransaction') {
        sent.push(params[0]);
        txIndex += 1;
        return `0x${txIndex.toString(16).padStart(64, '0')}`;
      }
      if (method === 'eth_getTransactionReceipt') return { status: '0x1' };
      throw new Error(`Unexpected RPC method ${method}`);
    },
  };
  const account = '0x00000000000000000000000000000000000000aa';
  const tokens = [
    { address: '0x0000000000000000000000000000000000000011', symbol: 'vUSD' },
    { address: '0x0000000000000000000000000000000000000022', symbol: 'vETH' },
  ];

  const transactions = await mintDemoTokens(provider, account, tokens);

  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map(tx => tx.to), tokens.map(token => token.address));
  assert.ok(sent.every(tx => tx.data.startsWith('0x40c10f19')));
  assert.equal(sent[0].data.slice(-64), (1_000n * 10n ** 18n).toString(16).padStart(64, '0'));
  assert.deepEqual(transactions.map(tx => tx.label), ['Faucet mint · vUSD', 'Faucet mint · vETH']);
});
