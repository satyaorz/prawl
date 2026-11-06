import { useTor } from "../lib/use-tor";

const PHASE: Record<string, { label: string; dot: string }> = {
  idle: { label: "Not started", dot: "bg-zinc-500" },
  booting: { label: "Connecting to Tor", dot: "bg-amber-400 animate-pulse" },
  ready: { label: "Connected over Tor", dot: "bg-emerald-400" },
  failed: { label: "Tor failed", dot: "bg-red-500" },
};

function short(s: string, n = 10): string {
  return s.length > n * 2 ? `${s.slice(0, n)}…${s.slice(-6)}` : s;
}

export function TorStatusCard() {
  const tor = useTor();
  const phase = PHASE[tor.phase] ?? PHASE.idle!;
  const done = tor.traces.filter((t) => t.ok).length;
  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
      <div className="flex items-center gap-3">
        <span className={`h-2.5 w-2.5 rounded-full ${phase.dot}`} />
        <h2 className="text-sm font-medium">{phase.label}</h2>
        {tor.bootMs !== undefined && tor.phase === "ready" && (
          <span className="ml-auto text-xs text-zinc-400">ready in {(tor.bootMs / 1000).toFixed(1)} s</span>
        )}
      </div>
      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
        <dt className="text-zinc-500">Gateway</dt>
        <dd className="font-mono text-zinc-300">
          {tor.ownGateway ? "own (this laptop)" : "public demo"} · {short(tor.gateway, 14)}
        </dd>
        <dt className="text-zinc-500">Worker</dt>
        <dd className="font-mono text-zinc-300">{tor.worker}</dd>
        <dt className="text-zinc-500">Directory</dt>
        <dd className="font-mono text-zinc-300">
          {tor.bootstrapBytes ? `own snapshot, ${(tor.bootstrapBytes / 1e6).toFixed(2)} MB` : "fetched through gateway"}
        </dd>
        <dt className="text-zinc-500">Requests</dt>
        <dd className="font-mono text-zinc-300">
          {done} ok / {tor.traces.length} attempts
        </dd>
      </dl>
      {tor.error && <p className="mt-3 text-xs text-red-400">{tor.error}</p>}
    </section>
  );
}
