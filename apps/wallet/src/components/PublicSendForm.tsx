import { useState } from "react";
import { formatEther, isAddress, parseEther } from "viem";
import { useWallet } from "../lib/use-wallet";
import { sendPublicEth } from "../lib/wallet";

/** A plain transfer: 21,000 gas at up to ~5 gwei; sendCalls checks the real cost and says what fits. */
const TRANSFER_GAS_RESERVE_WEI = 105_000_000_000_000n;

/**
 * Send ETH from the PUBLIC account to any 0x address. Nothing about it is private: the transfer links this
 * account to the recipient on chain. Used by the Send sheet (Public tab) and the Shield sheet's link.
 */
export function PublicSendForm() {
  const w = useWallet();
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string>();
  const running = w.action && !w.action.done;

  function submit() {
    setError(undefined);
    if (!isAddress(to)) return setError("Enter a 0x address");
    let wei: bigint;
    try {
      wei = parseEther(amount);
    } catch {
      return setError("Enter an amount in ETH");
    }
    if (wei <= 0n) return setError("Enter an amount above zero");
    void sendPublicEth(to, wei);
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-zinc-400">
        From your public account: <span className="font-mono">{w.publicWei !== undefined ? `${formatEther(w.publicWei)} ETH` : "…"}</span>
      </p>
      <p className="text-xs text-amber-300">A public transfer links this account to the recipient on chain.</p>
      <input
        value={to}
        onChange={(e) => setTo(e.target.value.trim())}
        placeholder="0x… recipient"
        spellCheck={false}
        className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-xs outline-none focus:border-zinc-500"
      />
      <div className="flex gap-2">
        <button
          type="button"
          disabled={!w.publicWei || w.publicWei <= TRANSFER_GAS_RESERVE_WEI}
          onClick={() => w.publicWei && setAmount(formatEther(w.publicWei - TRANSFER_GAS_RESERVE_WEI))}
          className="rounded-lg border border-zinc-700 px-3 text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-40"
        >
          Max
        </button>
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value.trim())}
          placeholder="0.001"
          inputMode="decimal"
          className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-sm outline-none focus:border-zinc-500"
        />
        <button disabled={!!running || w.phase !== "ready"} onClick={submit} className="rounded-lg border border-zinc-700 px-4 py-2 text-sm disabled:opacity-50">
          {running && w.action?.kind === "public-send" ? "Sending…" : "Send"}
        </button>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {w.action?.kind === "public-send" && (
        <div className="text-xs">
          <p className={w.action.error ? "text-red-400" : "text-zinc-300"}>{w.action.status}</p>
          {w.action.error && <p className="mt-1 break-all text-red-400">{w.action.error}</p>}
          {w.action.txs?.map((t) => (
            <p key={t.hash} className="mt-1 break-all font-mono text-zinc-500">
              {t.status === "success" ? "✓" : "✗"} {t.hash}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
