import { Logo } from "./Logo";
import { navigate, WALLET_URL } from "../lib/router";

/**
 * The permanent dashboard: always at the top, on every page, never scrolls away.
 *
 * It holds exactly four things — the mark, the name, and three destinations:
 * App, Docs, Open. The mark and the name go home.
 */
export function TopBar({ active }: { active: "home" | "docs" }) {
  const go = (e: React.MouseEvent, path: string) => {
    // Let the browser handle modified clicks (new tab, new window) as usual.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(path);
  };

  return (
    <header className="fixed inset-x-0 top-0 z-50 border-b border-white/[0.06] bg-[#08090b]/80 backdrop-blur-xl">
      <nav aria-label="Main" className="mx-auto flex h-16 max-w-[1240px] items-center gap-3 px-5 sm:px-8">
        {/* The mark and the name: the way home. */}
        <a
          href="/"
          onClick={(e) => go(e, "/")}
          className="group flex items-center gap-2.5 rounded-full pr-2 transition-opacity hover:opacity-90"
          aria-label="Prowl home"
        >
          <Logo className="h-8 w-8 transition-transform duration-500 group-hover:rotate-[14deg]" />
          <span className="text-[17px] font-semibold tracking-tight text-zinc-100">Prowl</span>
        </a>

        <span className="ml-1 hidden rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-emerald-300 sm:inline">
          Testnet
        </span>

        <div className="ml-auto flex items-center gap-1">
          <TopLink href="/" active={active === "home"} onClick={(e) => go(e, "/")}>
            App
          </TopLink>
          <TopLink href="/docs" active={active === "docs"} onClick={(e) => go(e, "/docs")}>
            Docs
          </TopLink>
          <a
            href={WALLET_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-1.5 inline-flex items-center gap-1.5 rounded-full bg-emerald-500 px-4 py-1.5 text-[13px] font-semibold text-zinc-950 transition hover:bg-emerald-400 active:scale-[0.98]"
          >
            Open
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className="h-3.5 w-3.5" aria-hidden="true">
              <path d="M7 17 17 7m0 0H8m9 0v9" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </a>
        </div>
      </nav>
    </header>
  );
}

function TopLink({
  href,
  active,
  onClick,
  children,
}: {
  href: string;
  active: boolean;
  onClick: (e: React.MouseEvent) => void;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`relative rounded-full px-3.5 py-1.5 text-[13px] font-medium transition ${
        active ? "text-zinc-100" : "text-zinc-400 hover:text-zinc-100"
      }`}
    >
      {children}
      <span
        className={`absolute inset-x-3.5 -bottom-px h-px bg-emerald-400 transition-transform duration-300 ${
          active ? "scale-x-100" : "scale-x-0"
        }`}
      />
    </a>
  );
}
