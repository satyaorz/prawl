import { useState } from "react";
import { formatEther } from "viem";
import { useWallet } from "../lib/use-wallet";
import { createWallet, lockWallet, rescanWallet, sync, unlockWallet } from "../lib/wallet";

function short(s: string, head = 10, tail = 8): string {
  return s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s;
}

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="text-xs text-zinc-400 hover:text-zinc-200"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
    >
      {done ? "copied" : "copy"}
    </button>
  );
}

/** What each PPOI status means for the user. */
const POI_LABEL: Record<string, { text: string; tone: string }> = {
  Valid: { text: "spendable", tone: "text-emerald-400" },
  Missing: { text: "PPOI check pending", tone: "text-amber-400" },
  ProofSubmitted: { text: "PPOI proof sent", tone: "text-amber-400" },
  ShieldBlocked: { text: "blocked by PPOI", tone: "text-red-400" },
  Unavailable: { text: "PPOI node unreachable", tone: "text-zinc-500" },
};

export function WalletCard() {
  const w = useWallet();
  const busy = w.phase === "unlocking" || (w.phase === "opening" && !w.railgunAddress);

  if (w.phase === "locked" || (w.phase === "error" && !w.railgunAddress) || busy) {
    return (
      <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
        <h2 className="text-sm font-medium">Your private wallet</h2>
        <p className="mt-1 text-xs text-zinc-500">
          Keys come from a passkey on this device. No seed phrase, no server. The same passkey on another device restores the wallet.
        </p>
        <div className="mt-4 flex gap-2">
          {w.hasPasskey ? (
            <button disabled={busy} onClick={() => void unlockWallet()} className="rounded-lg bg-emerald-400 px-4 py-2 text-sm font-medium text-zinc-950 disabled:opacity-50">
              {busy ? "Opening…" : "Unlock with passkey"}
            </button>
          ) : (
            <>
              <button disabled={busy} onClick={() => void createWallet()} className="rounded-lg bg-emerald-400 px-4 py-2 text-sm font-medium text-zinc-950 disabled:opacity-50">
                {busy ? "Opening…" : "Create wallet"}
              </button>
              <button disabled={busy} onClick={() => void unlockWallet()} className="rounded-lg border border-zinc-700 px-4 py-2 text-sm disabled:opacity-50">
                Restore with passkey
              </button>
            </>
          )}
        </div>
        {w.error && <p className="mt-3 text-xs text-red-400">{w.error}</p>}
      </section>
    );
  }

  const eth = (w.balances ?? []).filter((b) => b.token !== undefined && b.token === w.wrappedBaseToken);
  const ethTotal = eth.reduce((sum, b) => sum + BigInt(b.amount), 0n);
  const ethValid = eth.filter((b) => b.poiStatus === "Valid").reduce((sum, b) => sum + BigInt(b.amount), 0n);
  const span = w.head !== undefined && w.deploymentBlock !== undefined ? Number(w.head - w.deploymentBlock) : 0;
  const done = w.syncedBlock !== undefined && w.deploymentBlock !== undefined ? Number(w.syncedBlock - w.deploymentBlock) : 0;
  const pct = span > 0 ? Math.max(0, Math.min(100, (done / span) * 100)) : 0;

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Private balance · Sepolia</h2>
        <button onClick={() => void lockWallet()} className="text-xs text-zinc-400 hover:text-zinc-200">
          Lock
        </button>
      </div>

      {(w.phase === "syncing" || w.phase === "opening") && (
        <div className="mt-3">
          <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
            <div className="h-full bg-emerald-400 transition-all" style={{ width: `${pct}%` }} />
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            Scanning the private pool over Tor
            {w.restored
              ? " from your saved checkpoint"
              : w.replayFrom
                ? " from the pool snapshot, replaying since your wallet was created"
                : w.snapshotBlock
                ? " from the latest pool snapshot"
                : w.fullScan
                  ? " from the start of RAILGUN history (first open on this device)"
                  : ""}
            … {pct.toFixed(0)}%
          </p>
        </div>
      )}

      {w.balances && w.balances.length > 0 && (
        <div className="mt-3">
          <p className="font-mono text-3xl">
            {formatEther(ethTotal)} <span className="text-base text-zinc-500">ETH</span>
          </p>
          <p className="mt-0.5 text-xs text-zinc-500">
            {formatEther(ethValid)} spendable{ethTotal > ethValid ? ` · ${formatEther(ethTotal - ethValid)} waiting for the PPOI check` : ""}
          </p>
        </div>
      )}

      {w.balances && (
        <ul className="mt-3 space-y-1">
          {w.balances.length === 0 && <li className="text-sm text-zinc-400">No private funds yet.</li>}
          {w.balances.map((b) => (
            <li key={`${b.asset}-${b.poiStatus}`} className="flex justify-between font-mono text-sm">
              <span className="text-zinc-400">{b.token && b.token === w.wrappedBaseToken ? "ETH" : short(b.token ?? b.asset, 6, 4)}</span>
              <span>
                {formatEther(BigInt(b.amount))}{" "}
                {b.poiStatus && (
                  <span className={`text-xs ${POI_LABEL[b.poiStatus]?.tone ?? "text-zinc-500"}`}>{POI_LABEL[b.poiStatus]?.text ?? b.poiStatus}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {w.balances?.some((b) => b.poiStatus === "Missing") && (
        <p className="mt-2 text-xs text-zinc-500">
          New shields wait for the PPOI check (a few minutes on Sepolia, up to an hour on mainnet) before they can be sent or withdrawn. The wallet refreshes on its own.
        </p>
      )}
      {!!w.poiQueue && (
        <p className="mt-2 text-xs text-zinc-500">
          {w.poiQueue} PPOI proof{w.poiQueue > 1 ? "s" : ""} queued for your last private transaction; retried on every refresh.
          {w.poiError && <span className="block text-amber-400/80">Last attempt: {w.poiError}</span>}
        </p>
      )}

      <dl className="mt-4 grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1.5 text-xs">
        <dt className="text-zinc-500">Private address</dt>
        <dd className="truncate font-mono text-zinc-300">{w.railgunAddress && short(w.railgunAddress, 14, 10)}</dd>
        <dd>{w.railgunAddress && <Copy text={w.railgunAddress} />}</dd>
        <dt className="text-zinc-500">Public account</dt>
        <dd className="truncate font-mono text-zinc-300">{w.evmAddress && short(w.evmAddress)}</dd>
        <dd>{w.evmAddress && <Copy text={w.evmAddress} />}</dd>
      </dl>

      <div className="mt-4 flex items-center gap-3">
        <button disabled={w.phase === "syncing"} onClick={() => void sync()} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs disabled:opacity-50">
          {w.phase === "syncing" ? "Syncing…" : "Refresh"}
        </button>
        {w.lastSyncMs !== undefined && w.phase === "ready" && <span className="text-xs text-zinc-500">synced in {(w.lastSyncMs / 1000).toFixed(1)} s</span>}
        <button
          disabled={w.phase === "syncing" || w.phase === "opening"}
          onClick={() => {
            if (confirm("Scan all RAILGUN history again from the start? This takes a few minutes over Tor.")) void rescanWallet();
          }}
          className="ml-auto text-xs text-zinc-500 hover:text-zinc-300 disabled:opacity-50"
        >
          Full rescan
        </button>
      </div>
      {w.error && <p className="mt-3 text-xs text-red-400">{w.error}</p>}
    </section>
  );
}
