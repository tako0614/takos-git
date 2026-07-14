/**
 * Builds the prebuilt Worker bundle uploaded by main.tf (`dist/worker.js`).
 *
 * The built SPA under `web/dist` is embedded into the bundle (injected as
 * `__EMBEDDED_SPA__` via Bun.build `define`) so the single Worker artifact serves
 * the GitHub-parity UI with no separate static-asset binding. Run `bun run build`
 * (build:web then build:worker) for a release build; a bare `build:worker` with no
 * `web/dist` embeds nothing and warns.
 */

import { extname } from "node:path";

const WEB_DIST = "web/dist";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

const TEXT_EXT = new Set([
  ".html", ".js", ".mjs", ".css", ".json", ".map", ".svg", ".txt", ".webmanifest",
]);

interface EmbeddedAsset {
  ct: string;
  b: string;
  e?: "base64";
}

async function collectSpaAssets(): Promise<Record<string, EmbeddedAsset>> {
  const map: Record<string, EmbeddedAsset> = {};
  if (!(await Bun.file(`${WEB_DIST}/index.html`).exists())) {
    console.warn(
      `[build-worker] ${WEB_DIST}/index.html missing — building worker WITHOUT embedded SPA. Run \`bun run build:web\` first (or \`bun run build\`).`,
    );
    return map;
  }
  const glob = new Bun.Glob("**/*");
  let count = 0;
  let bytes = 0;
  for await (const rel of glob.scan({ cwd: WEB_DIST, onlyFiles: true })) {
    const ext = extname(rel).toLowerCase();
    const ct = CONTENT_TYPES[ext] ?? "application/octet-stream";
    const file = Bun.file(`${WEB_DIST}/${rel}`);
    const key = `/${rel.split("/").map(encodeURIComponent).join("/")}`;
    if (TEXT_EXT.has(ext)) {
      const body = await file.text();
      map[key] = { ct, b: body };
      bytes += body.length;
    } else {
      const buf = Buffer.from(await file.arrayBuffer());
      map[key] = { ct, b: buf.toString("base64"), e: "base64" };
      bytes += buf.length;
    }
    count += 1;
  }
  console.log(`[build-worker] embedded ${count} SPA assets (${Math.round(bytes / 1024)} KiB) from ${WEB_DIST}`);
  return map;
}

const spa = await collectSpaAssets();

const result = await Bun.build({
  entrypoints: ["src/worker.ts"],
  outdir: "dist",
  target: "browser",
  format: "esm",
  naming: "worker.js",
  minify: false,
  define: {
    __EMBEDDED_SPA__: JSON.stringify(spa),
  },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("takos-git worker build failed");
}

console.log("built dist/worker.js");
