import { useSyncExternalStore } from "react";
import { walletState, type WalletState } from "./wallet";

export function useWallet(): WalletState {
  return useSyncExternalStore(walletState.subscribe, walletState.get);
}
