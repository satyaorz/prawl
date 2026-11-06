import { useCallback, useEffect, useRef, useState } from "react";
import { formatEther, isAddress, parseEther } from "viem";
import { useWallet } from "../lib/use-wallet";
import { buildShieldTarget, nextReclaimAddress } from "../lib/wallet";
import {
  BridgeDeclined,
  cashOutToAddress,
  cashOutToShield,
  getBridge,
  mintOnPhone,
  refreshOnPhone,
  type BridgeCoin,
  type PrawlOfflineBridge,
} from "../offline/bridge";
import { ESCROW_V31, OFFLINE_CHAIN_ID } from "../offline/payload";
import { Icon, short } from "./ui";

/**
 * Shown only inside the Prowl Android app, where `window.prawlOffline` exists: the phone's coins and
 * the three things you do with them, without scanning anything. What the phone returns opens in the
 * card below like a scanned code, so the same checks and the same simulate-then-send apply. Cash-out
 * and refresh wait for the user's approval on the phone itself.
 */
type PayloadOpts = { own?: boolean; autoSend?: boolean };

/** What the phone's coin states mean to a person. */
const STATE_LABEL: Record<string, string> = { spendable: "ready", confirming: "confirming deposit", awaiting_deposit: "awaiting deposit", expired: "expired" };

