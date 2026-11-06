import { useState } from "react";
import { formatEther, parseEther } from "viem";
import { useWallet } from "../lib/use-wallet";

/** Public ETH kept back for the shield transaction's gas (~1.14M gas measured); sendCalls checks the real cost. */
const SHIELD_GAS_RESERVE_WEI = 3_000_000_000_000_000n;
import { shieldEth } from "../lib/wallet";

/** Public account (the way in) and moving its ETH into the private balance. */
export function ShieldForm() {
  const w = useWallet();
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string>();
  const running = w.action && !w.action.done;

  if (!w.railgunAddress) return null;

  function submit() {
    setError(undefined);
    let wei: bigint;
    try {
      wei = parseEther(amount);
    } catch {
      setError("Enter an amount in ETH");
      return;
    }
    if (wei <= 0n) return setError("Enter an amount above zero");
    if (w.publicWei !== undefined && wei >= w.publicWei) return setError("Leave some ETH for gas");
    void shieldEth(wei);
  }

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-medium">Add funds privately</h2>
        <span className="font-mono text-xs text-zinc-400">
          public: {w.publicWei !== undefined ? `${formatEther(w.publicWei)} ETH` : "…"}
        </span>
      </div>
      <p className="mt-1 text-xs text-zinc-500">
        Send Sepolia ETH to your public account, then shield it. The chain sees the deposit, not who owns it afterwards.
      </p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={!w.publicWei || w.publicWei <= SHIELD_GAS_RESERVE_WEI}
          onClick={() => w.publicWei && setAmount(formatEther(w.publicWei - SHIELD_GAS_RESERVE_WEI))}
          className="rounded-lg border border-zinc-700 px-3 text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-40"
        >
          Max
        </button>
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value.trim())}
          placeholder="0.01"
          inputMode="decimal"
          className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-sm outline-none focus:border-zinc-500"
        />
        <button
          disabled={!!running || w.phase !== "ready"}
          onClick={submit}
          className="rounded-lg bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 disabled:opacity-50"
        >
          {running ? "Shielding…" : "Shield ETH"}
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
      {w.action?.kind === "shield" && (
        <div className="mt-3 text-xs">
          <p className={w.action.error ? "text-red-400" : "text-zinc-300"}>{w.action.status}</p>
          {w.action.error && <p className="mt-1 break-all text-red-400">{w.action.error}</p>}
          {w.action.txs?.map((t) => (
            <p key={t.hash} className="mt-1 break-all font-mono text-zinc-500">
              {t.status === "success" ? "✓" : "✗"} {t.hash} · block {t.blockNumber.toString()}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}
