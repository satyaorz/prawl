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
            <span className="w-24 shrink-0 truncate text-zinc-300 sm:w-28">{t.method}</span>
            <span className="min-w-0 flex-1 truncate sm:w-32 sm:flex-none sm:shrink-0">{t.identity}</span>
            <span className="hidden truncate sm:block">{t.circuit}</span>
            <span className="shrink-0 sm:ml-auto">{Math.round(t.durationMs)} ms</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
