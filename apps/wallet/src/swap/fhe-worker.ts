/// <reference lib="webworker" />
import { bytesToHex, getAddress } from "viem";
import type { FhevmInstance } from "@zama-fhe/relayer-sdk/web";
import type { FromFheWorker, ToFheWorker, WorkerCall } from "./fhe-protocol";

declare const self: DedicatedWorkerGlobalScope;
const localFetch = self.fetch.bind(self);
const send = (message: FromFheWorker, transfer: Transferable[] = []) => self.postMessage(message, transfer);
let sequence = 0;
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();

// SDK wasm is served with the app. All other fetches are bridged to the
// page's allowlisted Anon-RPC transport; never fall back to direct fetch.
self.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = input instanceof Request ? input : new Request(input, init);
  const url = new URL(request.url);
  if (url.origin === self.location.origin) return localFetch(request);
  // The key store's objects (public key, CRS ~4.6 MB) never change for a given
  // URL and are public: keep them so a later unlock does not re-download them
  // over Tor. Everything else always goes out through the bridge.
  const cacheable = request.method === "GET" && url.hostname.endsWith(".amazonaws.com");
  if (cacheable) {
    try {
      const hit = await (await caches.open("prawl-zama-keys-v1")).match(url.href);
      if (hit) return hit;
    } catch { /* no Cache API: fall through to the network bridge */ }
  }
  const body = request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer();
  const headers: [string, string][] = [];
  request.headers.forEach((value, key) => headers.push([key, value]));
  const id = ++sequence;
  return new Promise<Response>((resolve, reject) => {
    if (request.signal.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
    pending.set(id, { resolve, reject });
    request.signal.addEventListener("abort", () => {
      if (pending.delete(id)) reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
    send({ type: "fetch", id, url: url.href, method: request.method, headers, body }, body ? [body] : []);
  }).then(async (response) => {
    if (cacheable && response.ok) {
      try { await (await caches.open("prawl-zama-keys-v1")).put(url.href, response.clone()); } catch { /* cache is best effort */ }
    }
    return response;
  });
}) as typeof fetch;

function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ type: "rpc", id, method, params });
  });
}

let instance: FhevmInstance | undefined;
let owner: string | undefined;
let decryptSession: { keypair: ReturnType<FhevmInstance["generateKeypair"]>; contracts: string[]; start: number; days: number } | undefined;

async function run(call: WorkerCall): Promise<unknown> {
  if (call.op === "init") {
    if (instance) throw new Error("FHE worker already initialized");
    if (call.chainId !== 11155111) throw new Error("Unsupported FHE chain");
    owner = getAddress(call.account);
    const sdk = await import("@zama-fhe/relayer-sdk/web");
    await sdk.initSDK({ thread: 1 });
    instance = await sdk.createInstance({
      ...sdk.SepoliaConfig,
      network: { request: ({ method, params }: { method: string; params?: unknown[] }) => rpc(method, params) },
      batchRpcCalls: false,
    });
    return true;
  }
  if (!instance || !owner) throw new Error("FHE worker is not initialized");
  if (call.op === "prepare-decrypt") {
    if (!call.contracts.length || call.contracts.length > 3) throw new Error("Invalid decryption contract list");
    const contracts = call.contracts.map((address) => getAddress(address));
    if (new Set(contracts).size !== contracts.length) throw new Error("Duplicate decryption contract");
    const keypair = instance.generateKeypair();
    const start = Math.floor(Date.now() / 1000);
    const days = 1;
    decryptSession = { keypair, contracts, start, days };
    return instance.createEIP712(keypair.publicKey, contracts, start, days);
  }
  if (call.op === "public-decrypt") {
    if (!call.handles.length || call.handles.length > 2 || call.handles.some((h) => !/^0x[0-9a-fA-F]{64}$/.test(h))) throw new Error("Invalid public decryption handles");
    return instance.publicDecrypt(call.handles);
  }
  if (call.op === "decrypt") {
    const session = decryptSession;
    if (!session || Math.floor(Date.now() / 1000) >= session.start + session.days * 86400) throw new Error("Decryption authorization is missing or expired");
    if (!call.handles.length || call.handles.length > 4) throw new Error("Invalid decryption handle list");
    const handles = call.handles.map(({ handle, contractAddress }) => {
      const contract = getAddress(contractAddress);
      if (!session.contracts.includes(contract) || !/^0x[0-9a-fA-F]{64}$/.test(handle)) throw new Error("Invalid decryption target");
      return { handle, contractAddress: contract };
    });
    return instance.userDecrypt(handles, session.keypair.privateKey, session.keypair.publicKey, call.signature, session.contracts, owner, session.start, session.days);
  }
  const amount = BigInt(call.amount);
  if (amount <= 0n || amount > (1n << 64n) - 1n) throw new Error("Amount is outside the confidential token range");
  if (call.direction !== undefined && call.direction !== 1 && call.direction !== 2) throw new Error("Invalid swap direction");
  const input = instance.createEncryptedInput(getAddress(call.contract), owner).add64(amount);
  if (call.direction !== undefined) input.add8(call.direction);
  if (call.minimumOutput !== undefined) {
    if (call.direction === undefined) throw new Error("Minimum output requires a swap direction");
    const minimum = BigInt(call.minimumOutput);
    if (minimum < 0n || minimum > (1n << 64n) - 1n) throw new Error("Minimum output is outside the confidential token range");
    input.add64(minimum);
  }
  const encrypted = await input.encrypt();
  return { handles: encrypted.handles.map((handle) => bytesToHex(handle)), proof: bytesToHex(encrypted.inputProof) };
}

self.onmessage = (event: MessageEvent<ToFheWorker>) => {
  const message = event.data;
  if (message.type === "call") {
    void run(message.call).then(
      (value) => send({ type: "result", id: message.id, ok: true, value }),
      (error: unknown) => send({ type: "result", id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
    return;
  }
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (!message.ok) { request.reject(new Error(message.error)); return; }
  if (message.type === "rpc-result") { request.resolve(message.value); return; }
  const response = new Response(message.body, { status: message.status, statusText: message.statusText, headers: message.headers });
  Object.defineProperty(response, "url", { value: message.url });
  request.resolve(response);
};
