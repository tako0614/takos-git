import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

// takos-git is standalone: the SPA's only contract with the worker is the
// same-origin HTTP surface, so there are zero cross-repo path aliases. The one
// in-repo crossing is `src/contract/v1.ts` (the shared `/api/v1` DTOs), imported
// through `web/src/api/contract.ts`; `server.fs.allow` grants the dev server read
// access to that file (the production build has no such restriction).
const WORKER = process.env.TAKOS_GIT_WORKER_URL ?? "http://localhost:8787";
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  plugins: [solid(), tailwindcss()],
  build: {
    // Hashed assets the worker serves via the ASSETS binding (main.tf / wrangler).
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
  },
  server: {
    host: true,
    // Allow importing `../src/contract/v1.ts` (the shared wire contract) in dev.
    fs: { allow: [REPO_ROOT] },
    proxy: {
      "/api": WORKER,
      "/git": WORKER,
      "/mcp": WORKER,
      "/healthz": WORKER,
    },
  },
});
