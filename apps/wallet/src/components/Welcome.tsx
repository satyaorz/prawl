import { passkeysAvailable } from "@prawl/keys";
import { useTor } from "../lib/use-tor";
import { useWallet } from "../lib/use-wallet";
import { createWallet, unlockWallet } from "../lib/wallet";
import { Icon, Logo, type IconName } from "./ui";

const FEATURES: ReadonlyArray<readonly [IconName, string, string]> = [
  ["shield", "A private balance", "Your funds sit in a shielded pool (RAILGUN). Sends between private addresses reveal nothing."],
  ["lock", "No seed phrase, no server", "Your keys come from a passkey. The same synced passkey on another device restores everything."],
  ["receive", "Tor on every request", "Each address and each transaction uses its own Tor circuit, so no node links your IP to you."],
  ["swap", "Private swaps", "Swap WETH for a test token on Uniswap v4. Orders are encrypted and batched, and only the net trade is public."],
  ["offline", "Offline cash", "With the Prowl Android app you can pay another phone with no network at all, then cash out here."],
];

/** The locked screen: what Prowl is, and the two ways in. */
export function Welcome() {
  const w = useWallet();
  const tor = useTor();
  const busy = w.phase === "unlocking" || w.phase === "opening";
  const supported = passkeysAvailable();
  return (
    <section className="flex flex-col items-center px-6 pb-8 pt-10 text-center">
      <Logo className="h-16 w-16" />
      <h1 className="mt-4 text-3xl font-semibold tracking-tight">Prowl</h1>
      <p className="mt-1 text-sm text-zinc-400">The private wallet. Every request goes over Tor.</p>

      <div className="mt-8 flex w-full flex-col gap-2.5">
        {w.hasPasskey ? (
          <button
            disabled={busy || !supported}
            onClick={() => void unlockWallet()}
            className="w-full rounded-full bg-emerald-500 py-3 text-sm font-semibold text-zinc-950 transition hover:bg-emerald-400 disabled:opacity-50"
          >
            {busy ? "Opening…" : "Unlock with passkey"}
          </button>
        ) : (
          <>
            <button
              disabled={busy || !supported}
              onClick={() => void createWallet()}
              className="w-full rounded-full bg-emerald-500 py-3 text-sm font-semibold text-zinc-950 transition hover:bg-emerald-400 disabled:opacity-50"
            >
              {busy ? "Opening…" : "Create wallet"}
            </button>
            <button
              disabled={busy || !supported}
              onClick={() => void unlockWallet()}
              className="w-full rounded-full border border-zinc-700 py-3 text-sm font-medium text-zinc-200 transition hover:bg-zinc-900 disabled:opacity-50"
            >
              Restore with passkey
            </button>
          </>
        )}
        {w.error && <p className="break-words text-xs text-red-400">{w.error}</p>}
        {!supported && (
          <p className="text-xs text-amber-400">
            This browser has no passkey support, so a wallet cannot be created here. Use a recent Chrome, Edge or Safari with a screen lock or security key set up.
          </p>
        )}
        <p className="flex items-center justify-center gap-2 text-xs text-zinc-500">
          <span className={`h-2 w-2 rounded-full ${tor.phase === "ready" ? "bg-emerald-400" : tor.phase === "failed" ? "bg-red-500" : "animate-pulse bg-amber-400"}`} />
          {tor.phase === "ready" ? "Connected over Tor" : tor.phase === "failed" ? "Tor failed" : "Connecting to Tor…"}
          {tor.phase === "failed" && (
            <button onClick={() => window.location.reload()} className="underline hover:text-zinc-300">
              retry
            </button>
          )}
        </p>
      </div>

      <ul className="mt-8 w-full space-y-4 text-left">
        {FEATURES.map(([icon, title, text]) => (
          <li key={title} className="flex gap-3">
            <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-emerald-400">
              <Icon name={icon} className="h-[18px] w-[18px]" />
            </span>
            <span>
              <span className="block text-sm font-medium text-zinc-100">{title}</span>
              <span className="block text-xs leading-relaxed text-zinc-500">{text}</span>
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-8 text-xs text-zinc-600">Test network: Sepolia. Do not use it for real money yet.</p>
    </section>
  );
}
