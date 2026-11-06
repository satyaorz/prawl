import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { prawlLocalAssets } from "./vite/local-assets";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export default defineConfig({
  plugins: [react(), tailwindcss(), prawlLocalAssets(repoRoot)],
  server: { port: 5173, strictPort: true, host: "127.0.0.1" },
  preview: { port: 4173, strictPort: true, host: "127.0.0.1" },
  build: { target: "es2022" },
});
