import type { Hex } from "viem";
import type { ClearValues, KmsUserDecryptEIP712Type } from "@zama-fhe/relayer-sdk/web";
import { anon } from "../lib/anon";
import { createFheTransport } from "./transport";
import type { EncryptedInput, FromFheWorker, ToFheWorker, WorkerCall } from "./fhe-protocol";

/** A per-unlock FHE session. Terminate it on wallet lock or account change. */
export class FheController {
  readonly #worker: Worker;
  readonly #transport: ReturnType<typeof createFheTransport>;
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  #sequence = 0;
  #closed = false;

  private constructor(account: string, chainId: number) {
    this.#transport = createFheTransport(anon, account, chainId);
    this.#worker = new Worker(new URL("./fhe-worker.ts", import.meta.url), { type: "module", name: "private-swap-fhe" });
    this.#worker.onmessage = (event: MessageEvent<FromFheWorker>) => void this.#onMessage(event.data);
    this.#worker.onerror = () => this.close();
    this.#worker.onmessageerror = () => this.close();
  }

  static async open(account: string, chainId: number): Promise<FheController> {
    const controller = new FheController(account, chainId);
    try {
      await controller.#call({ op: "init", account, chainId });
      return controller;
    } catch (error) {
      controller.close();
      throw error;
    }
  }

  async encrypt(contract: Hex, amount: bigint, direction?: 1 | 2, minimumOutput?: bigint): Promise<EncryptedInput> {
    return await this.#call({ op: "encrypt", contract, amount: amount.toString(), ...(direction ? { direction } : {}), ...(minimumOutput !== undefined ? { minimumOutput: minimumOutput.toString() } : {}) }) as EncryptedInput;
  }

  /** Caller must validate the contract list before signing this authorization. */
  async prepareDecrypt(contracts: Hex[]): Promise<KmsUserDecryptEIP712Type> {
    return await this.#call({ op: "prepare-decrypt", contracts }) as KmsUserDecryptEIP712Type;
  }

  async decrypt(handles: Array<{ handle: Hex; contractAddress: Hex }>, signature: Hex): Promise<ClearValues> {
    return await this.#call({ op: "decrypt", handles, signature }) as ClearValues;
  }

  /** Gateway decryption of handles the contract made publicly decryptable (a round's net, an unwrap). Needs no key or signature. */
  async publicDecrypt(handles: Hex[]): Promise<{ clearValues: Record<string, bigint | boolean | string>; abiEncodedClearValues: Hex; decryptionProof: Hex }> {
    return await this.#call({ op: "public-decrypt", handles }) as { clearValues: Record<string, bigint | boolean | string>; abiEncodedClearValues: Hex; decryptionProof: Hex };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#worker.terminate();
    for (const request of this.#pending.values()) request.reject(new Error("FHE session closed"));
    this.#pending.clear();
  }

  #post(message: ToFheWorker, transfer: Transferable[] = []): void {
    if (!this.#closed) this.#worker.postMessage(message, transfer);
  }

  #call(call: WorkerCall): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("FHE session closed"));
    const id = ++this.#sequence;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#post({ type: "call", id, call });
    });
  }

  async #onMessage(message: FromFheWorker): Promise<void> {
    if (this.#closed) return;
    if (message.type === "result") {
      const request = this.#pending.get(message.id);
      if (!request) return;
      this.#pending.delete(message.id);
      if (message.ok) request.resolve(message.value);
      else request.reject(new Error(message.error));
      return;
    }
    if (message.type === "rpc") {
      try {
        const value = await this.#transport.rpc(message.method, message.params);
        this.#post({ type: "rpc-result", id: message.id, ok: true, value });
      } catch (error) {
        this.#post({ type: "rpc-result", id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    try {
      const response = await this.#transport.fetch(message.url, message.method, message.headers, message.body);
      const body = response.body ? await response.arrayBuffer() : null;
      const headers: [string, string][] = [];
      response.headers.forEach((value, key) => headers.push([key, value]));
      this.#post({ type: "fetch-result", id: message.id, ok: true, status: response.status, statusText: response.statusText, headers, body, url: response.url }, body ? [body] : []);
    } catch (error) {
      this.#post({ type: "fetch-result", id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
}
