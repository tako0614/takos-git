import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// takos-git is standalone: the SPA's only contract with the worker is the
// same-origin HTTP surface, so there are zero cross-repo path aliases.
const WORKER = process.env.TAKOS_GIT_WORKER_URL ?? "http://localhost:8787";

export default defineConfig({
  plugins: [solid()],
  build: {
    // Hashed assets the worker serves via the ASSETS binding (main.tf / wrangler).
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
  },
  server: {
    host: true,
    proxy: {
      "/api": WORKER,
      "/git": WORKER,
      "/mcp": WORKER,
      "/healthz": WORKER,
    },
  },
});
