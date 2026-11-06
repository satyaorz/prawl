import { useState } from "react";
import { formatEther, isAddress, parseEther } from "viem";
import type { Balance } from "@prawl/railgun";
import { useWallet } from "../lib/use-wallet";
import { maxPrivateAmountWei, privateFeeWei, privateGasEstimateWei, privateSendEth, unshieldEth } from "../lib/wallet";

type Tab = "send" | "unshield";

/** Spendable private ETH: WETH notes whose PPOI status is Valid. */
function spendable(balances: Balance[] | undefined, weth?: string): bigint {
  return (balances ?? [])
    .filter((b) => b.token !== undefined && b.token === weth && b.poiStatus === "Valid")
    .reduce((sum, b) => sum + BigInt(b.amount), 0n);
}

export function PrivateActions() {
  const w = useWallet();
  const [tab, setTab] = useState<Tab>("send");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string>();
  if (!w.railgunAddress) return null;

  const available = spendable(w.balances, w.wrappedBaseToken);
  const running = w.action && !w.action.done;
  const lastShield = w.action?.kind === "shield" && w.action.done && !w.action.error;

  function submit() {
    setError(undefined);
    let wei: bigint;
    try {
      wei = parseEther(amount);
    } catch {
      return setError("Enter an amount in ETH");
    }
    if (wei <= 0n) return setError("Enter an amount above zero");
    const kind = tab;
    if (wei + privateFeeWei(kind, wei) + privateGasEstimateWei() > available) {
      const max = maxPrivateAmountWei(kind, available);
      return setError(
        `${formatEther(available)} ETH is spendable, and about ${formatEther(privateGasEstimateWei())} ETH of gas comes out of it` +
          (kind === "unshield" ? ", plus the 0.25% fee" : "") +
          (max > 0n ? `. Try at most ${formatEther(max)} ETH.` : "."),
      );
    }
    if (tab === "send") {
      if (!/^0zk1[0-9a-z]+$/.test(to)) return setError("Enter a private 0zk address");
      if (to === w.railgunAddress) return setError("That is your own address");
      void privateSendEth(to, wei);
    } else {
      if (!isAddress(to)) return setError("Enter a public 0x address");
      if (w.evmAddress && to.toLowerCase() === w.evmAddress.toLowerCase()) {
        return setError("Withdrawing to the account you shielded from links the two. Use a fresh address.");
      }
      void unshieldEth(to, wei);
    }
  }

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
      <div className="flex gap-4 text-sm">
        {(["send", "unshield"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={tab === t ? "font-medium text-zinc-100" : "text-zinc-500 hover:text-zinc-300"}>
            {t === "send" ? "Send privately" : "Withdraw to public"}
          </button>
        ))}
        <span className="ml-auto font-mono text-xs text-zinc-400">spendable: {formatEther(available)} ETH</span>
      </div>
      <p className="mt-2 text-xs text-zinc-500">
        {tab === "send"
          ? "Only you and the recipient see the amount. Gas is paid from your private balance by a fresh one-time account."
          : "The recipient and amount become public, not who sent it. A 0.25% RAILGUN fee is added."}{" "}
        About {formatEther(privateGasEstimateWei())} ETH of gas.
      </p>
      <div className="mt-3 flex flex-col gap-2">
        <input
          value={to}
          onChange={(e) => setTo(e.target.value.trim())}
          placeholder={tab === "send" ? "0zk1…" : "0x… (a fresh address is best)"}
          spellCheck={false}
          className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-sm outline-none focus:border-zinc-500"
        />
        <div className="flex gap-2">
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value.trim())}
            placeholder="0.005"
            inputMode="decimal"
            className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-sm outline-none focus:border-zinc-500"
          />
          <button
            onClick={submit}
            disabled={!!running || w.phase !== "ready"}
            className="rounded-lg bg-emerald-400 px-4 py-2 text-sm font-medium text-zinc-950 disabled:opacity-50"
          >
            {running ? "Working…" : tab === "send" ? "Send" : "Withdraw"}
          </button>
        </div>
      </div>
      {tab === "unshield" && lastShield && (
        <p className="mt-2 text-xs text-amber-300">
          You shielded moments ago. Withdrawing soon after, or the same amount, makes the two easy to match. Waiting longer and using different amounts helps.
        </p>
      )}
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
      {w.action && w.action.kind !== "shield" && (
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
