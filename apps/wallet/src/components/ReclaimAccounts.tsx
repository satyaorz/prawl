import { useState } from "react";
import { formatEther } from "viem";
import { useWallet } from "../lib/use-wallet";
import { reclaimAccounts, shieldFromReclaim, type ReclaimAccount } from "../lib/wallet";
import { short } from "./ui";

/**
 * The fresh addresses private offline coins refund to. A coin that expires unspent pays its remainder to its own reclaim address (not your
 * main one), so this is where to look for a refund and move it into the private balance. Reading each address uses its own Tor circuit, so
 * it only runs when asked.
 */
export function ReclaimAccounts() {
  const w = useWallet();
  const [accounts, setAccounts] = useState<ReclaimAccount[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const shielding = w.action?.kind === "shield" && !w.action.done;

  async function check() {
    setBusy(true);
    setError(undefined);
    try {
      setAccounts(await reclaimAccounts());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const funded = accounts?.filter((a) => a.balanceWei > 0n) ?? [];
  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium">Reclaim accounts</h2>
        <button onClick={() => void check()} disabled={busy || shielding} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs disabled:opacity-40">
          {busy ? "Checking…" : accounts ? "Check again" : "Check balances"}
        </button>
      </div>
      <p className="mt-2 text-xs text-zinc-500">
        A private coin that expires unspent is refunded to its own fresh address, made from your passkey, so your main address is not its refund.
        Check here for refunds and move them into your private balance.
      </p>
      {error && <p className="mt-2 break-all text-xs text-red-400">{error}</p>}
      {accounts && funded.length === 0 && !error && <p className="mt-3 text-xs text-zinc-400">Nothing refunded yet ({accounts.length} addresses checked).</p>}
      {funded.map((a) => (
        <div key={a.index} className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-zinc-800 p-3 text-xs">
          <div className="min-w-0">
            <p className="font-mono text-zinc-300">{short(a.address)}</p>
            <p className="text-zinc-500">{formatEther(a.balanceWei)} ETH</p>
          </div>
          <button
            onClick={() => void shieldFromReclaim(a.index).then(check)}
            disabled={busy || shielding}
            className="rounded-lg bg-emerald-500 px-3 py-1.5 font-semibold text-zinc-950 disabled:opacity-50"
          >
            Shield
          </button>
        </div>
      ))}
      {w.action?.kind === "shield" && (
        <div className="mt-3 text-xs">
          <p className={w.action.error ? "text-red-400" : "text-zinc-300"}>{w.action.status}</p>
          {w.action.error && <p className="mt-1 break-all text-red-400">{w.action.error}</p>}
        </div>
      )}
    </section>
  );
}
