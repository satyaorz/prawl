import { useEffect, useState } from "react";
import { url } from "../lib/router";

/**
 * Three real screens from the Android app, overlapping like cards fanned on a table.
 *
 * The screenshots are captured from a real phone running the app (the address text is blurred; the
 * balances are test-network ETH). The front card cycles through three of them on a timer (and on hover
 * it pauses), so the hero shows the product working without a video: balance, sending, offline cash.
 * Purely CSS transforms, no libraries.
 */
const SHOTS = [
  { src: url("/shots/wallet.png"), label: "Your private balance" },
  { src: url("/shots/send.png"), label: "Send privately or publicly" },
  { src: url("/shots/offline.png"), label: "Offline cash, phone to phone" },
] as const;

export function HeroShots() {
  const [idx, setIdx] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) return;
    const t = window.setInterval(() => setIdx((i) => (i + 1) % SHOTS.length), 3800);
    return () => window.clearInterval(t);
  }, [paused]);

  return (
    <div
      className="relative flex h-full w-full items-center justify-center"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {/* Glow beneath the stack. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute h-[26rem] w-[26rem] rounded-full bg-emerald-500/12 blur-[90px]"
      />

      {/* The stack is sized by its tallest card and can never grow past the
          space the page gives it: the frames are scaled from a single height. */}
      <div className="relative h-full w-full">
        {/* Back card: the welcome screen, tilted away. */}
        <Phone
          src={url("/shots/welcome.png")}
          alt="The Prowl welcome screen"
          className="absolute left-[4%] top-[16%] h-[76%] w-auto -rotate-[9deg] opacity-65 blur-[0.6px]"
          delay="120ms"
        />

        {/* Middle card: the private swap. */}
        <Phone
          src={url("/shots/swap.png")}
          alt="The Prowl private swap screen"
          className="absolute left-[24%] top-[9%] h-[84%] w-auto rotate-[3deg] opacity-90"
          delay="220ms"
        />

        {/* Front card: cycles through the screens. */}
        <div className="rise absolute right-[2%] top-0 z-20 h-full" style={{ animationDelay: "320ms" }}>
          <div className="relative h-full">
            {SHOTS.map((shot, i) => (
              <img
                key={shot.src}
                src={shot.src}
                alt={i === idx ? `Prowl wallet: ${shot.label}` : ""}
                draggable={false}
                className={`h-full w-auto select-none rounded-[1.4rem] border border-white/10 shadow-[0_40px_80px_-20px_rgba(0,0,0,0.9)] transition-all duration-700 ease-out ${
                  i === idx ? "opacity-100" : "absolute inset-0 opacity-0"
                }`}
              />
            ))}
          </div>

          {/* Dots: which screen is in front. */}
          <div className="absolute -bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-1.5">
            {SHOTS.map((shot, i) => (
              <button
                key={shot.src}
                onClick={() => setIdx(i)}
                aria-label={shot.label}
                aria-current={i === idx}
                className={`h-1.5 rounded-full transition-all duration-300 ${
                  i === idx ? "w-5 bg-emerald-400" : "w-1.5 bg-zinc-700 hover:bg-zinc-500"
                }`}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Phone({ src, alt, className, delay }: { src: string; alt: string; className: string; delay: string }) {
  return (
    <div className={`rise ${className}`} style={{ animationDelay: delay }}>
      <img
        src={src}
        alt={alt}
        draggable={false}
        className="h-full w-auto select-none rounded-[1.3rem] border border-white/10 shadow-[0_30px_70px_-25px_rgba(0,0,0,0.95)]"
      />
    </div>
  );
}
