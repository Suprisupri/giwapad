import { defineConfig } from "vite";

// Relative base so the built site works from any path:
// repo root, /docs, or a GitHub Pages project subpath (suprisupri.github.io/giwapad/).
export default defineConfig({
  base: "./",
  build: {
    outDir: "dist",
    // The Ammora SDK is large; keep the warning threshold realistic.
    chunkSizeWarningLimit: 1500,
  },
});
