import type { AnonRpcClient } from "@prawl/anon-rpc";
import type { Call } from "@prawl/railgun";
import type { KmsUserDecryptEIP712Type } from "@zama-fhe/relayer-sdk/web";
import { decodeFunctionResult, encodeFunctionData, getAddress, isHex, parseAbi, type Address, type Hex } from "viem";
import { UnconfirmedError, type SentTx } from "../lib/tx";
import { verifySwapDeployment, type SwapDeployment } from "./deployment";
import { FheController } from "./fhe-controller";

const tokenAbi = parseAbi(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"]);
const wrapperAbi = parseAbi([
  "function confidentialBalanceOf(address) view returns (bytes32)",
  "function wrap(address,uint256)",
  "function confidentialTransferAndCall(address,bytes32,bytes,bytes) returns (bytes32)",
]);
const batchAbi = parseAbi([
  "function fundedBalance(address,uint8) view returns (bytes32)",
  "function currentRound() view returns (uint256)",
  "function distinctSubmitters() view returns (uint256)",
  "function lastUpdateTime() view returns (uint256)",
  "function minRoundDuration() view returns (uint256)",
  "function minDistinctSubmitters() view returns (uint256)",
  "function refundDelay() view returns (uint256)",
  "function maxPriceAge() view returns (uint256)",
  "function closedAt(uint256) view returns (uint256)",
  "function refundable(uint256) view returns (bool)",
  "function orderStatus(uint256,address) view returns (bool submitted,bool credited,bool refunded)",
  "function rounds(uint256) view returns (bytes32 aToB,bytes32 bToA,bytes32 netEnc,bytes32 surplusEnc,bool closed,bool prepared,bool executed,uint64 netSwapped,uint8 surplusSide,uint256 minSwapOutput,bytes32 unwrapHandle,uint64 swapOutput)",
  "function roundPrices(uint256) view returns (uint64 lotA,uint64 lotB,uint64 maxLots,uint256 validUntil)",
  "function submitOrder(bytes32,bytes,bytes32,bytes,bytes32,bytes)",
  "function exit(uint8,bytes32,bytes)",
  "function refundOrder(uint256,address)",
  "function creditOrder(uint256,address)",
]);
const oracleAbi = parseAbi(["function latestLotPrice() view returns (uint64 lotA,uint64 lotB,uint256 updatedAt)"]);
const EMPTY_HANDLE = `0x${"00".repeat(32)}`;
const RATE = 10n ** 12n;
const MAX_U64 = (1n << 64n) - 1n;

export interface SwapBalances {
  public: readonly [bigint, bigint];
  wrapped: readonly [bigint, bigint];
  vault: readonly [bigint, bigint];
  round: bigint;
  submitters: bigint;
  minSubmitters: bigint;
  closesAt: bigint;
  refundDelay: bigint;
  lotA: bigint;
  lotB: bigint;
  priceValidUntil: bigint | undefined;
  maxLots: bigint;
  chainTime: bigint;
  priceError?: string;
}

/** Where one user's order in one round has got to. Derived from public state only. */
export type OrderPhase = "none" | "open" | "awaiting-settlement" | "settled" | "refundable" | "refunded";

export interface SwapOrderStatus {
  round: bigint;
  phase: OrderPhase;
  /** Seconds until the round can close; 0 once it can. */
  closesIn: bigint;
  /** True when the user may still place an order in this round. */
  canOrder: boolean;
  /** True when the user can recover the escrowed amount themselves. */
  canRefund: boolean;
  /** Human sentence for the dashboard; never claims an outcome the chain does not show. */
  detail: string;
}

export interface SwapSigner {
  /** Must verify the authorization's domain and addresses before signing. */
  signDecrypt(request: KmsUserDecryptEIP712Type, contracts: readonly Address[]): Promise<Hex>;
  send(calls: readonly Call[], onStatus?: (status: string) => void): Promise<SentTx[]>;
}

/** An unlocked-wallet session. All calls and gateway I/O use Anon-RPC. */
export class SwapService {
  readonly #client: AnonRpcClient;
  readonly #account: Address;
  readonly #signer: SwapSigner;
  readonly #fhe: FheController;
  readonly config: SwapDeployment;
  #closed = false;
  #running = false;
  #decryptSignature: Hex | undefined;
  #decryptUntil = 0;

  private constructor(client: AnonRpcClient, account: Address, config: SwapDeployment, signer: SwapSigner, fhe: FheController) {
    this.#client = client; this.#account = account; this.config = config; this.#signer = signer; this.#fhe = fhe;
    this.#lastKnownRound = undefined;
  }

  static async open(client: AnonRpcClient, account: Address, config: SwapDeployment, signer: SwapSigner): Promise<SwapService> {
    await verifySwapDeployment(client, config);
    const fhe = await FheController.open(getAddress(account), config.chainId);
    return new SwapService(client, getAddress(account), config, signer, fhe);
  }

  close(): void { this.#closed = true; this.#decryptSignature = undefined; this.#fhe.close(); }
  #assertOpen(): void { if (this.#closed) throw new Error("Swap session is closed"); }

  async #call(to: Address, data: Hex): Promise<Hex> {
    this.#assertOpen();
    const result = await this.#client.read(this.#client.identities.account(this.#account), this.config.chainId, "eth_call", [{ to, data }, "latest"]);
    if (typeof result !== "string" || !isHex(result)) throw new Error("Invalid swap contract response");
    this.#assertOpen();
    return result;
  }

  async #decrypt(handles: readonly { handle: Hex; contractAddress: Address }[]): Promise<bigint[]> {
    this.#assertOpen();
    const nonzero = handles.filter(({ handle }) => handle.toLowerCase() !== EMPTY_HANDLE);
    if (!nonzero.length) return handles.map(() => 0n);
    if (!this.#decryptSignature || Date.now() >= this.#decryptUntil) {
      const contracts = [this.config.batch, this.config.wrapperA, this.config.wrapperB];
      const authorization = await this.#fhe.prepareDecrypt(contracts);
      this.#assertOpen();
      this.#decryptSignature = await this.#signer.signDecrypt(authorization, contracts);
      this.#decryptUntil = Date.now() + 23 * 60 * 60 * 1000;
      this.#assertOpen();
    }
    const values = await this.#fhe.decrypt(nonzero, this.#decryptSignature);
    this.#assertOpen();
    return handles.map(({ handle }) => {
      if (handle.toLowerCase() === EMPTY_HANDLE) return 0n;
      const value = values[handle] ?? values[handle.toLowerCase() as Hex];
      if (typeof value !== "bigint") throw new Error("Unexpected confidential balance response");
      return value;
    });
  }

  async #view<T>(to: Address, abi: typeof batchAbi, functionName: string, args: readonly unknown[] = []): Promise<T> {
    const data = encodeFunctionData({ abi, functionName, args } as never);
    return decodeFunctionResult({ abi, functionName, data: await this.#call(to, data) } as never) as T;
  }

  async #blockTime(): Promise<bigint> {
    const block = (await this.#client.read(this.#client.identities.account(this.#account), this.config.chainId, "eth_getBlockByNumber", ["latest", false])) as { timestamp: string };
    return BigInt(block.timestamp);
  }

  async balances(): Promise<SwapBalances> {
    const tokens = [this.config.tokenA, this.config.tokenB] as const;
    const wrappers = [this.config.wrapperA, this.config.wrapperB] as const;
    const publicBalances = await Promise.all(tokens.map(async (token) => decodeFunctionResult({ abi: tokenAbi, functionName: "balanceOf", data: await this.#call(token, encodeFunctionData({ abi: tokenAbi, functionName: "balanceOf", args: [this.#account] })) })));
    const handles = await Promise.all(wrappers.map(async (wrapper, i) => ({
      wrapper: decodeFunctionResult({ abi: wrapperAbi, functionName: "confidentialBalanceOf", data: await this.#call(wrapper, encodeFunctionData({ abi: wrapperAbi, functionName: "confidentialBalanceOf", args: [this.#account] })) }),
      vault: decodeFunctionResult({ abi: batchAbi, functionName: "fundedBalance", data: await this.#call(this.config.batch, encodeFunctionData({ abi: batchAbi, functionName: "fundedBalance", args: [this.#account, i] })) }),
    })));
    const [wrappedA, wrappedB, vaultA, vaultB] = await this.#decrypt([
      { handle: handles[0]!.wrapper, contractAddress: wrappers[0] }, { handle: handles[1]!.wrapper, contractAddress: wrappers[1] },
      { handle: handles[0]!.vault, contractAddress: this.config.batch }, { handle: handles[1]!.vault, contractAddress: this.config.batch },
    ]);
    const round = decodeFunctionResult({ abi: batchAbi, functionName: "currentRound", data: await this.#call(this.config.batch, encodeFunctionData({ abi: batchAbi, functionName: "currentRound" })) });
    const [submitters, lastUpdate, duration, minSubmitters, refundDelay, maxAge, price, chainTime] = await Promise.all([
      this.#call(this.config.batch, encodeFunctionData({ abi: batchAbi, functionName: "distinctSubmitters" })).then((data) => decodeFunctionResult({ abi: batchAbi, functionName: "distinctSubmitters", data })),
      this.#call(this.config.batch, encodeFunctionData({ abi: batchAbi, functionName: "lastUpdateTime" })).then((data) => decodeFunctionResult({ abi: batchAbi, functionName: "lastUpdateTime", data })),
      this.#call(this.config.batch, encodeFunctionData({ abi: batchAbi, functionName: "minRoundDuration" })).then((data) => decodeFunctionResult({ abi: batchAbi, functionName: "minRoundDuration", data })),
      this.#call(this.config.batch, encodeFunctionData({ abi: batchAbi, functionName: "minDistinctSubmitters" })).then((data) => decodeFunctionResult({ abi: batchAbi, functionName: "minDistinctSubmitters", data })),
      this.#call(this.config.batch, encodeFunctionData({ abi: batchAbi, functionName: "refundDelay" })).then((data) => decodeFunctionResult({ abi: batchAbi, functionName: "refundDelay", data })),
      this.#call(this.config.batch, encodeFunctionData({ abi: batchAbi, functionName: "maxPriceAge" })).then((data) => decodeFunctionResult({ abi: batchAbi, functionName: "maxPriceAge", data })),
      this.#call(this.config.batch, encodeFunctionData({ abi: batchAbi, functionName: "roundPrices", args: [round] })).then((data) => decodeFunctionResult({ abi: batchAbi, functionName: "roundPrices", data })),
      this.#blockTime(),
    ]);
    let lotA = price[0], lotB = price[1];
    let maxLots = price[2];
    let validUntil = price[3];
    let priceError: string | undefined;
    if (lotA === 0n) {
      try {
        const quote = decodeFunctionResult({ abi: oracleAbi, functionName: "latestLotPrice", data: await this.#call(this.config.oracle, encodeFunctionData({ abi: oracleAbi, functionName: "latestLotPrice" })) });
        lotA = quote[0]; lotB = quote[1];
        if (lotA === 0n || lotB === 0n || quote[2] === 0n || quote[2] > chainTime) throw new Error("Invalid swap price");
        validUntil = quote[2] + maxAge;
        maxLots = MAX_U64 / 6n / (lotA > lotB ? lotA : lotB);
        if (validUntil < chainTime + duration || maxLots === 0n) throw new Error("Swap price is stale or unavailable");
      } catch (error) {
        lotA = 0n; lotB = 0n; maxLots = 0n; validUntil = 0n;
        priceError = error instanceof Error ? error.message : String(error);
      }
    } else if (chainTime > validUntil) {
      priceError = "Swap round price has expired";
    }
    return { public: [publicBalances[0]!, publicBalances[1]!], wrapped: [wrappedA!, wrappedB!], vault: [vaultA!, vaultB!], round, submitters, minSubmitters, closesAt: lastUpdate + duration, refundDelay, lotA, lotB, priceValidUntil: validUntil || undefined, maxLots, chainTime, ...(priceError ? { priceError } : {}) };
  }

  /**
   * The lifecycle of this user's order in the current round, and in the most
   * recent closed round, read from public on-chain state only. It never decrypts
   * the order and never guesses a payout.
   */
  async orderStatus(round = this.#lastKnownRound): Promise<SwapOrderStatus> {
    this.#assertOpen();
    const current = await this.#view<bigint>(this.config.batch, batchAbi, "currentRound");
    const target = round !== undefined && round < current ? round : current;
    this.#lastKnownRound = target;
    const [submitted, credited, refunded] = await this.#view<[boolean, boolean, boolean]>(this.config.batch, batchAbi, "orderStatus", [target, this.#account]);
    if (!submitted) {
      return { round: target, phase: "none", closesIn: 0n, canOrder: true, canRefund: false, detail: `No order in round ${target}.` };
    }
    if (refunded) return { round: target, phase: "refunded", closesIn: 0n, canOrder: false, canRefund: false, detail: `Order in round ${target} was refunded back into your confidential balance.` };
    if (credited) return { round: target, phase: "settled", closesIn: 0n, canOrder: false, canRefund: false, detail: `Round ${target} settled; your payout is in your confidential balance.` };
    const [closed, prepared, executed, isRefundable, closedAtBlock, lastUpdate, duration, refundDelay, chainTime] = await Promise.all([
      this.#roundFlag(target, 4),
      this.#roundFlag(target, 5),
      this.#roundFlag(target, 6),
      this.#view<boolean>(this.config.batch, batchAbi, "refundable", [target]),
      this.#view<bigint>(this.config.batch, batchAbi, "closedAt", [target]),
      this.#view<bigint>(this.config.batch, batchAbi, "lastUpdateTime"),
      this.#view<bigint>(this.config.batch, batchAbi, "minRoundDuration"),
      this.#view<bigint>(this.config.batch, batchAbi, "refundDelay"),
      this.#blockTime(),
    ]);
    const opensAt = lastUpdate + duration;
    const closesIn = opensAt > chainTime ? opensAt - chainTime : 0n;
    if (isRefundable || (!executed && closed && chainTime > closedAtBlock + refundDelay)) {
      return { round: target, phase: "refundable", closesIn: 0n, canOrder: false, canRefund: true, detail: `Round ${target} did not settle in time. You can claim your order back into your confidential balance.` };
    }
    if (!closed) {
      return { round: target, phase: "open", closesIn, canOrder: true, canRefund: false, detail: `Your order is in round ${target}. It can close in ${closesIn}s once enough participants have joined.` };
    }
    const stage = executed ? "settled" : prepared ? "awaiting settlement" : "awaiting the keeper's decryption";
    return { round: target, phase: "awaiting-settlement", closesIn: 0n, canOrder: false, canRefund: false, detail: `Round ${target} is closed and ${stage}.` };
  }

  #lastKnownRound: bigint | undefined;

  /** RoundState is a public struct; read one of its boolean flags by index. */
  async #roundFlag(roundId: bigint, index: number): Promise<boolean> {
    const result = await this.#view<readonly unknown[]>(this.config.batch, batchAbi, "rounds", [roundId]);
    return Boolean(result[index]);
  }

  /** Recover this user's order from an expired round. Permissionless, owner-credited. */
  refund(round: bigint, onStatus?: (status: string) => void): Promise<SentTx[]> {
    return this.#exclusive(async () => {
      const status = await this.orderStatus(round);
      if (!status.canRefund) throw new Error(status.detail);
      return this.#send([{ to: this.config.batch, value: 0n, data: encodeFunctionData({ abi: batchAbi, functionName: "refundOrder", args: [round, this.#account] }) }], onStatus);
    });
  }

  /** Credit a settled order's payout into the orderer's confidential balance. Permissionless. */
  credit(round: bigint, onStatus?: (status: string) => void): Promise<SentTx[]> {
    return this.#exclusive(async () => {
      return this.#send([{ to: this.config.batch, value: 0n, data: encodeFunctionData({ abi: batchAbi, functionName: "creditOrder", args: [round, this.#account] }) }], onStatus);
    });
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    this.#assertOpen();
    if (this.#running) throw new Error("A swap operation is already running");
    this.#running = true;
    try { return await operation(); } finally { this.#running = false; }
  }

  async #send(calls: Call[], onStatus?: (status: string) => void): Promise<SentTx[]> {
    this.#assertOpen();
    let receipts: SentTx[];
    try { receipts = await this.#signer.send(calls, onStatus); }
    catch (error) {
      if (error instanceof UnconfirmedError) throw new Error(`${error.message}. Its status is unknown; check the transaction and balances before retrying.`);
      throw error;
    }
    this.#assertOpen();
    if (receipts.length !== calls.length || receipts.some((receipt) => receipt.status !== "success")) throw new Error("A swap transaction reverted");
    return receipts;
  }

  /** Public ERC-20 to confidential wrapper; amount is six-decimal wrapper units. */
  wrap(asset: 0 | 1, amount: bigint, onStatus?: (status: string) => void): Promise<SentTx[]> {
    return this.#exclusive(async () => {
      if (amount <= 0n || amount > MAX_U64) throw new Error("Invalid amount");
      const token = asset === 0 ? this.config.tokenA : this.config.tokenB;
      const wrapper = asset === 0 ? this.config.wrapperA : this.config.wrapperB;
      const underlyingAmount = amount * RATE;
      const balance = decodeFunctionResult({ abi: tokenAbi, functionName: "balanceOf", data: await this.#call(token, encodeFunctionData({ abi: tokenAbi, functionName: "balanceOf", args: [this.#account] })) });
      if (balance < underlyingAmount) throw new Error("Not enough public tokens to wrap");
      const allowance = decodeFunctionResult({ abi: tokenAbi, functionName: "allowance", data: await this.#call(token, encodeFunctionData({ abi: tokenAbi, functionName: "allowance", args: [this.#account, wrapper] })) });
      const calls: Call[] = [];
      if (allowance < underlyingAmount) calls.push({ to: token, value: 0n, data: encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [wrapper, underlyingAmount] }) });
      calls.push({ to: wrapper, value: 0n, data: encodeFunctionData({ abi: wrapperAbi, functionName: "wrap", args: [this.#account, underlyingAmount] }) });
      return this.#send(calls, onStatus);
    });
  }

  /** Move existing wrapped tokens to the swap vault. */
  fund(asset: 0 | 1, amount: bigint, onStatus?: (status: string) => void): Promise<SentTx[]> {
    return this.#exclusive(async () => {
      if (amount <= 0n || amount > MAX_U64) throw new Error("Invalid amount");
      const wrapper = asset === 0 ? this.config.wrapperA : this.config.wrapperB;
      const balances = await this.balances();
      if (balances.wrapped[asset] < amount) throw new Error("Not enough confidential wrapped tokens");
      if (balances.vault[asset] > MAX_U64 - amount) throw new Error("Confidential vault balance would overflow");
      const encrypted = await this.#fhe.encrypt(wrapper, amount);
      if (encrypted.handles.length !== 1) throw new Error("Unexpected encrypted input");
      return this.#send([{ to: wrapper, value: 0n, data: encodeFunctionData({ abi: wrapperAbi, functionName: "confidentialTransferAndCall", args: [this.config.batch, encrypted.handles[0]!, encrypted.proof, "0x00"] }) }], onStatus);
    });
  }

  order(direction: 1 | 2, amount: bigint, minOutput: bigint, onStatus?: (status: string) => void): Promise<SentTx[]> {
    return this.#exclusive(async () => {
      if (amount <= 0n || amount > MAX_U64 || minOutput <= 0n || minOutput > MAX_U64) throw new Error("Invalid swap amount or minimum output");
      const balances = await this.balances();
      if (balances.priceError) throw new Error(balances.priceError);
      const inputLot = direction === 1 ? balances.lotA : balances.lotB;
      const outputLot = direction === 1 ? balances.lotB : balances.lotA;
      if (inputLot === 0n || outputLot === 0n || amount % inputLot !== 0n) throw new Error("Amount must be a whole number of price lots");
      if (amount / inputLot > balances.maxLots) throw new Error("Amount exceeds the maximum order size");
      if (balances.priceValidUntil === undefined || balances.chainTime > balances.priceValidUntil) throw new Error("Swap price is stale");
      if (balances.vault[direction - 1]! < amount) throw new Error("Not enough confidential vault balance");
      if (minOutput > amount / inputLot * outputLot * 9000n / 10000n) throw new Error("Minimum output exceeds the batch's guaranteed floor");
      const encrypted = await this.#fhe.encrypt(this.config.batch, amount, direction, minOutput);
      if (encrypted.handles.length !== 3) throw new Error("Unexpected encrypted order");
      return this.#send([{ to: this.config.batch, value: 0n, data: encodeFunctionData({ abi: batchAbi, functionName: "submitOrder", args: [encrypted.handles[0]!, encrypted.proof, encrypted.handles[1]!, encrypted.proof, encrypted.handles[2]!, encrypted.proof] }) }], onStatus);
    });
  }

  exit(asset: 0 | 1, amount: bigint, onStatus?: (status: string) => void): Promise<SentTx[]> {
    return this.#exclusive(async () => {
      if (amount <= 0n || amount > MAX_U64) throw new Error("Invalid amount");
      if ((await this.balances()).vault[asset] < amount) throw new Error("Not enough confidential vault balance");
      const encrypted = await this.#fhe.encrypt(this.config.batch, amount);
      if (encrypted.handles.length !== 1) throw new Error("Unexpected encrypted input");
      return this.#send([{ to: this.config.batch, value: 0n, data: encodeFunctionData({ abi: batchAbi, functionName: "exit", args: [asset, encrypted.handles[0]!, encrypted.proof] }) }], onStatus);
    });
  }
}
