import { url } from "../lib/router";
/** The Prowl mark: the yellow smiley, the same file the wallet ships. */
export function Logo({ className = "h-8 w-8" }: { className?: string }) {
  return (
    <img
      src={url("/prowl-logo.png")}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={`${className} select-none object-contain drop-shadow-[0_0_18px_rgba(255,242,26,0.28)]`}
    />
  );
}
