import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5181, strictPort: true, host: "localhost" },
  preview: { port: 5181, strictPort: true, host: "localhost" },
  // "/" at a domain root; the Pages build sets VITE_BASE=/prawl/ (a GitHub project page lives under a sub-path).
  base: process.env.VITE_BASE ?? "/",
  build: { target: "es2022" },
});
