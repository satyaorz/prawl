import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { startTor } from "./lib/anon";
import "./index.css";

// Tor boots at page load, before anything asks for chain data.
startTor();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
