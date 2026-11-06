import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5181, strictPort: true, host: "localhost" },
  preview: { port: 5181, strictPort: true, host: "localhost" },
  build: { target: "es2022" },
});
