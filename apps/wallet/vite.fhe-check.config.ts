import { defineConfig } from "vite";

// Standalone bundling check for the swap worker while it is feature-gated.
export default defineConfig({
  build: {
    target: "es2022",
    outDir: "/tmp/prawl-fhe-bundle-check",
    emptyOutDir: false,
    lib: { entry: "src/swap/fhe-controller.ts", formats: ["es"], fileName: "fhe-controller" },
  },
  worker: { format: "es" },
});
