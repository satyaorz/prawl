import { useCallback, useEffect, useState } from "react";
import { formatEther, isAddress, parseEther } from "viem";
import { useWallet } from "../lib/use-wallet";
import { buildShieldTarget } from "../lib/wallet";
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
 * Shown only inside the Prawl Android app, where `window.prawlOffline` exists: the phone's coins and
 * the three things you do with them, without scanning anything. What the phone returns opens in the
 * card below like a scanned code, so the same checks and the same simulate-then-send apply. Cash-out
 * and refresh wait for the user's approval on the phone itself.
 */
export function PhoneBridgePanel({ onPayload }: { onPayload: (link: string) => void }) {
  const w = useWallet();
  const bridge = getBridge();
  const [coins, setCoins] = useState<BridgeCoin[]>();
  const [value, setValue] = useState("");
  const [priv, setPriv] = useState(false);
  const [address, setAddress] = useState("");
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
  if (!bridge) return null;

  /** One phone call at a time, with a waiting message; a refusal on the phone is not an error. */
  async function run(label: string, fn: () => Promise<{ link: string } | undefined>) {
    setError(undefined);
    setBusy(label);
    try {
      const out = await fn();
      if (out) onPayload(out.link);
    } catch (e) {
      setError(e instanceof BridgeDeclined ? "Declined on the phone. Nothing was signed." : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(undefined);
      void load(bridge!);
    }
  }

  const b = bridge;
  const unlocked = !!w.evmAddress;
  return (
    <section className="rounded-2xl border border-emerald-900/50 bg-emerald-950/20 p-4">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400">
          <Icon name="qr" className="h-5 w-5" />
        </span>
        <div>
          <h2 className="text-sm font-semibold">This phone</h2>
          <p className="text-xs text-zinc-400">Connected to the Prawl app: no scanning needed.</p>
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
        <p className="text-xs font-medium text-zinc-300">Mint a coin on this phone</p>
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
                const r = await mintOnPhone(b, { depositor: w.evmAddress, valueWei: wei, mode: priv ? "private" : "public" });
                return r;
              })
            }
            className="rounded-lg bg-emerald-500 px-4 text-sm font-semibold text-zinc-950 disabled:opacity-50"
          >
            Mint
          </button>
        </div>
        <label className="mt-2 flex items-center gap-2 text-xs text-zinc-500">
          <input type="checkbox" checked={priv} onChange={(e) => setPriv(e.target.checked)} />
          Fund it from my private balance
        </label>
      </div>

      <div className="mt-3">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium text-zinc-300">Coins on this phone</p>
          <button onClick={() => void load(b)} disabled={!!busy} className="text-xs text-zinc-500 hover:text-zinc-300">
            Refresh list
          </button>
        </div>
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value.trim())}
          placeholder="Payout address for 'To address' (0x…)"
          spellCheck={false}
          className="mt-2 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-xs outline-none focus:border-zinc-500"
        />
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
                    <span className="text-zinc-500">{c.state}</span>
                  </div>
                  <p className="text-zinc-500">
                    {formatEther(BigInt(c.valueWei))} ETH · expires {new Date(c.expiry * 1000).toLocaleString()}
                  </p>
                  {notes.map((n) => (
                    <div key={n.noteId ?? "whole"} className="mt-2 flex flex-wrap items-center gap-2">
                      <span className="font-mono text-zinc-300">{formatEther(BigInt(n.valueWei))} ETH</span>
                      <button
                        disabled={!!busy || !isAddress(address)}
                        title={isAddress(address) ? "" : "Enter a payout address above"}
                        onClick={() => void run("cash out", () => cashOutToAddress(b, { coinId: c.coinId, ...(n.noteId ? { noteId: n.noteId } : {}), address }))}
                        className="rounded-full border border-zinc-700 px-3 py-1 text-zinc-300 hover:bg-zinc-900 disabled:opacity-40"
                      >
                        To address
                      </button>
                      <button
                        disabled={!!busy || !unlocked}
                        onClick={() =>
                          void run("cash out privately", () =>
                            cashOutToShield(b, {
                              coinId: c.coinId,
                              ...(n.noteId ? { noteId: n.noteId } : {}),
                              valueWei: BigInt(n.valueWei),
                              escrow: (c as { escrow?: `0x${string}` }).escrow ?? ESCROW_V31,
                              chainId: OFFLINE_CHAIN_ID,
                              buildTarget: buildShieldTarget,
                            }),
                          )
                        }
                        className="rounded-full border border-zinc-700 px-3 py-1 text-zinc-300 hover:bg-zinc-900 disabled:opacity-40"
                      >
                        To private balance
                      </button>
                      <button
                        disabled={!!busy}
                        onClick={() => void run("refresh", () => refreshOnPhone(b, { coinId: c.coinId, ...(n.noteId ? { noteId: n.noteId } : {}) }))}
                        className="rounded-full border border-zinc-700 px-3 py-1 text-zinc-300 hover:bg-zinc-900 disabled:opacity-40"
                      >
                        Refresh
                      </button>
                    </div>
                  ))}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
