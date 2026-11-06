import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { formatEther } from "viem";
import { anon } from "../lib/anon";
import { useWallet } from "../lib/use-wallet";
import { offlineLoad, offlineRedeem } from "../lib/wallet";
import { coinStatus, type CoinStatus } from "../offline/escrow";
import { configProblems, depositorUri, payloadFromText, payoutValue, type OfflinePayload } from "../offline/payload";
import { QrScanner } from "./QrScanner";

const short = (s: string, a = 10, b = 6) => (s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s);

/** A handoff in the address bar (#/offline/<kind>?d=…), read once and then removed from it. */
function takeFromLocation(): string | undefined {
  if (!/^#\/offline\//.test(window.location.hash)) return undefined;
  const text = window.location.hash;
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  return text;
}

/**
 * Offline cash (phone ↔ website, HANDOFF v1). The phones hold and pay the
 * cash; the website only loads coins into the escrow and cashes them out.
 */
export function OfflineCard() {
  const w = useWallet();
  const [payload, setPayload] = useState<OfflinePayload>();
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  const [scanning, setScanning] = useState(false);
  const [showDepositor, setShowDepositor] = useState(false);
  const [qr, setQr] = useState<string>();
  const [status, setStatus] = useState<CoinStatus | { error: string }>();

  const take = useCallback((t: string) => {
    setError(undefined);
    setStatus(undefined);
    try {
      setPayload(payloadFromText(t));
      setText("");
    } catch (e) {
      setPayload(undefined);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    const read = () => {
      const t = takeFromLocation();
      if (t) take(t);
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, [take]);

  const coinId = payload ? (payload.t === "load" ? payload.coinId : payload.header.coinId) : undefined;
  const refreshStatus = useCallback(() => {
    if (!coinId) return;
    setStatus(undefined);
    coinStatus(anon, coinId)
      .then(setStatus)
      .catch((e: unknown) => setStatus({ error: e instanceof Error ? e.message : String(e) }));
  }, [coinId]);
  useEffect(refreshStatus, [refreshStatus]);

  useEffect(() => {
    if (!showDepositor || !w.evmAddress) return setQr(undefined);
    void QRCode.toDataURL(depositorUri(w.evmAddress), { margin: 1, width: 220, color: { dark: "#09090b", light: "#fafafa" } }).then(setQr);
  }, [showDepositor, w.evmAddress]);

  // Refresh the coin's status once our own load or cash-out finishes.
  const actionDone = w.action?.done && (w.action.kind === "offline-load" || w.action.kind === "offline-redeem");
  useEffect(() => {
    if (actionDone) refreshStatus();
  }, [actionDone, refreshStatus]);

  if (!payload && !w.railgunAddress) return null;
  const running = !!w.action && !w.action.done;
  const unlocked = !!w.evmAddress && w.phase !== "locked";
  const problems = payload ? configProblems(payload) : [];
  const mismatch = payload?.t === "load" && w.evmAddress && payload.depositor.toLowerCase() !== w.evmAddress.toLowerCase();

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-medium">Offline cash</h2>
        {w.evmAddress && (
          <button onClick={() => setShowDepositor((v) => !v)} className="text-xs text-zinc-400 hover:text-zinc-200">
            {showDepositor ? "Hide" : "Show"} depositor QR
          </button>
        )}
      </div>
      <p className="mt-1 text-xs text-zinc-500">
        Coins live on your Android phone and pay phone to phone with no network. Here you load them from your public account and cash them out.
      </p>

      {showDepositor && w.evmAddress && (
        <div className="mt-3 flex items-center gap-3">
          {qr && <img src={qr} alt="Depositor address QR" width={130} height={130} className="rounded-lg" />}
          <p className="text-xs text-zinc-400">
            Scan this with the phone before it mints a coin: the coin is bound to this account as its depositor.
            <span className="mt-1 block break-all font-mono text-zinc-300">{w.evmAddress}</span>
          </p>
        </div>
      )}

      <div className="mt-3 flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste a load or cash-out link from the phone"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-xs outline-none focus:border-zinc-500"
        />
        <button onClick={() => take(text)} disabled={!text.trim()} className="rounded-lg border border-zinc-700 px-3 text-xs disabled:opacity-40">
          Open
        </button>
        <button onClick={() => setScanning((v) => !v)} className="rounded-lg border border-zinc-700 px-3 text-xs">
          Scan
        </button>
      </div>
      {scanning && (
        <QrScanner
          onResult={(t) => {
            setScanning(false);
            take(t);
          }}
          onClose={() => setScanning(false)}
        />
      )}
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}

      {payload && (
        <div className="mt-4 rounded-xl border border-zinc-800 p-4">
          <div className="flex items-baseline justify-between">
            <h3 className="text-sm font-medium">{payload.t === "load" ? "Load a coin" : "Cash out"}</h3>
            <button onClick={() => setPayload(undefined)} className="text-xs text-zinc-500 hover:text-zinc-300">
              Close
            </button>
          </div>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
            <dt className="text-zinc-500">Coin</dt>
            <dd className="font-mono text-zinc-300">{short(coinId ?? "", 12)}</dd>
            {payload.t === "load" ? (
              <>
                <dt className="text-zinc-500">Amount</dt>
                <dd className="font-mono text-zinc-300">{formatEther(payload.value)} ETH</dd>
                <dt className="text-zinc-500">Expires</dt>
                <dd className="font-mono text-zinc-300">{new Date(Number(payload.expiry) * 1000).toLocaleString()}</dd>
                <dt className="text-zinc-500">Depositor</dt>
                <dd className={`font-mono ${mismatch ? "text-red-400" : "text-zinc-300"}`}>
                  {short(payload.depositor)} {mismatch ? "(not this wallet)" : unlocked ? "(this wallet)" : ""}
                </dd>
              </>
            ) : (
              <>
                <dt className="text-zinc-500">Pays</dt>
                <dd className="font-mono text-zinc-300">{formatEther(payoutValue(payload))} ETH</dd>
                <dt className="text-zinc-500">To</dt>
                <dd className="break-all font-mono text-zinc-300">{payload.redemption.payout}</dd>
                <dt className="text-zinc-500">Path</dt>
                <dd className="font-mono text-zinc-300">{payload.path.length} offline payment{payload.path.length === 1 ? "" : "s"}</dd>
              </>
            )}
            <dt className="text-zinc-500">On chain</dt>
            <dd className="font-mono text-zinc-300">
              {!status
                ? "checking over Tor…"
                : "error" in status
                  ? <span className="text-amber-400">{status.error}</span>
                  : !status.deposited
                    ? "not loaded"
                    : `loaded · paid ${formatEther(status.paid)} ETH${status.frozen ? " · FROZEN (double spend)" : ""}${status.closed ? " · closed" : ""}`}
            </dd>
          </dl>
          {problems.map((p) => (
            <p key={p} className="mt-2 text-xs text-red-400">Refused: {p}</p>
          ))}
          {!unlocked ? (
            <p className="mt-3 text-xs text-amber-400">Unlock your wallet to {payload.t === "load" ? "load this coin" : "send this cash-out"}.</p>
          ) : (
            <button
              disabled={running || problems.length > 0 || !!mismatch}
              onClick={() => void (payload.t === "load" ? offlineLoad(payload) : offlineRedeem(payload))}
              className="mt-3 rounded-lg bg-emerald-400 px-4 py-2 text-sm font-medium text-zinc-950 disabled:opacity-50"
            >
              {running ? "Working…" : payload.t === "load" ? `Load ${formatEther(payload.value)} ETH` : "Cash out"}
            </button>
          )}
          {payload.t === "redeem" && (
            <p className="mt-2 text-xs text-zinc-500">The payout is fixed by the phone's signature; this wallet only pays the gas (about 360k–540k).</p>
          )}
        </div>
      )}

      {w.action && (w.action.kind === "offline-load" || w.action.kind === "offline-redeem") && (
        <div className="mt-3 text-xs">
          <p className={w.action.error ? "text-red-400" : "text-zinc-300"}>{w.action.status}</p>
          {w.action.error && <p className="mt-1 break-all text-red-400">{w.action.error}</p>}
          {w.action.txs?.map((t) => (
            <p key={t.hash} className="mt-1 break-all font-mono text-zinc-500">
              {t.status === "success" ? "✓" : "✗"} {t.hash}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}
