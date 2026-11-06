import { passkeysAvailable } from "@prawl/keys";

/** First-run explanation, and a clear message when this browser cannot do passkeys. */
export function Intro() {
  const supported = passkeysAvailable();
  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
      <h2 className="text-sm font-medium">What is Prawl</h2>
      <ul className="mt-2 space-y-2 text-xs text-zinc-400">
        <li>
          <span className="text-zinc-200">A private balance.</span> Your funds sit in a shielded pool (RAILGUN). Public addresses are only the way in and out, and sends between private addresses reveal nothing.
        </li>
        <li>
          <span className="text-zinc-200">No leaks to the network.</span> Every request goes over Tor, each address and each transaction on its own circuit, so no node links your IP to your addresses.
        </li>
        <li>
          <span className="text-zinc-200">No seed phrase, no server.</span> Your keys come from a passkey. Sign in with the same synced passkey on another device to restore everything.
        </li>
        <li>
          <span className="text-zinc-200">Offline cash.</span> With the Prawl Android app you can pay another phone with no network at all, then cash out here.
        </li>
      </ul>
      {!supported && (
        <p className="mt-3 text-xs text-amber-400">
          This browser has no passkey support, so a wallet cannot be created here. Use a recent Chrome, Edge or Safari with a screen lock or security key set up.
        </p>
      )}
      <p className="mt-3 text-xs text-zinc-500">Test network: Sepolia. Do not use it for real money yet.</p>
    </section>
  );
}
