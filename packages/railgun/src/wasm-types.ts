/**
 * The part of kohaku-railgun-wasm's generated bindings that Prawl uses
 * (kohaku_railgun_wasm.d.ts, wasm-bindgen 0.2.108). The bindings are built
 * locally (scripts/build-wasm.sh) and injected, so tests can pass a fake.
 */
export type Hex = `0x${string}`;

export interface Call {
  to: Hex;
  data: Hex;
  value: bigint;
}

export interface WasmChain {
  free(): void;
  readonly chainId: bigint;
  readonly deploymentBlock: bigint;
  readonly poiEndpoint: string;
  readonly poiStartBlock: bigint;
  readonly railgunSmartWallet: string;
  readonly subsquidEndpoint: string;
  readonly unshieldFeeBps: number;
  readonly wrappedBaseToken: string;
}

export interface WasmRailgunAddress {
  free(): void;
  toString(): string;
}

export interface WasmShield {
  free(): void;
  addErc20(recipient: WasmRailgunAddress, token: Hex, amount: bigint): void;
  addNative(recipient: WasmRailgunAddress, amount: bigint): void;
  build(): Call[];
}

export interface WasmPoiSession {
  free(): void;
  readonly address: string;
  readonly syncedBlock: bigint;
  balancesJson(): Promise<string>;
  notesJson(): Promise<string>;
  checkpointJson(): string;
  poiPendingJson(): string;
  poiListKeysJson(): string;
  syncWithoutPoiSubmission(): Promise<void>;
  syncToWithoutPoiSubmission(block: bigint): Promise<void>;
  refreshPoi(): Promise<void>;
  processPendingPoiJson(): Promise<string>;
  prepareTransferUserOpJson(
    recipient: WasmRailgunAddress,
    token: string,
    amount: bigint,
    memo: string,
    accountPrivateKey: string,
    bundlerUrl: string,
  ): Promise<string>;
  prepareUnshieldUserOpJson(
    recipient: string,
    token: string,
    amount: bigint,
    unwrapNative: boolean,
    tailCallsJson: string,
    accountPrivateKey: string,
    bundlerUrl: string,
  ): Promise<string>;
}

export interface RailgunWasm {
  Chain: {
    mainnet(): WasmChain;
    sepolia(): WasmChain;
    fromChainId(chainId: bigint): WasmChain | undefined;
  };
  RailgunAddress: {
    parse(text: string): WasmRailgunAddress;
    fromPrivateKeys(spendingKey: Hex, viewingKey: Hex, chainId: bigint): WasmRailgunAddress;
  };
  Shield: new (chain: WasmChain) => WasmShield;
  PoiSession: {
    open(
      chain: WasmChain,
      rpcUrl: string,
      spendingKey: string,
      viewingKey: string,
      checkpointJson?: string | null,
      artifactBaseUrl?: string | null,
    ): Promise<WasmPoiSession>;
  };
}
