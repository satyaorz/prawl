import { useState } from "react";
import { formatEther } from "viem";
import { useWallet } from "../lib/use-wallet";
import { clearFinishedAction, sync } from "../lib/wallet";
import { ActivityList } from "./ActivityCard";
import { PrivateActions } from "./PrivateActions";
import { ReceiveCard } from "./ReceiveCard";
import { ShieldForm } from "./ShieldForm";
import { SwapDashboard } from "./SwapDashboard";
import { ActionButton, EthIcon, Icon, Sheet, short, fmtEthShort } from "./ui";

type SheetName = "receive" | "shield" | "send" | "withdraw" | "swap";
const TITLE: Record<SheetName, string> = { receive: "Receive", shield: "Add funds (shield)", send: "Send privately", withdraw: "Withdraw to public", swap: "Private swap" };

/** What each PPOI status means for the user. */
const POI_LABEL: Record<string, { text: string; tone: string }> = {
  Valid: { text: "spendable", tone: "text-emerald-400" },
  Missing: { text: "PPOI check pending", tone: "text-amber-400" },
  ProofSubmitted: { text: "PPOI proof sent", tone: "text-amber-400" },
  ShieldBlocked: { text: "blocked by PPOI", tone: "text-red-400" },
  Unavailable: { text: "PPOI node unreachable", tone: "text-zinc-500" },
};

function CopyChip({ label, value }: { label: string; value: string }) {
  const [done, setDone] = useState(false);
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-zinc-900 py-1 pl-3 pr-2 text-xs text-zinc-400">
      {label} <span className="font-mono text-zinc-300">{short(value, 8, 6)}</span>
      <button
        aria-label={`Copy ${label} address`}
        className="rounded-full p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
        onClick={() =>
          void navigator.clipboard.writeText(value).then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1200);
          })
        }
      >
        {done ? <Icon name="check" className="h-3.5 w-3.5 text-emerald-400" /> : <Icon name="copy" className="h-3.5 w-3.5" />}
        <span className="sr-only">copy</span>
      </button>
    </span>
  );
}

