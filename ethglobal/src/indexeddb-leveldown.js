import AbstractLevelDOWN from '../libhelp/node_modules/abstract-leveldown/abstract-leveldown.js';
import AbstractIterator from '../libhelp/node_modules/abstract-leveldown/abstract-iterator.js';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function asBytes(value) {
  if (value instanceof Uint8Array) return value.slice();
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value).slice();
  if (typeof value === 'string') return encoder.encode(value);
  throw new TypeError('IndexedDB LevelDOWN values must be strings or byte arrays.');
}

function callbackOnTransaction(transaction, request, callback, result = () => undefined) {
  let requestResult;
  let completed = false;
  const finish = (error, value) => {
    if (completed) return;
    completed = true;
    callback(error, value);
  };
  request.onsuccess = () => { requestResult = result(request.result); };
  transaction.oncomplete = () => finish(null, requestResult);
  transaction.onerror = () => finish(transaction.error || request.error || new Error('IndexedDB transaction failed.'));
  transaction.onabort = () => finish(transaction.error || request.error || new Error('IndexedDB transaction aborted.'));
}

class BrowserIterator extends AbstractIterator {
  constructor(database, options) {
    super(database);
    this.options = options;
    this.cursorRequest = undefined;
    this.cursor = undefined;
    this.count = 0;
  }

  _next(callback) {
    const { gt, gte, lt, lte, reverse, limit } = this.options;
    if (limit !== undefined && limit >= 0 && this.count >= limit) {
      callback();
      return;
    }
    if (!this.cursorRequest) {
      try {
        const transaction = this.db.db.transaction([this.db.location], 'readonly');
        const store = transaction.objectStore(this.db.location);
        const lower = gt === undefined ? gte : gt;
        const upper = lt === undefined ? lte : lt;
        let range;
        if (lower !== undefined && upper !== undefined) {
          range = IDBKeyRange.bound(asBytes(lower), asBytes(upper), gt !== undefined, lt !== undefined);
        } else if (lower !== undefined) {
          range = IDBKeyRange.lowerBound(asBytes(lower), gt !== undefined);
        } else if (upper !== undefined) {
          range = IDBKeyRange.upperBound(asBytes(upper), lt !== undefined);
        }
        this.cursorRequest = store.openCursor(range, reverse ? 'prev' : 'next');
      } catch (error) {
        callback(error);
        return;
      }
    } else if (this.cursor) {
      try {
        this.cursor.continue();
      } catch (error) {
        callback(error);
        return;
      }
    }

    this.cursorRequest.onerror = () => callback(this.cursorRequest.error || new Error('IndexedDB iterator failed.'));
    this.cursorRequest.onsuccess = () => {
      const cursor = this.cursorRequest.result;
      if (!cursor) { callback(); return; }
      this.cursor = cursor;
      this.count += 1;
      const keyBytes = asBytes(cursor.key);
      const valueBytes = asBytes(cursor.value);
      const key = this.options.keys === false ? undefined : (this.options.keyAsBuffer === false ? decoder.decode(keyBytes) : keyBytes);
      const value = this.options.values === false ? undefined : (this.options.valueAsBuffer === false ? decoder.decode(valueBytes) : valueBytes);
      callback(null, key, value);
    };
  }
}

export class IndexedDBLevelDOWN extends AbstractLevelDOWN {
  constructor(location = 'veil-railgun-wallet-v1') {
    super({ encodings: ['utf8', 'binary', 'id'] });
    this.location = location;
    this.db = undefined;
  }

  _open(_options, callback) {
    if (typeof indexedDB === 'undefined') { callback(new Error('IndexedDB is unavailable.')); return; }
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      callback(error);
    };
    const request = indexedDB.open(this.location, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(this.location)) request.result.createObjectStore(this.location);
    };
    request.onsuccess = () => {
      if (settled) { request.result.close(); return; }
      this.db = request.result;
      finish();
    };
    request.onerror = () => finish(request.error || new Error('Could not open wallet database.'));
    request.onblocked = () => finish(new Error('Wallet database upgrade is blocked by another tab.'));
  }

  _close(callback) {
    this.db?.close();
    this.db = undefined;
    callback();
  }

  _get(key, options, callback) {
    try {
      const request = this.db.transaction([this.location], 'readonly').objectStore(this.location).get(asBytes(key));
      request.onsuccess = () => {
        if (request.result === undefined) {
          const error = new Error('NotFound');
          error.notFound = true;
          error.status = 404;
          callback(error);
          return;
        }
        callback(null, options.asBuffer === false ? decoder.decode(asBytes(request.result)) : asBytes(request.result));
      };
      request.onerror = () => callback(request.error || new Error('Wallet database read failed.'));
    } catch (error) { callback(error); }
  }

  _put(key, value, _options, callback) {
    try {
      const transaction = this.db.transaction([this.location], 'readwrite');
      const request = transaction.objectStore(this.location).put(asBytes(value), asBytes(key));
      callbackOnTransaction(transaction, request, callback);
    } catch (error) { callback(error); }
  }

  _del(key, _options, callback) {
    try {
      const transaction = this.db.transaction([this.location], 'readwrite');
      const request = transaction.objectStore(this.location).delete(asBytes(key));
      callbackOnTransaction(transaction, request, callback);
    } catch (error) { callback(error); }
  }

  _batch(operations, _options, callback) {
    try {
      const transaction = this.db.transaction([this.location], 'readwrite');
      const store = transaction.objectStore(this.location);
      for (const operation of operations) {
        if (operation.type === 'put') store.put(asBytes(operation.value), asBytes(operation.key));
        else if (operation.type === 'del') store.delete(asBytes(operation.key));
        else throw new Error(`Unknown LevelDOWN batch operation: ${operation.type}`);
      }
      transaction.oncomplete = () => callback();
      transaction.onerror = () => callback(transaction.error || new Error('Wallet database batch failed.'));
      transaction.onabort = () => callback(transaction.error || new Error('Wallet database batch aborted.'));
    } catch (error) { callback(error); }
  }

  _iterator(options) { return new BrowserIterator(this, options); }
}

export function createIndexedDBLevelDOWN(name = 'veil-railgun-wallet-v1') {
  return new IndexedDBLevelDOWN(name);
}
