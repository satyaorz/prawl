import { useState } from "react";
import { PrivateActions } from "./PrivateActions";
import { PublicSendForm } from "./PublicSendForm";

type Tab = "private" | "public";

/** The Send sheet: a private send to a 0zk address, or a public send of ETH from the public account to any 0x address. */
export function SendSheet() {
  const [tab, setTab] = useState<Tab>("private");
  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="Send" className="grid grid-cols-2 gap-1 rounded-full bg-zinc-900 p-1 text-xs">
        {(["private", "public"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`rounded-full px-3 py-1.5 ${tab === t ? "bg-emerald-500 font-semibold text-zinc-950" : "text-zinc-300"}`}>
            {t === "private" ? "Private (0zk…)" : "Public (0x…)"}
          </button>
        ))}
      </div>
      {tab === "private" ? <PrivateActions mode="send" /> : <PublicSendForm />}
    </div>
  );
}
