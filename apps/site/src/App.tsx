import { useEffect } from "react";
import { TopBar } from "./components/TopBar";
import { useRoute } from "./lib/router";
import { Docs } from "./pages/Docs";
import { Home } from "./pages/Home";

export function App() {
  const route = useRoute();

  // The title is the only state that lives outside React here; keep it honest.
  useEffect(() => {
    document.title = route.name === "docs" ? "Prowl — docs" : "Prowl — the private wallet";
  }, [route]);

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-[#08090b]">
      {/* Atmosphere: a grid and two coloured glows behind everything. */}
      <div aria-hidden="true" className="prowl-grid pointer-events-none absolute inset-0" />
      <div aria-hidden="true" className="prowl-glow pointer-events-none absolute inset-0" />

      <TopBar active={route.name === "docs" ? "docs" : "home"} />

      <div className="relative z-10 min-h-0 flex-1">
        {route.name === "docs" ? <Docs slug={route.chapter} /> : <Home />}
      </div>
    </div>
  );
}
