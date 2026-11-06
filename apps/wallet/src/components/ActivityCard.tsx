import { useState } from "react";
import { formatEther } from "viem";
import type { Activity } from "../lib/activity";
import { useWallet } from "../lib/use-wallet";

const LABEL: Record<Activity["kind"], string> = {
  shield: "Shielded",
  send: "Sent privately",
  unshield: "Withdrew",
  "public-send": "Sent publicly",
  "offline-load": "Loaded offline coin",
  "offline-redeem": "Cashed out offline",
};

const short = (s: string, a = 8, b = 6) => (s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s);

function CopyHash({ hash }: { hash: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      title="Copy transaction hash"
      className="font-mono text-zinc-500 hover:text-zinc-300"
      onClick={() => void navigator.clipboard.writeText(hash).then(() => (setDone(true), setTimeout(() => setDone(false), 1200)))}
    >
      {done ? "copied" : short(hash)}
    </button>
  );
}

/** The list itself (also used inside the home screen). No explorer links: opening one would reveal your IP and which transaction is yours. */
export function ActivityList({ kinds }: { kinds?: ReadonlyArray<Activity["kind"]> }) {
  const w = useWallet();
  const items = (w.activity ?? []).filter((a) => !kinds || kinds.includes(a.kind));
  if (!w.activity) return null;
  return items.length === 0 ? (
    <p className="py-6 text-center text-sm text-zinc-500">Nothing yet.</p>
  ) : (
    <ul className="divide-y divide-zinc-900">
      {items.slice(0, 40).map((a) => (
        <li key={`${a.txHash}-${a.at}`} className="flex items-center gap-3 py-3 text-xs">
          <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm ${a.ok ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"}`}>{a.ok ? "✓" : "✗"}</span>
          <div className="min-w-0 flex-1">
            <p className="text-sm text-zinc-200">{LABEL[a.kind] ?? a.kind}</p>
            <p className="truncate text-zinc-500">
              {new Date(a.at).toLocaleString()}
              {a.to ? <span className="font-mono"> · {short(a.to, 10, 6)}</span> : null}
            </p>
          </div>
          <div className="text-right">
            <p className="font-mono text-sm text-zinc-200">{formatEther(BigInt(a.amount))} ETH</p>
            <CopyHash hash={a.txHash} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** This wallet's own history as a card. */
export function ActivityCard() {
  const w = useWallet();
  if (!w.railgunAddress || !w.activity) return null;
  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
      <h2 className="text-sm font-medium">Activity</h2>
      <p className="mt-1 text-xs text-zinc-500">Kept encrypted on this device only. Copy a hash to look it up; there are no explorer links.</p>
      <ActivityList />
    </section>
  );
}
