import { useTor } from "../lib/use-tor";

/** Every request the wallet made, with the identity (circuit) it went on. Never shows full addresses. */
export function TraceList() {
  const { traces } = useTor();
  if (traces.length === 0) return null;
  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
      <h2 className="text-sm font-medium">Network log</h2>
      <p className="mt-1 text-xs text-zinc-500">Each identity uses its own Tor circuit. Nothing here leaves this tab.</p>
      <ul className="mt-3 max-h-72 space-y-1 overflow-auto font-mono text-[11px]">
        {[...traces].reverse().map((t) => (
          <li key={t.id} className="flex gap-2 text-zinc-400">
            <span className={t.ok ? "text-emerald-400" : "text-red-400"}>{t.ok ? "✓" : "✗"}</span>
            <span className="w-28 shrink-0 truncate text-zinc-300">{t.method}</span>
            <span className="w-32 shrink-0 truncate">{t.identity}</span>
            <span className="truncate">{t.circuit}</span>
            <span className="ml-auto shrink-0">{Math.round(t.durationMs)} ms</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
