import { useState } from "react";
import { Home } from "./components/Home";
import { OfflineMode } from "./components/OfflineMode";
import { Settings } from "./components/Settings";
import { Icon, Identicon, Logo, Sheet, short } from "./components/ui";
import { Welcome } from "./components/Welcome";
import { useTor } from "./lib/use-tor";
import { useWallet } from "./lib/use-wallet";
import { lockWallet } from "./lib/wallet";

type Mode = "online" | "offline";

/**
 * A wallet-app shell: a phone-width panel (centred on a desktop), a header with
 * the network and the account, and two modes, Online (the private wallet over
 * Tor) and Offline (coins for paying another phone with no network).
 * Both modes stay mounted: a handoff link from the phone, a running action and
 * the history survive switching; the inactive one is only hidden.
 */
export function App() {
  const w = useWallet();
  const tor = useTor();
  const unlocked = !!w.railgunAddress;
  const [mode, setMode] = useState<Mode>("online");
  const [settings, setSettings] = useState(false);
  const showOnline = unlocked && mode === "online";
  const showOffline = !unlocked || mode === "offline";

  return (
    <div className="flex min-h-full justify-center bg-black sm:py-6">
      <main className="relative flex min-h-full w-full max-w-[420px] flex-col bg-zinc-950 sm:min-h-[780px] sm:rounded-3xl sm:border sm:border-zinc-800">
        {unlocked && (
          <header className="px-5 pb-1 pt-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Logo className="h-7 w-7" />
                <span className="text-base font-semibold tracking-tight">Prawl</span>
              </div>
              <span
                className="inline-flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900 px-3 py-1 text-xs text-zinc-300"
                title={tor.phase === "ready" ? "Connected over Tor" : tor.phase === "failed" ? "Tor failed" : "Connecting to Tor"}
              >
                <span className={`h-2 w-2 rounded-full ${tor.phase === "ready" ? "bg-emerald-400" : tor.phase === "failed" ? "bg-red-500" : "animate-pulse bg-amber-400"}`} />
                Sepolia
              </span>
              <div className="flex items-center gap-1.5">
                <button onClick={() => void lockWallet()} aria-label="Lock" title="Lock" className="rounded-full p-2 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100">
                  <Icon name="lock" className="h-[18px] w-[18px]" />
                </button>
                <button onClick={() => setSettings(true)} aria-label="Account and settings" title="Account and settings" className="flex items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-900 py-1 pl-1 pr-2.5 hover:bg-zinc-800">
                  {w.evmAddress && <Identicon seed={w.evmAddress} className="h-6 w-6" />}
                  <span className="font-mono text-xs text-zinc-300">{w.evmAddress ? short(w.evmAddress, 4, 4) : ""}</span>
                </button>
              </div>
            </div>

            <div role="tablist" aria-label="Mode" className="mt-4 grid grid-cols-2 rounded-full bg-zinc-900 p-1 text-sm">
              {(["online", "offline"] as const).map((m) => (
                <button
                  key={m}
                  role="tab"
                  aria-selected={mode === m}
                  onClick={() => setMode(m)}
                  className={`flex items-center justify-center gap-2 rounded-full py-1.5 capitalize transition ${
                    mode === m ? (m === "online" ? "bg-emerald-500 font-semibold text-zinc-950" : "bg-amber-500 font-semibold text-zinc-950") : "text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  <Icon name={m === "online" ? "wallet" : "offline"} className="h-4 w-4" />
                  {m}
                </button>
              ))}
            </div>
          </header>
        )}

        <div className="flex-1 pb-6 pt-3">
          {!unlocked && <Welcome />}
          <div className={showOnline ? "" : "hidden"}>
            <Home />
          </div>
          <div className={showOffline ? "" : "hidden"}>
            <OfflineMode onOpened={() => setMode("offline")} />
          </div>
        </div>

        <Sheet open={settings} title="Account and settings" onClose={() => setSettings(false)}>
          <Settings onClose={() => setSettings(false)} />
        </Sheet>
      </main>
    </div>
  );
}
