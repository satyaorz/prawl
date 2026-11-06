/**
 * The site's own tiny router: three views, no dependency.
 *
 *   /            the landing page
 *   /docs        the handbook
 *   /app         (external) the wallet itself
 *
 * It uses the History API and a `popstate` listener. The wallet is a separate
 * deployment on purpose: its passkey (WebAuthn) is bound to the exact origin,
 * so the marketing site must never try to run the wallet on another path.
 */
import { useEffect, useState } from "react";

export type Route = { name: "home" } | { name: "docs"; chapter: string };

/**
 * The path the site is served under: "" at a domain root (Vercel, a custom domain), "/prawl" on a GitHub project page
 * (https://<user>.github.io/prawl/). Set at build time with VITE_BASE (see the build:pages script).
 */
export const BASE: string = import.meta.env.BASE_URL.replace(/\/+$/, "");

/** The URL of a path inside this site ("/docs", "/shots/wallet.png"), including the base path. */
export const url = (path: string): string => BASE + path;

/** The deployed wallet. Overridable at build time: VITE_WALLET_URL. */
export const WALLET_URL: string =
  (import.meta.env.VITE_WALLET_URL as string | undefined) ?? "https://prawl-wallet.centralindia.cloudapp.azure.com";

/**
 * The Android app: the latest GitHub release, whose asset is built by .github/workflows/android-apk.yml and signed with the
 * key the wallet site vouches for (so passkeys work in the app). Overridable at build time: VITE_APK_URL.
 */
export const APK_URL: string =
  (import.meta.env.VITE_APK_URL as string | undefined) ?? "https://github.com/satyaorz/prawl/releases/latest/download/prowl.apk";

function parse(fullPath: string): Route {
  const pathname = fullPath.startsWith(BASE) ? fullPath.slice(BASE.length) || "/" : fullPath;
  if (pathname.startsWith("/docs")) {
    const chapter = pathname.slice("/docs".length).replace(/^\/+/, "");
    return { name: "docs", chapter: chapter || "introduction" };
  }
  return { name: "home" };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parse(window.location.pathname));
  useEffect(() => {
    const onPop = () => setRoute(parse(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return route;
}

/** Navigate without a full reload. */
export function navigate(path: string): void {
  const full = url(path);
  if (full === window.location.pathname) return;
  window.history.pushState({}, "", full);
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo({ top: 0 });
}