/** The wallet home: balance, the four things you do, then your assets and your activity. */
export function Home() {
  const w = useWallet();
  const [sheet, setSheet] = useState<SheetName>();
  const [tab, setTab] = useState<"assets" | "activity">("assets");
  const open = (s: SheetName) => {
    clearFinishedAction();
    setSheet(s);
  };

  const eth = (w.balances ?? []).filter((b) => b.token !== undefined && b.token === w.wrappedBaseToken);
  const total = eth.reduce((sum, b) => sum + BigInt(b.amount), 0n);
  const valid = eth.filter((b) => b.poiStatus === "Valid").reduce((sum, b) => sum + BigInt(b.amount), 0n);
  const others = (w.balances ?? []).filter((b) => !(b.token !== undefined && b.token === w.wrappedBaseToken));
  const syncing = w.phase === "syncing" || w.phase === "opening";
  const span = w.head !== undefined && w.deploymentBlock !== undefined ? Number(w.head - w.deploymentBlock) : 0;
  const done = w.syncedBlock !== undefined && w.deploymentBlock !== undefined ? Number(w.syncedBlock - w.deploymentBlock) : 0;
  const pct = span > 0 ? Math.max(0, Math.min(100, (done / span) * 100)) : 0;
  const ready = w.phase === "ready";
  const banner = w.action && (w.action.kind === "shield" || w.action.kind === "send" || w.action.kind === "unshield" || w.action.kind === "public-send") && !sheet ? w.action : undefined;

  return (
    <div className="flex flex-col gap-4">
      <section className="px-5 pt-2 text-center">
        {syncing && (
          <div className="mb-3">
            <div className="h-1 overflow-hidden rounded-full bg-zinc-800">
              <div className="h-full bg-emerald-400 transition-all" style={{ width: `${pct}%` }} />
            </div>
            <p className="mt-1.5 text-xs text-zinc-500">
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

        <p className="text-xs text-zinc-500">Private balance · Sepolia</p>
        <p className="mt-1 break-all font-mono text-4xl font-semibold tracking-tight" title={w.balances ? `${formatEther(total)} ETH` : undefined}>
          {w.balances ? fmtEthShort(total) : "…"} <span className="text-lg font-normal text-zinc-500">ETH</span>
        </p>
        <p className="mt-1 break-all text-xs text-zinc-500">
          {w.balances
            ? total === 0n
              ? "No private funds yet."
              : `${formatEther(valid)} spendable${total > valid ? ` · ${formatEther(total - valid)} waiting for the PPOI check` : ""}`
            : "Loading…"}
        </p>

        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <ActionButton icon="receive" label="Receive" onClick={() => open("receive")} />
          <ActionButton icon="shield" label="Shield" onClick={() => open("shield")} />
          <ActionButton icon="send" label="Send" onClick={() => open("send")} />
          <ActionButton icon="withdraw" label="Withdraw" onClick={() => open("withdraw")} />
          <ActionButton icon="swap" label="Swap" onClick={() => open("swap")} />
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          {w.railgunAddress && <CopyChip label="Private" value={w.railgunAddress} />}
          {w.evmAddress && <CopyChip label="Public" value={w.evmAddress} />}
        </div>

        <div className="mt-3 flex items-center justify-center gap-3 text-xs text-zinc-500">
          <button disabled={syncing} onClick={() => void sync()} className="inline-flex items-center gap-1.5 rounded-full border border-zinc-800 px-3 py-1 text-zinc-300 hover:bg-zinc-900 disabled:opacity-50">
            <Icon name="refresh" className={`h-3.5 w-3.5 ${syncing ? "animate-spin" : ""}`} />
            {syncing ? "Syncing…" : "Refresh"}
          </button>
          {w.lastSyncMs !== undefined && ready && <span>synced in {(w.lastSyncMs / 1000).toFixed(1)} s</span>}
        </div>
        {w.error && <p className="mt-3 break-words text-xs text-red-400">{w.error}</p>}
      </section>

      {banner && (
        <div className={`mx-5 flex items-start gap-3 rounded-2xl border p-3 text-xs ${banner.error ? "border-red-900 bg-red-950/40" : "border-zinc-800 bg-zinc-900/60"}`}>
          <div className="min-w-0 flex-1">
            <p className={banner.error ? "text-red-300" : "text-zinc-200"}>{banner.status}</p>
            {banner.error && <p className="mt-1 break-words text-red-400">{banner.error}</p>}
          </div>
          {banner.done && (
            <button onClick={clearFinishedAction} aria-label="Dismiss" className="text-zinc-500 hover:text-zinc-200">
              <Icon name="close" className="h-4 w-4" />
            </button>
          )}
        </div>
      )}

      <div className="px-5">
        <div role="tablist" aria-label="Assets and activity" className="flex border-b border-zinc-900 text-sm">
          {(["assets", "activity"] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`flex-1 border-b-2 py-2.5 capitalize ${tab === t ? "border-emerald-400 font-medium text-zinc-100" : "border-transparent text-zinc-500 hover:text-zinc-300"}`}
            >
              {t}
            </button>
          ))}
        </div>

        {tab === "assets" ? (
          <div className="pb-4">
            <div className="flex items-center gap-3 py-3">
              <EthIcon />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">Ether</p>
                <p className="text-xs text-zinc-500">Private · shielded</p>
              </div>
              <div className="text-right">
                <p className="font-mono text-sm" title={w.balances ? `${formatEther(total)} ETH` : undefined}>{w.balances ? fmtEthShort(total) : "…"} ETH</p>
                <p className="text-xs text-zinc-500">{total > valid ? "pending PPOI" : "spendable"}</p>
              </div>
            </div>
            <div className="flex items-center gap-3 border-t border-zinc-900 py-3">
              <EthIcon />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">Ether</p>
                <p className="text-xs text-zinc-500">Public account · the way in and out</p>
              </div>
              <div className="text-right">
                <p className="font-mono text-sm" title={w.publicWei !== undefined ? `${formatEther(w.publicWei)} ETH` : undefined}>{w.publicWei !== undefined ? fmtEthShort(w.publicWei) : "…"} ETH</p>
                <button onClick={() => open("shield")} className="text-xs text-emerald-400 hover:text-emerald-300">
                  Shield
                </button>
              </div>
            </div>
            {others.map((b) => (
              <div key={`${b.asset}-${b.poiStatus}`} className="flex items-center gap-3 border-t border-zinc-900 py-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-xs text-zinc-400">?</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-xs text-zinc-300">{short(b.token ?? b.asset, 8, 6)}</p>
                  <p className={`text-xs ${POI_LABEL[b.poiStatus ?? ""]?.tone ?? "text-zinc-500"}`}>{POI_LABEL[b.poiStatus ?? ""]?.text ?? b.poiStatus ?? ""}</p>
                </div>
                <p className="font-mono text-xs">{b.amount}</p>
              </div>
            ))}
            {eth.some((b) => b.poiStatus === "Missing") && (
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
          </div>
        ) : (
          <ActivityList />
        )}
      </div>

      <Sheet open={sheet !== undefined} title={sheet ? TITLE[sheet] : ""} onClose={() => setSheet(undefined)}>
        {sheet === "receive" && <ReceiveCard />}
        {sheet === "shield" && <ShieldForm />}
        {sheet === "send" && <PrivateActions mode="send" />}
        {sheet === "withdraw" && <PrivateActions mode="unshield" />}
        {sheet === "swap" && <SwapDashboard />}
      </Sheet>
    </div>
  );
}
