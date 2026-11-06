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

/** The deployed wallet. Overridable at build time: VITE_WALLET_URL. */
export const WALLET_URL: string =
  (import.meta.env.VITE_WALLET_URL as string | undefined) ?? "https://prawl-wallet.centralindia.cloudapp.azure.com";

/** The APK shipped from this site's own /apk/prowl.apk. */
export const APK_URL = "/apk/prowl.apk";

function parse(pathname: string): Route {
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
  if (path === window.location.pathname) return;
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo({ top: 0 });
}
