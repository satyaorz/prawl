import { useState } from "react";
import { useWallet } from "../lib/use-wallet";
import { ActivityList } from "./ActivityCard";
import { OfflineCard } from "./OfflineCard";
import { PhoneBridgePanel } from "./PhoneBridgePanel";
import { ReclaimAccounts } from "./ReclaimAccounts";
import { Icon } from "./ui";

const STEPS: ReadonlyArray<readonly [string, string]> = [
  ["Load", "Scan the phone's QR (or paste its link) and fund the coin from your public account or privately from your private balance."],
  ["Pay", "On the phone, over Bluetooth, with no internet at all. The coin's key can sign once, enforced by the phone's secure hardware."],
  ["Cash out", "Scan the phone's cash-out QR: to a public address or straight into your private balance. Refresh a coin before it expires."],
];

/**
 * Offline mode. The paying itself happens on the Prawl Android app (it needs a
 * hardware key that signs once); this side loads coins, cashes them out and
 * refreshes them. Everything here works from links and QR codes.
 */
export function OfflineMode({ onOpened }: { onOpened: () => void }) {
  const w = useWallet();
  const unlocked = !!w.railgunAddress;
  // A payload the phone bridge returned: the card below opens it like a scanned code.
  const [incoming, setIncoming] = useState<{ link: string; n: number; own?: boolean }>();
  return (
    <div className="flex flex-col gap-4 px-5 pb-6">
      {unlocked && (
        <>
          <section className="rounded-2xl border border-amber-900/50 bg-amber-950/20 p-4">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-amber-400">
                <Icon name="offline" className="h-5 w-5" />
              </span>
              <div>
                <h2 className="text-sm font-semibold">Offline mode</h2>
                <p className="text-xs text-zinc-400">Pay another phone with no network.</p>
              </div>
            </div>
            <ol className="mt-3 space-y-2.5">
              {STEPS.map(([title, text], i) => (
                <li key={title} className="flex gap-3 text-xs">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-[11px] font-medium text-zinc-300">{i + 1}</span>
                  <span className="text-zinc-400">
                    <span className="font-medium text-zinc-200">{title}.</span> {text}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        </>
      )}

      {unlocked && <PhoneBridgePanel onPayload={(link, opts) => setIncoming({ link, n: Date.now(), ...(opts?.own ? { own: true } : {}) })} />}

      <OfflineCard onOpened={onOpened} incoming={incoming} />

      {unlocked && <ReclaimAccounts />}

      {unlocked && (
        <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
          <h2 className="text-sm font-medium">Offline activity</h2>
          <ActivityList kinds={["offline-load", "offline-redeem"]} />
        </section>
      )}
    </div>
  );
}
