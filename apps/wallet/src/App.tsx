import { useState } from "react";
import { ActivityCard } from "./components/ActivityCard";
import { Intro } from "./components/Intro";
import { OfflineCard } from "./components/OfflineCard";
import { PrivateActions } from "./components/PrivateActions";
import { ReceiveCard } from "./components/ReceiveCard";
import { ShieldForm } from "./components/ShieldForm";
import { TorStatusCard } from "./components/TorStatusCard";
import { TraceList } from "./components/TraceList";
import { WalletCard } from "./components/WalletCard";
import { WatchAddress } from "./components/WatchAddress";
import { useWallet } from "./lib/use-wallet";

type Tab = "wallet" | "offline" | "activity" | "network";
const TABS: ReadonlyArray<readonly [Tab, string]> = [
  ["wallet", "Wallet"],
  ["offline", "Offline cash"],
  ["activity", "Activity"],
  ["network", "Network"],
];

/**
 * Every panel stays mounted (a handoff link, a running action and the history
 * must survive switching tabs); the inactive ones are only hidden.
 * Locked, there are no tabs: the wallet card, the intro, a handoff link if one
 * was opened, and the Tor status.
 */
export function App() {
  const w = useWallet();
  const unlocked = !!w.railgunAddress;
  const [tab, setTab] = useState<Tab>("wallet");
  const on = (t: Tab) => (unlocked ? tab === t : t === "wallet" || t === "offline" || t === "network");
  const panel = (t: Tab) => `flex flex-col gap-4 ${on(t) ? "" : "hidden"}`;

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-4 px-4 py-8 sm:py-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Prawl</h1>
        <p className="text-sm text-zinc-400">Private by default. Every request goes over Tor.</p>
      </header>

      {unlocked && (
        <nav role="tablist" aria-label="Sections" className="flex gap-1 rounded-xl border border-zinc-800 bg-zinc-900/60 p-1 text-sm">
          {TABS.map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={`flex-1 whitespace-nowrap rounded-lg px-2 py-1.5 ${tab === id ? "bg-zinc-800 font-medium text-zinc-100" : "text-zinc-500 hover:text-zinc-300"}`}
            >
              {label}
            </button>
          ))}
        </nav>
      )}

      <div className={panel("wallet")}>
        <WalletCard />
        {!unlocked && <Intro />}
        <ShieldForm />
        <PrivateActions />
        <ReceiveCard />
      </div>
      <div className={panel("offline")}>
        <OfflineCard onOpened={() => setTab("offline")} />
      </div>
      <div className={panel("activity")}>
        <ActivityCard />
      </div>
      <div className={panel("network")}>
        <TorStatusCard />
        <WatchAddress />
        <TraceList />
      </div>
    </main>
  );
}
