import test from 'node:test';
import assert from 'node:assert/strict';
import { asBytes, createIndexedDBLevelDOWN } from '../src/indexeddb-leveldown.js';

test('IndexedDB LevelDOWN byte conversion clones and preserves byte views', () => {
  const source = new Uint8Array([1, 2, 3]);
  const converted = asBytes(source);
  assert.deepEqual([...converted], [1, 2, 3]);
  converted[0] = 9;
  assert.equal(source[0], 1);

  const backing = new Uint8Array([0, 4, 5, 0]);
  assert.deepEqual([...asBytes(backing.subarray(1, 3))], [4, 5]);
  assert.deepEqual([...asBytes(new Uint8Array([6, 7]).buffer)], [6, 7]);
  assert.deepEqual([...asBytes('railgun')], [...new TextEncoder().encode('railgun')]);
});

test('IndexedDB LevelDOWN rejects non-byte database values', () => {
  assert.throws(() => asBytes(null), /must be strings or byte arrays/);
  assert.throws(() => asBytes(12), /must be strings or byte arrays/);
});

test('IndexedDB LevelDOWN reports a clear error when opened outside a browser', async () => {
  const database = createIndexedDBLevelDOWN('test-no-indexeddb');
  await new Promise((resolve, reject) => {
    database.open(error => {
      if (error) reject(error);
      else resolve();
    });
  }).then(
    () => assert.fail('Opening without IndexedDB should fail.'),
    error => assert.match(error.message, /IndexedDB is unavailable/),
  );
});

class FakeTransaction {
  constructor(store) { this.store = store; }
  objectStore() { return this.store; }
}

class FakeStore {
  constructor() { this.rows = new Map(); }
  keyId(key) { return [...asBytes(key)].join(','); }
  put(value, key) {
    this.rows.set(this.keyId(key), { key: asBytes(key), value: asBytes(value) });
    const request = {};
    queueMicrotask(() => request.onsuccess?.({ target: request }));
    return request;
  }
  get(key) {
    const request = {};
    queueMicrotask(() => {
      request.result = this.rows.get(this.keyId(key))?.value;
      request.onsuccess?.({ target: request });
    });
    return request;
  }
  delete(key) {
    this.rows.delete(this.keyId(key));
    const request = {};
    queueMicrotask(() => request.onsuccess?.({ target: request }));
    return request;
  }
  openCursor(range, direction) {
    const request = {};
    const rows = [...this.rows.values()].sort((left, right) => {
      const a = new TextDecoder().decode(left.key);
      const b = new TextDecoder().decode(right.key);
      return a < b ? -1 : a > b ? 1 : 0;
    });
    const inRange = ({ key }) => {
      const value = new TextDecoder().decode(key);
      const lower = range?.lower && new TextDecoder().decode(range.lower);
      const upper = range?.upper && new TextDecoder().decode(range.upper);
      return (!lower || (range.lowerOpen ? value > lower : value >= lower))
        && (!upper || (range.upperOpen ? value < upper : value <= upper));
    };
    let filtered = rows.filter(inRange);
    if (direction === 'prev') filtered = filtered.reverse();
    let index = 0;
    const emit = () => {
      const row = filtered[index];
      request.result = row && {
        key: row.key,
        value: row.value,
        continue() { index += 1; queueMicrotask(emit); },
      };
      request.onsuccess?.({ target: request });
    };
    queueMicrotask(emit);
    return request;
  }
}

test('IndexedDB LevelDOWN supports put, get, batch and incremental range iteration', async () => {
  const oldIndexedDB = globalThis.indexedDB;
  const oldKeyRange = globalThis.IDBKeyRange;
  const stores = new Map();
  const fakeDatabase = {
    objectStoreNames: { contains: name => stores.has(name) },
    createObjectStore(name) { stores.set(name, new FakeStore()); },
    transaction([name]) {
      const transaction = new FakeTransaction(stores.get(name));
      queueMicrotask(() => transaction.oncomplete?.());
      return transaction;
    },
    close() {},
  };
  globalThis.indexedDB = {
    open() {
      const request = { result: fakeDatabase };
      queueMicrotask(() => {
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
  globalThis.IDBKeyRange = {
    bound(lower, upper, lowerOpen, upperOpen) { return { lower, upper, lowerOpen, upperOpen }; },
    lowerBound(lower, lowerOpen) { return { lower, lowerOpen }; },
    upperBound(upper, upperOpen) { return { upper, upperOpen }; },
  };

  const database = createIndexedDBLevelDOWN('fake-railgun-store');
  const call = (method, ...args) => new Promise((resolve, reject) => {
    database[method](...args, (error, result) => error ? reject(error) : resolve(result));
  });
  try {
    await new Promise((resolve, reject) => database.open(error => error ? reject(error) : resolve()));
    await call('put', 'alpha', 'one', {});
    await call('batch', [
      { type: 'put', key: 'beta', value: 'two' },
      { type: 'put', key: 'gamma', value: 'three' },
    ], {});
    assert.equal(new TextDecoder().decode(await call('get', 'beta', { asBuffer: true })), 'two');

    const iterator = database.iterator({ gte: 'beta', lte: 'gamma', keyAsBuffer: false, valueAsBuffer: false });
    const rows = [];
    while (true) {
      const row = await new Promise((resolve, reject) => iterator.next((error, key, value) => error ? reject(error) : resolve(key === undefined ? undefined : [key, value])));
      if (!row) break;
      rows.push(row);
    }
    await new Promise((resolve, reject) => iterator.end(error => error ? reject(error) : resolve()));
    assert.deepEqual(rows, [['beta', 'two'], ['gamma', 'three']]);
    await new Promise((resolve, reject) => database.close(error => error ? reject(error) : resolve()));
  } finally {
    globalThis.indexedDB = oldIndexedDB;
    globalThis.IDBKeyRange = oldKeyRange;
  }
});
