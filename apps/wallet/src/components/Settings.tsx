import { useWallet } from "../lib/use-wallet";
import { lockWallet, rescanWallet } from "../lib/wallet";
import { Identicon } from "./ui";
import { TorStatusCard } from "./TorStatusCard";
import { TraceList } from "./TraceList";
import { WatchAddress } from "./WatchAddress";

/** Account and network details, behind the account chip. */
export function Settings({ onClose }: { onClose: () => void }) {
  const w = useWallet();
  const busy = w.phase === "syncing" || w.phase === "opening";
  return (
    <div className="flex flex-col gap-5">
      {w.evmAddress && w.railgunAddress && (
        <section>
          <div className="flex items-center gap-3">
            <Identicon seed={w.evmAddress} className="h-10 w-10" />
            <div className="min-w-0">
              <p className="text-sm font-medium">Account 1</p>
              <p className="text-xs text-zinc-500">Created with your passkey</p>
            </div>
          </div>
          <dl className="mt-3 space-y-2 text-xs">
            <div>
              <dt className="text-zinc-500">Private address (0zk): share it to be paid privately</dt>
              <dd className="mt-0.5 break-all font-mono text-zinc-300">{w.railgunAddress}</dd>
            </div>
            <div>
              <dt className="text-zinc-500">Public account: the way in and out</dt>
              <dd className="mt-0.5 break-all font-mono text-zinc-300">{w.evmAddress}</dd>
            </div>
          </dl>
          <div className="mt-3 flex gap-2">
            <button
              disabled={busy}
              onClick={() => {
                if (confirm("Scan all RAILGUN history again from the start? This takes a few minutes over Tor.")) {
                  onClose();
                  void rescanWallet();
                }
              }}
              className="rounded-full border border-zinc-700 px-4 py-1.5 text-xs text-zinc-300 hover:bg-zinc-900 disabled:opacity-50"
            >
              Full rescan
            </button>
            <button
              onClick={() => {
                onClose();
                void lockWallet();
              }}
              className="rounded-full border border-zinc-700 px-4 py-1.5 text-xs text-zinc-300 hover:bg-zinc-900"
            >
              Lock wallet
            </button>
          </div>
        </section>
      )}
      <TorStatusCard />
      <WatchAddress />
      <TraceList />
    </div>
  );
}
