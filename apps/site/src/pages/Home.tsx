import { HeroShots } from "../components/HeroShots";
import { Icon } from "../components/Icon";
import { APK_URL, WALLET_URL } from "../lib/router";

/**
 * The landing page.
 *
 * One viewport, no scrolling: a header (fixed), then two columns — the claim
 * on the left, the product on the right — with the two ways in directly under
 * the screenshots. Everything sizes in `clamp()`/`min-h-0` so it fits a laptop
 * and a phone without a scrollbar.
 */
export function Home() {
  return (
    <main className="view-enter mx-auto flex h-full w-full max-w-[1240px] flex-col overflow-y-auto px-5 pb-2 pt-[4.75rem] sm:overflow-visible sm:px-8 sm:pb-4 sm:pt-16 [@media(max-width:359px)]:overflow-y-auto">
      <div className="grid min-h-0 flex-1 grid-cols-1 items-center gap-4 sm:gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-10">
        {/* ── Left: the punchline and the summary, with the accent rule. ── */}
        <section className="flex min-h-0 flex-col justify-center">
          <div className="relative border-l border-zinc-800 pl-5 sm:pl-7" style={{ maxHeight: "100%" }}>
            {/* The vertical accent on the rule. */}
            <span
              aria-hidden="true"
              className="absolute -left-px top-0 h-16 w-px bg-gradient-to-b from-emerald-400 to-transparent"
            />

            <p className="rise text-[11px] font-medium uppercase tracking-[0.22em] text-emerald-400/90" style={{ animationDelay: "60ms" }}>
              Private wallet · Sepolia
            </p>

            <h1
              className="rise mt-2 text-[clamp(1.75rem,4.4vw,3.4rem)] font-semibold leading-[1.05] tracking-[-0.03em] text-zinc-50 sm:mt-3"
              style={{ animationDelay: "140ms" }}
            >
              Spend like
              <br />
              <span className="shine">nobody is watching.</span>
            </h1>

            <p
              className="rise mt-3 max-w-[46ch] text-[clamp(0.85rem,1.15vw,1.02rem)] leading-relaxed text-zinc-400 sm:mt-5"
              style={{ animationDelay: "220ms" }}
            >
              Prowl is a privacy-first Ethereum wallet. Your balance lives in a{" "}
              <span className="text-zinc-200">shielded pool</span>, every request goes over{" "}
              <span className="text-zinc-200">Tor on its own circuit</span>, and there is{" "}
              <span className="text-zinc-200">no seed phrase and no server</span> — your keys come from a
              passkey. You can swap on Uniswap in <span className="text-zinc-200">encrypted batches</span> (testnet). When there is no signal at all, two phones still pay each other with{" "}
              <span className="text-zinc-200">offline cash</span>.
            </p>

            <ul
              className="mt-4 hidden flex-wrap items-center gap-x-4 gap-y-1.5 text-[12.5px] whitespace-nowrap text-zinc-500 min-[540px]:flex sm:mt-6 [@media(max-height:720px)]:hidden min-[540px]:[@media(min-height:721px)]:flex"
              style={{ animationDelay: "300ms" }}
            >
              {[
                ["shield", "RAILGUN shielded"],
                ["tor", "Tor per identity"],
                ["key", "Passkey, no seed"],
                ["cash", "Offline payments"],
              ].map(([icon, label]) => (
                <li key={label} className="flex items-center gap-1.5">
                  <Icon name={icon as "shield"} className="h-3.5 w-3.5 text-emerald-400/80" />
                  {label}
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ── Right: the product, then the two ways in. ── */}
        <section className="flex min-h-0 flex-col justify-center">
          {/* The stack takes only the space the buttons leave, so on a short
              screen it shrinks instead of pushing them off. On a phone the
              stack gets a share of the height; on desktop a taller share. */}
          <div className="h-[min(28vh,22rem)] shrink-0 pb-5 lg:h-[clamp(16rem,44vh,32rem)]">
            <HeroShots />
          </div>

          <div className="rise mt-2 grid grid-cols-1 gap-2.5 sm:grid-cols-2" style={{ animationDelay: "420ms" }}>
            <a
              href={WALLET_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="group relative inline-flex items-center justify-center gap-2 overflow-hidden rounded-full bg-emerald-500 px-5 py-3 text-[13.5px] font-semibold text-zinc-950 transition hover:bg-emerald-400 active:scale-[0.99]"
            >
              <Icon name="external" className="h-4 w-4" />
              Open in browser
              <span className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/25 to-transparent transition-transform duration-700 group-hover:translate-x-full" />
            </a>
            <a
              href={APK_URL}
              rel="noopener"
              className="group inline-flex items-center justify-center gap-2 rounded-full border border-zinc-700 bg-zinc-900/60 px-5 py-3 text-[13.5px] font-medium text-zinc-100 transition hover:border-zinc-600 hover:bg-zinc-800/70 active:scale-[0.99]"
            >
              <Icon name="download" className="h-4 w-4 text-emerald-400" />
              Download APK
              <span className="text-[11px] font-normal text-zinc-500">Android</span>
            </a>
          </div>

          {/* On a very short viewport there is no room for the footnote: the
              buttons say what they do on their own. */}
          <p className="mt-2 hidden text-center text-[11px] leading-snug text-zinc-600 min-[400px]:block sm:text-left [@media(max-height:700px)]:hidden sm:[@media(min-height:701px)]:block">
            The browser wallet opens on its own origin (passkeys are bound to it). The APK is the
            Android app, for offline cash.
          </p>
        </section>
      </div>
    </main>
  );
}
