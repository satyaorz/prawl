import { useState } from "react";
import { formatEther, isAddress } from "viem";
import { MAINNET, SEPOLIA } from "@prawl/anon-rpc";
import { anon } from "../lib/anon";

interface Result {
  chain: string;
  balance: bigint;
  nonce: number;
}

/** Reads a public address's balance over Tor, on that address's own circuit. */
export function WatchAddress() {
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Result[]>([]);
  const [error, setError] = useState<string>();

  async function check() {
    if (!isAddress(address)) {
      setError("Not an address");
      return;
    }
    setBusy(true);
    setError(undefined);
    setResults([]);
    try {
      const id = anon.identities.account(address);
      const out = await Promise.all(
        [
          { chain: "Sepolia", chainId: SEPOLIA },
          { chain: "Ethereum", chainId: MAINNET },
        ].map(async ({ chain, chainId }) => {
          const tag = anon.blockTag(chainId);
          const [bal, nonce] = await anon.batch(id, chainId, [
            { method: "eth_getBalance", params: [address, tag] },
            { method: "eth_getTransactionCount", params: [address, tag] },
          ]);
          if (!bal || !nonce) throw new Error(`${chain}: no answer`);
          if ("error" in bal) throw new Error(`${chain}: ${bal.error.message}`);
          if ("error" in nonce) throw new Error(`${chain}: ${nonce.error.message}`);
          return { chain, balance: BigInt(bal.result as string), nonce: Number(BigInt(nonce.result as string)) };
        }),
      );
      setResults(out);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
      <h2 className="text-sm font-medium">Check a public address</h2>
      <p className="mt-1 text-xs text-zinc-500">Read over Tor on a circuit only this address uses.</p>
      <div className="mt-3 flex gap-2">
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value.trim())}
          placeholder="0x…"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-sm outline-none focus:border-zinc-500"
        />
        <button
          onClick={() => void check()}
          disabled={busy}
          className="rounded-lg bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 disabled:opacity-50"
        >
          {busy ? "Reading…" : "Check"}
        </button>
      </div>
      {error && <p className="mt-3 text-xs text-red-400">{error}</p>}
      {results.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm">
          {results.map((r) => (
            <li key={r.chain} className="flex justify-between font-mono">
              <span className="text-zinc-400">{r.chain}</span>
              <span>
                {formatEther(r.balance)} ETH <span className="text-zinc-500">· nonce {r.nonce}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
