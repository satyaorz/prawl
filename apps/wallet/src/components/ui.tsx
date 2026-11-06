import { useEffect, useId, useRef, type ReactNode } from "react";

/** Small inline icons (stroke, currentColor): no icon font, no network. */
const ICONS = {
  receive: "M12 4v12m0 0-4-4m4 4 4-4M5 20h14",
  send: "M7 17 17 7m0 0H8m9 0v9",
  shield: "M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Zm-3 9 2 2 4-4",
  withdraw: "M12 20V8m0 0-4 4m4-4 4 4M5 4h14",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
  lock: "M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z",
  copy: "M9 9h10v11H9zM5 15V4h10",
  qr: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v6h-4M14 18h2",
  wallet: "M4 7h15a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h12M16 13h2",
  offline: "M12 19h.01M8.5 15.5a5 5 0 0 1 7 0M5 12a10 10 0 0 1 4-2.4M19 12a10 10 0 0 0-3.3-2.2M3 3l18 18",
  settings: "M4 7h9m4 0h3M4 17h3m4 0h9M15 4v6M9 14v6",
  close: "M6 6l12 12M18 6 6 18",
  check: "M5 12.500 10 17.500 19 7",
  chevron: "m9 6 6 6-6 6",
  activity: "M4 12h4l3-8 4 16 3-8h2",
} as const;
export type IconName = keyof typeof ICONS;

export function Icon({ name, className = "h-5 w-5" }: { name: IconName; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

/** The Prowl mark: the smiley (public/prowl-logo.png). Decorative: the name is always written next to it. */
export function Logo({ className = "h-7 w-7" }: { className?: string }) {
  return <img src="/prowl-logo.png" alt="" aria-hidden="true" className={`${className} select-none object-contain`} draggable={false} />;
}

/** Ether diamond in a round badge. */
export function EthIcon({ className = "h-10 w-10" }: { className?: string }) {
  return (
    <span className={`inline-flex shrink-0 items-center justify-center rounded-full bg-zinc-800 ${className}`}>
      <svg viewBox="0 0 24 24" className="h-1/2 w-1/2" aria-hidden="true">
        <path d="M12 2 5.500 12.200 12 16l6.500-3.800L12 2Z" fill="#a1a1aa" />
        <path d="M12 17.200 5.500 13.400 12 22l6.500-8.600-6.500 3.800Z" fill="#71717a" />
      </svg>
    </span>
  );
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** A round gradient avatar derived from an address (deterministic, like a blockies/jazzicon). */
export function Identicon({ seed, className = "h-8 w-8" }: { seed: string; className?: string }) {
  const h = hash(seed.toLowerCase());
  const a = h % 360;
  const b = (a + 60 + ((h >> 9) % 140)) % 360;
  const angle = (h >> 17) % 360;
  return (
    <span
      aria-hidden="true"
      className={`inline-block shrink-0 rounded-full ${className}`}
      style={{ background: `linear-gradient(${angle}deg, hsl(${a} 70% 55%), hsl(${b} 75% 45%))` }}
    />
  );
}

/** A round action button with a label under it (Receive, Shield, Send, Withdraw). */
export function ActionButton({ icon, label, onClick, disabled }: { icon: IconName; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled} className="group flex w-16 flex-col items-center gap-1.5 text-xs text-zinc-300 disabled:opacity-40">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500 text-zinc-950 transition group-hover:bg-emerald-400 group-active:scale-95">
        <Icon name={icon} className="h-5 w-5" />
      </span>
      {label}
    </button>
  );
}

/** A bottom sheet (full width on a phone, a centred card on desktop). Esc and the backdrop close it. */
export function Sheet({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    ref.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", key);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} aria-hidden="true" />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        tabIndex={-1}
        className="relative flex max-h-[92%] w-full max-w-[420px] flex-col rounded-t-3xl border border-zinc-800 bg-zinc-950 outline-none sm:rounded-3xl"
      >
        <div className="flex items-center justify-between px-5 pb-2 pt-4">
          <h2 id={id} className="text-base font-semibold">
            {title}
          </h2>
          <button onClick={onClose} aria-label="Close" className="rounded-full p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">
            <Icon name="close" className="h-5 w-5" />
          </button>
        </div>
        {/* The cards inside are the same ones as on a page: drop their own frame in a sheet. */}
        <div className="flex-1 overflow-y-auto px-5 pb-6 [&_section]:rounded-none [&_section]:border-0 [&_section]:bg-transparent [&_section]:p-0">{children}</div>
      </div>
    </div>
  );
}

export const short = (s: string, head = 6, tail = 4): string => (s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s);

/**
 * An ETH amount for a big headline or a row: at most `decimals` decimals, trailing zeros dropped, and "<0.000001" for a dust amount, so it
 * always fits a phone screen. The exact value stays available in the smaller text under it.
 */
export function fmtEthShort(wei: bigint, decimals = 6): string {
  const scale = 10n ** BigInt(18 - decimals);
  const q = wei / scale;                                  // truncated, never rounded up: it must not promise more than there is
  if (wei > 0n && q === 0n) return `<0.${"0".repeat(decimals - 1)}1`;
  const whole = q / 10n ** BigInt(decimals);
  const frac = (q % 10n ** BigInt(decimals)).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}
