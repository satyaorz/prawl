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

/** This wallet's own history, from the sealed local log. No explorer links: opening one would reveal your IP and which transaction is yours. */
export function ActivityCard() {
  const w = useWallet();
  if (!w.railgunAddress || !w.activity) return null;
  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
      <h2 className="text-sm font-medium">Activity</h2>
      <p className="mt-1 text-xs text-zinc-500">Kept encrypted on this device only. Copy a hash to look it up; there are no explorer links, since opening one would tell that site which transaction is yours.</p>
      {w.activity.length === 0 ? (
        <p className="mt-3 text-sm text-zinc-400">Nothing yet.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {w.activity.slice(0, 30).map((a) => (
            <li key={`${a.txHash}-${a.at}`} className="flex items-start justify-between gap-3 text-xs">
              <div className="min-w-0">
                <p className="text-zinc-300">
                  <span className={a.ok ? "text-emerald-400" : "text-red-400"}>{a.ok ? "✓" : "✗"}</span> {LABEL[a.kind] ?? a.kind}{" "}
                  <span className="font-mono">{formatEther(BigInt(a.amount))} ETH</span>
                </p>
                <p className="text-zinc-500">
                  {new Date(a.at).toLocaleString()}
                  {a.to ? <span className="font-mono"> · {short(a.to, 10, 6)}</span> : null}
                </p>
              </div>
              <CopyHash hash={a.txHash} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