export function PhoneBridgePanel({ onPayload, request }: { onPayload: (link: string, opts?: PayloadOpts) => void; request?: { coinId: string; noteId?: string; n: number } }) {
  const w = useWallet();
  const bridge = getBridge();
  const [coins, setCoins] = useState<BridgeCoin[]>();
  const [value, setValue] = useState("");
  const [priv, setPriv] = useState(false);
  const [address, setAddress] = useState("");
  /** The note whose "Another address" box is open (only one at a time). */
  const [addrFor, setAddrFor] = useState<string>();
  const handled = useRef<number | undefined>(undefined);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();

  const load = useCallback(async (b: PrawlOfflineBridge) => {
    try {
      setCoins(await b.coins());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    if (bridge) void load(bridge);
  }, [bridge, load]);
  // The phone app's native "Cash out to my wallet" names a coin: do the same as this panel's button, once per request.
  useEffect(() => {
    if (!request || !bridge || coins === undefined || handled.current === request.n) return;
    handled.current = request.n;
    const c = coins.find((x) => x.coinId.toLowerCase() === request.coinId.toLowerCase());
    const n = c && (request.noteId ? c.notes?.find((x) => x.noteId === request.noteId) : (c.notes?.[0] ?? { valueWei: c.valueWei }));
    if (!c || !n) return setError("The phone asked to cash out a coin this page does not see. Tap Refresh list and try again.");
    toMyWallet(c, n);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, coins, bridge]);
  // Let the phone's own Load form offer this wallet's address (older app builds simply lack the method).
  useEffect(() => {
    if (bridge && w.evmAddress && typeof bridge.setAccount === "function") void bridge.setAccount({ address: w.evmAddress }).catch(() => undefined);
  }, [bridge, w.evmAddress]);
  if (!bridge) return null;

  /** One phone call at a time, with a waiting message; a refusal on the phone is not an error. */
  async function run(label: string, fn: () => Promise<{ link: string } | undefined>, opts: PayloadOpts = {}) {
    setError(undefined);
    setBusy(label);
    try {
      const out = await fn();
      if (out) onPayload(out.link, opts);
    } catch (e) {
      setError(e instanceof BridgeDeclined ? "Declined on the phone. Nothing was signed." : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(undefined);
      void load(bridge!);
    }
  }

  const b = bridge;
  const unlocked = !!w.evmAddress;

  /** Cash a note out into THIS wallet's private balance: the phone approves and signs, then the wallet submits it right away. */
  function toMyWallet(c: BridgeCoin, n: { noteId?: string; valueWei: string }) {
    void run(
      "cash out to my wallet",
      () =>
        cashOutToShield(b, {
          coinId: c.coinId,
          ...(n.noteId ? { noteId: n.noteId } : {}),
          valueWei: BigInt(n.valueWei),
          escrow: (c as { escrow?: `0x${string}` }).escrow ?? ESCROW_V31,
          chainId: OFFLINE_CHAIN_ID,
          buildTarget: buildShieldTarget,
        }),
      { own: true, autoSend: true },
    );
  }
  return (
    <section className="rounded-2xl border border-emerald-900/50 bg-emerald-950/20 p-4">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400">
          <Icon name="qr" className="h-5 w-5" />
        </span>
        <div>
          <h2 className="text-sm font-semibold">This phone</h2>
          <p className="text-xs text-zinc-400">Connected to the Prowl app: no scanning needed.</p>
        </div>
      </div>

      {busy && (
        <p className="mt-3 flex items-center gap-2 text-xs text-amber-300">
          <Icon name="refresh" className="h-3.5 w-3.5 animate-spin" />
          Waiting for approval on your phone… ({busy})
        </p>
      )}
      {error && <p className="mt-3 break-words text-xs text-red-400">{error}</p>}

      <div className="mt-3 rounded-xl border border-zinc-800 p-3">
        <p className="text-xs font-medium text-zinc-300">Load a new coin</p>
        <div className="mt-2 flex gap-2">
          <input
            value={value}
            onChange={(e) => setValue(e.target.value.trim())}
            placeholder="0.003"
            inputMode="decimal"
            className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-sm outline-none focus:border-zinc-500"
          />
          <button
            disabled={!unlocked || !!busy || !value}
            onClick={() =>
              void run("mint", async () => {
                let wei: bigint;
                try {
                  wei = parseEther(value);
                } catch {
                  throw new Error("Enter an amount in ETH");
                }
                if (!w.evmAddress) throw new Error("unlock the wallet first");
                // A private coin's refund goes to a FRESH address derived from the passkey, never the main account. A public coin is
                // funded by the main account, so that account is its depositor.
                const depositor = priv ? (await nextReclaimAddress()).address : w.evmAddress;
                const r = await mintOnPhone(b, { depositor, valueWei: wei, mode: priv ? "private" : "public" });
                return r;
              }, { own: true })
            }
            className="rounded-lg bg-emerald-500 px-4 text-sm font-semibold text-zinc-950 disabled:opacity-50"
          >
            Create coin
          </button>
        </div>
        <label className="mt-2 flex items-center gap-2 text-xs text-zinc-500">
          <input type="checkbox" checked={priv} onChange={(e) => setPriv(e.target.checked)} />
          Fund it privately (from my private balance)
        </label>
      </div>

      <div className="mt-3">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium text-zinc-300">Coins on this phone</p>
          <button onClick={() => void load(b)} disabled={!!busy} className="text-xs text-zinc-500 hover:text-zinc-300">
            Refresh list
          </button>
        </div>
        {coins === undefined ? (
          <p className="mt-3 text-xs text-zinc-500">Asking the phone…</p>
        ) : coins.length === 0 ? (
          <p className="mt-3 text-xs text-zinc-500">No coins yet.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {coins.map((c) => {
              const notes = c.notes && c.notes.length > 0 ? c.notes : [{ noteId: undefined, valueWei: c.valueWei }];
              return (
                <li key={c.coinId} className="rounded-xl border border-zinc-800 p-3 text-xs">
                  <div className="flex items-baseline justify-between">
                    <span className="font-mono text-zinc-300">{short(c.coinId, 10, 6)}</span>
                    <span className="text-zinc-500">{STATE_LABEL[c.state] ?? c.state}</span>
                  </div>
                  <p className="text-zinc-500">
                    {formatEther(BigInt(c.valueWei))} ETH · expires {new Date(c.expiry * 1000).toLocaleString()}
                  </p>
                  {notes.map((n) => {
                    const key = `${c.coinId}:${n.noteId ?? "whole"}`;
                    const live = c.state === "spendable" || c.state === "confirming";
                    if (!live) return <p key={key} className="mt-2 text-zinc-500">{c.state === "awaiting_deposit" ? "Not loaded yet: fund it above or discard it on the phone." : "Expired: its depositor can reclaim it."}</p>;
                    return (
                      <div key={key} className="mt-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-zinc-300">{formatEther(BigInt(n.valueWei))} ETH</span>
                          <button
                            disabled={!!busy || !unlocked}
                            onClick={() => toMyWallet(c, n)}
                            className="rounded-full bg-emerald-500 px-3 py-1 font-semibold text-zinc-950 disabled:opacity-40"
                          >
                            Cash out to my wallet
                          </button>
                          <button
                            disabled={!!busy}
                            onClick={() => { setAddrFor(addrFor === key ? undefined : key); setAddress(""); }}
                            className="rounded-full border border-zinc-700 px-3 py-1 text-zinc-300 hover:bg-zinc-900 disabled:opacity-40"
                          >
                            Another address
                          </button>
                          <button
                            disabled={!!busy}
                            onClick={() => void run("refresh", () => refreshOnPhone(b, { coinId: c.coinId, ...(n.noteId ? { noteId: n.noteId } : {}) }))}
                            className="rounded-full border border-zinc-700 px-3 py-1 text-zinc-300 hover:bg-zinc-900 disabled:opacity-40"
                          >
                            Refresh
                          </button>
                        </div>
                        {addrFor === key && (
                          <div className="mt-2 flex gap-2">
                            <input
                              value={address}
                              onChange={(e) => setAddress(e.target.value.trim())}
                              placeholder="0x… (the address and amount become public)"
                              spellCheck={false}
                              className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-xs outline-none focus:border-zinc-500"
                            />
                            <button
                              disabled={!!busy || !isAddress(address)}
                              onClick={() => void run("cash out", () => cashOutToAddress(b, { coinId: c.coinId, ...(n.noteId ? { noteId: n.noteId } : {}), address }))}
                              className="rounded-lg border border-zinc-700 px-3 text-xs text-zinc-200 disabled:opacity-40"
                            >
                              Cash out
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
