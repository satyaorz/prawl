import { useSyncExternalStore } from "react";
import { torStatus, type TorStatus } from "./anon";

export function useTor(): TorStatus {
  return useSyncExternalStore(torStatus.subscribe, torStatus.get);
}
