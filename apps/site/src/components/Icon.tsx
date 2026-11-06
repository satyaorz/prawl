/** Small stroke icons (currentColor), matching the wallet's own icon set. */
export const ICONS = {
  arrow: "M7 17 17 7m0 0H8m9 0v9",
  external: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  download: "M12 4v12m0 0-4-4m4 4 4-4M5 20h14",
  book: "M4 5a2 2 0 0 1 2-2h13v18H6a2 2 0 0 1-2-2V5Zm3 0h9M4 17h15",
  phone: "M7 3h10a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM11 18h2",
  shield: "M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Zm-3 9 2 2 4-4",
  lock: "M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z",
  tor: "M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm0-5a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  cash: "M4 7h16v10H4zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z",
  check: "M5 12.5 10 17.5 19 7",
  chevron: "m9 6 6 6-6 6",
  key: "M15 7a4 4 0 1 1-3.2 6.4L5 20H3v-2l6.6-6.8A4 4 0 0 1 15 7Z",
  github: "M9 19c-4 1.5-4-2.5-6-3m12 5v-3.9a3.4 3.4 0 0 0-1-2.6c3-.3 6-1.5 6-6.6a5.2 5.2 0 0 0-1.4-3.6 4.8 4.8 0 0 0-.1-3.6s-1.1-.3-3.6 1.4a12.4 12.4 0 0 0-6.6 0C6.1 .9 5 1.2 5 1.2a4.8 4.8 0 0 0-.1 3.6A5.2 5.2 0 0 0 3.5 8.4c0 5 3 6.3 6 6.6a3.4 3.4 0 0 0-1 2.6V21",
  spark: "M12 3v4m0 10v4M3 12h4m10 0h4M5.6 5.6l2.8 2.8m7.2 7.2 2.8 2.8m0-12.8-2.8 2.8M8.4 15.6l-2.8 2.8",
  warn: "M12 9v4m0 3h.01M10.3 3.9 2.5 17a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
  swap: "M4 8h15m0 0-3-3m3 3-3 3M20 16H5m0 0 3-3m-3 3 3 3",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-9v5m0-8h.01",
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, className = "h-5 w-5" }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d={ICONS[name]} />
    </svg>
  );
}
