import { useEffect, useMemo, useState } from "react";
import { Icon } from "../components/Icon";
import { chapterBySlug, grouped, neighbours, type Block, type Chapter } from "../content/chapters";
import { navigate } from "../lib/router";

/**
 * The handbook: a fixed table of contents on the left, the chapter on the right.
 *
 * The sidebar is its own scroll box, so the page itself never scrolls sideways
 * and the header stays put. On a phone the contents collapse into a <details>.
 */
export function Docs({ slug }: { slug: string }) {
  const chapter = chapterBySlug(slug);
  const [query, setQuery] = useState("");

  // A deep link restores to the top of the reader, not wherever the last page was.
  useEffect(() => {
    document.getElementById("doc-scroll")?.scrollTo({ top: 0 });
  }, [slug]);

  if (!chapter) {
    return (
      <main className="view-enter mx-auto max-w-[1240px] px-5 pt-24 sm:px-8">
        <h1 className="text-2xl font-semibold">No such chapter</h1>
        <p className="mt-2 text-zinc-400">
          That page does not exist.{" "}
          <a href="/docs" className="text-emerald-400 underline" onClick={(e) => (e.preventDefault(), navigate("/docs"))}>
            Start at the introduction
          </a>
          .
        </p>
      </main>
    );
  }

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return grouped();
    return grouped()
      .map((g) => ({
        ...g,
        items: g.items.filter(
          (c) => c.title.toLowerCase().includes(q) || c.summary.toLowerCase().includes(q),
        ),
      }))
      .filter((g) => g.items.length > 0);
  }, [query]);

  const { prev, next } = neighbours(slug);

  return (
    <main className="view-enter mx-auto flex h-full w-full max-w-[1240px] gap-0 pt-16">
      {/* ── Left: every chapter. ── */}
      <aside className="hidden w-[268px] shrink-0 flex-col border-r border-white/[0.06] lg:flex">
        <div className="flex min-h-0 flex-1 flex-col px-4 py-5">
          <label className="relative block">
            <Icon name="spark" className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-600" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search the handbook"
              aria-label="Search the handbook"
              className="w-full rounded-lg border border-zinc-800 bg-zinc-950 py-2 pl-8 pr-3 text-[12.5px] text-zinc-200 placeholder:text-zinc-600 focus:border-emerald-500/50 focus:outline-none"
            />
          </label>

          <nav aria-label="Chapters" className="-mr-1 mt-4 min-h-0 flex-1 space-y-5 overflow-y-auto pr-1.5 [scrollbar-width:thin]">
            {groups.map((g) => (
              <div key={g.group}>
                <p className="mb-1.5 px-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-600">{g.group}</p>
                <ul className="space-y-0.5">
                  {g.items.map((c) => (
                    <li key={c.slug}>
                      <SideLink chapter={c} active={c.slug === chapter.slug} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {groups.length === 0 && <p className="px-2 text-[12.5px] text-zinc-600">Nothing matches “{query}”.</p>}
          </nav>
        </div>
      </aside>

      {/* ── Right: the chapter. ── */}
      <div id="doc-scroll" className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:thin]">
        <div className="mx-auto max-w-[46rem] px-5 pb-16 pt-6 sm:px-8">
          {/* Mobile contents. */}
          <details className="mb-6 rounded-xl border border-zinc-800 bg-zinc-950/60 p-3 lg:hidden">
            <summary className="cursor-pointer text-[13px] font-medium text-zinc-300">Contents</summary>
            <div className="mt-3 space-y-4">
              {grouped().map((g) => (
                <div key={g.group}>
                  <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-600">{g.group}</p>
                  <ul className="space-y-0.5">
                    {g.items.map((c) => (
                      <li key={c.slug}>
                        <SideLink chapter={c} active={c.slug === chapter.slug} />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </details>

          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-emerald-400/80">{chapter.group}</p>
          <h1 className="mt-2 text-[clamp(1.7rem,3vw,2.3rem)] font-semibold tracking-[-0.02em] text-zinc-50">{chapter.title}</h1>

          <div className="mt-7 space-y-4">
            {chapter.blocks.map((b, i) => (
              <Block key={i} b={b} />
            ))}
          </div>

          {/* Prev / next. */}
          <nav aria-label="Chapter navigation" className="mt-12 grid grid-cols-1 gap-2 border-t border-white/[0.06] pt-5 sm:grid-cols-2">
            {prev ? (
              <ChapterLink chapter={prev} dir="prev" />
            ) : (
              <span className="hidden sm:block" />
            )}
            {next && <ChapterLink chapter={next} dir="next" />}
          </nav>
        </div>
      </div>
    </main>
  );
}

function SideLink({ chapter, active }: { chapter: Chapter; active: boolean }) {
  return (
    <a
      href={`/docs/${chapter.slug}`}
      title={chapter.summary}
      aria-current={active ? "page" : undefined}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(`/docs/${chapter.slug}`);
      }}
      className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12.5px] leading-snug transition ${
        active
          ? "bg-emerald-500/10 font-medium text-emerald-300"
          : "text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-100"
      }`}
    >
      <span className={`h-1 w-1 shrink-0 rounded-full ${active ? "bg-emerald-400" : "bg-zinc-700"}`} />
      {chapter.title}
    </a>
  );
}

function ChapterLink({ chapter, dir }: { chapter: Chapter; dir: "prev" | "next" }) {
  const isNext = dir === "next";
  return (
    <a
      href={`/docs/${chapter.slug}`}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(`/docs/${chapter.slug}`);
      }}
      className={`group flex flex-col rounded-xl border border-zinc-800 bg-zinc-950/50 px-4 py-3 transition hover:border-emerald-500/40 hover:bg-zinc-900/60 ${
        isNext ? "sm:text-right" : ""
      }`}
    >
      <span className="text-[10px] uppercase tracking-[0.16em] text-zinc-600">{isNext ? "Next" : "Previous"}</span>
      <span className={`mt-0.5 flex items-center gap-1.5 text-[13px] font-medium text-zinc-200 ${isNext ? "sm:justify-end" : ""}`}>
        {!isNext && <Icon name="chevron" className="h-3.5 w-3.5 rotate-180 text-emerald-400" />}
        {chapter.title}
        {isNext && <Icon name="chevron" className="h-3.5 w-3.5 text-emerald-400" />}
      </span>
    </a>
  );
}

function Block({ b }: { b: Block }) {
  switch (b.t) {
    case "lead":
      return <p className="text-[15px] leading-relaxed text-zinc-300">{b.text}</p>;
    case "p":
      return <p className="text-[13.5px] leading-relaxed text-zinc-400">{b.text}</p>;
    case "h":
      return <h2 className="!mt-8 text-[15px] font-semibold tracking-tight text-zinc-100">{b.text}</h2>;
    case "ul":
      return (
        <ul className="space-y-2">
          {b.items.map((it) => (
            <li key={it} className="flex gap-2.5 text-[13.5px] leading-relaxed text-zinc-400">
              <Icon name="check" className="mt-1 h-3.5 w-3.5 shrink-0 text-emerald-400/80" />
              <span>{it}</span>
            </li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol className="space-y-2">
          {b.items.map((it, i) => (
            <li key={it} className="flex gap-2.5 text-[13.5px] leading-relaxed text-zinc-400">
              <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-[10px] font-semibold text-zinc-300">
                {i + 1}
              </span>
              <span>{it}</span>
            </li>
          ))}
        </ol>
      );
    case "steps":
      return (
        <ol className="space-y-3">
          {b.items.map((s, i) => (
            <li key={s.title} className="relative flex gap-3 rounded-xl border border-zinc-800/80 bg-zinc-950/50 p-3.5">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-emerald-500/30 bg-emerald-500/10 text-[11px] font-semibold text-emerald-300">
                {i + 1}
              </span>
              <span>
                <span className="block text-[13.5px] font-medium text-zinc-100">{s.title}</span>
                <span className="mt-0.5 block text-[13px] leading-relaxed text-zinc-400">{s.text}</span>
              </span>
            </li>
          ))}
        </ol>
      );
    case "note": {
      const tone =
        b.kind === "warn"
          ? "border-amber-500/25 bg-amber-500/[0.07] text-amber-200/90"
          : b.kind === "ok"
            ? "border-emerald-500/25 bg-emerald-500/[0.07] text-emerald-200/90"
            : "border-sky-500/25 bg-sky-500/[0.07] text-sky-200/90";
      const icon = b.kind === "warn" ? "warn" : b.kind === "ok" ? "check" : "info";
      return (
        <div className={`rounded-xl border p-3.5 ${tone}`}>
          <div className="flex gap-2.5">
            <Icon name={icon} className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              {b.title && <p className="text-[12.5px] font-semibold">{b.title}</p>}
              <p className="text-[12.5px] leading-relaxed opacity-90">{b.text}</p>
            </div>
          </div>
        </div>
      );
    }
    case "table":
      return (
        <div className="overflow-x-auto rounded-xl border border-zinc-800">
          <table className="w-full border-collapse text-left text-[12.5px]">
            <thead>
              <tr className="bg-zinc-900/60">
                {b.head.map((h) => (
                  <th key={h} className="whitespace-nowrap px-3 py-2 font-semibold text-zinc-300">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, i) => (
                <tr key={i} className="border-t border-zinc-800/70">
                  {r.map((cell, j) => (
                    <td key={j} className={`px-3 py-2 align-top leading-relaxed ${j === 0 ? "font-medium text-zinc-200" : "text-zinc-400"}`}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "code":
      return (
        <pre className="overflow-x-auto rounded-xl border border-zinc-800 bg-[#0a0b0d] p-3.5 font-mono text-[11.5px] leading-relaxed text-zinc-300">
          <code>{b.text}</code>
        </pre>
      );
  }
}
