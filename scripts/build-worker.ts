/**
 * Builds the prebuilt Worker bundle uploaded by main.tf (`dist/worker.js`).
 *
 * The built SPA under `web/dist` is embedded into the bundle (injected as
 * `__EMBEDDED_SPA__` via Bun.build `define`) so the single Worker artifact serves
 * the GitHub-parity UI with no separate static-asset binding. Run `bun run build`
 * (build:web then build:worker) for a release build. A bare `build:worker`
 * requires an already-built `web/dist`; missing or inconsistent assets fail the
 * build closed.
 */

import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const WEB_DIST = Bun.env.TAKOS_GIT_WEB_DIST?.trim() || "web/dist";
const WORKER_OUTDIR = Bun.env.TAKOS_GIT_WORKER_OUTDIR?.trim() || "dist";

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

interface AssetEvidence {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly contentType: string;
}

interface CollectedSpa {
  readonly embedded: Record<string, EmbeddedAsset>;
  readonly evidence: readonly AssetEvidence[];
  readonly moduleEntrypoints: readonly string[];
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return bytesToHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  );
}

function localModuleEntrypoints(indexHtml: string): string[] {
  const entrypoints: string[] = [];
  for (const script of indexHtml.matchAll(/<script\b[^>]*>/giu)) {
    const tag = script[0];
    if (!/\btype\s*=\s*["']module["']/iu.test(tag)) continue;
    const source = /\bsrc\s*=\s*["']([^"']+)["']/iu.exec(tag)?.[1]?.trim();
    if (!source) continue;
    if (!source.startsWith("/") || source.startsWith("//")) {
      throw new Error(
        `[build-worker] module entrypoint must be a root-relative embedded asset: ${source}`,
      );
    }
    const url = new URL(source, "https://takos-git.invalid");
    if (url.origin !== "https://takos-git.invalid" || url.search || url.hash) {
      throw new Error(
        `[build-worker] module entrypoint must be an exact local asset path: ${source}`,
      );
    }
    entrypoints.push(url.pathname);
  }
  if (entrypoints.length === 0) {
    throw new Error(
      `[build-worker] ${WEB_DIST}/index.html has no local module entrypoint`,
    );
  }
  return [...new Set(entrypoints)].sort();
}

async function collectSpaAssets(): Promise<CollectedSpa> {
  const map: Record<string, EmbeddedAsset> = {};
  if (!(await Bun.file(`${WEB_DIST}/index.html`).exists())) {
    throw new Error(
      `[build-worker] ${WEB_DIST}/index.html missing; refusing to build a deployable Worker without its SPA`,
    );
  }
  const glob = new Bun.Glob("**/*");
  const paths: string[] = [];
  for await (const rel of glob.scan({ cwd: WEB_DIST, onlyFiles: true })) {
    paths.push(rel);
  }
  paths.sort();
  if (paths.length === 0) {
    throw new Error(`[build-worker] ${WEB_DIST} contains no SPA assets`);
  }

  const evidence: AssetEvidence[] = [];
  let bytes = 0;
  for (const rel of paths) {
    const ext = extname(rel).toLowerCase();
    const ct = CONTENT_TYPES[ext] ?? "application/octet-stream";
    const file = Bun.file(`${WEB_DIST}/${rel}`);
    const key = `/${rel.split("/").map(encodeURIComponent).join("/")}`;
    const raw = new Uint8Array(await file.arrayBuffer());
    if (raw.byteLength === 0) {
      throw new Error(`[build-worker] embedded SPA asset is empty: ${key}`);
    }
    if (TEXT_EXT.has(ext)) {
      const body = new TextDecoder().decode(raw);
      map[key] = { ct, b: body };
    } else {
      const buf = Buffer.from(raw);
      map[key] = { ct, b: buf.toString("base64"), e: "base64" };
    }
    evidence.push({
      path: key,
      bytes: raw.byteLength,
      sha256: await sha256(raw),
      contentType: ct,
    });
    bytes += raw.byteLength;
  }

  const index = map["/index.html"];
  if (!index || index.e === "base64") {
    throw new Error(`[build-worker] ${WEB_DIST}/index.html is not UTF-8 HTML`);
  }
  const moduleEntrypoints = localModuleEntrypoints(index.b);
  const evidenceByPath = new Map(evidence.map((asset) => [asset.path, asset]));
  for (const entrypoint of moduleEntrypoints) {
    if (!evidenceByPath.has(entrypoint)) {
      throw new Error(
        `[build-worker] index.html references missing module entrypoint ${entrypoint}`,
      );
    }
  }

  console.log(
    `[build-worker] embedded ${evidence.length} SPA assets (${Math.round(bytes / 1024)} KiB) from ${WEB_DIST}`,
  );
  return { embedded: map, evidence, moduleEntrypoints };
}

const spa = await collectSpaAssets();

const result = await Bun.build({
  entrypoints: ["src/worker.ts"],
  outdir: WORKER_OUTDIR,
  target: "browser",
  format: "esm",
  naming: "worker.js",
  minify: false,
  define: {
    __EMBEDDED_SPA__: JSON.stringify(spa.embedded),
  },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("takos-git worker build failed");
}

const manifest = {
  kind: "takos-git.embedded-spa-assets@v1",
  entrypoint: "/index.html",
  moduleEntrypoints: spa.moduleEntrypoints,
  assets: spa.evidence,
};
await Bun.write(
  `${WORKER_OUTDIR}/embedded-spa-assets.json`,
  `${JSON.stringify(manifest, null, 2)}\n`,
);

const workerPath = resolve(WORKER_OUTDIR, "worker.js");
const built = await import(
  `${pathToFileURL(workerPath).href}?artifact-probe=${Date.now()}`
);
const listener = built.default;
if (!listener || typeof listener.fetch !== "function") {
  throw new Error("[build-worker] built Worker does not export a fetch listener");
}

for (const asset of [
  spa.evidence.find((candidate) => candidate.path === "/index.html"),
  ...spa.moduleEntrypoints.map((path) =>
    spa.evidence.find((candidate) => candidate.path === path),
  ),
]) {
  if (!asset) {
    throw new Error("[build-worker] embedded SPA probe selected a missing asset");
  }
  const response = await listener.fetch(
    new Request(`https://takos-git.invalid${asset.path}`),
    {},
  );
  if (response.status !== 200) {
    throw new Error(
      `[build-worker] built Worker returned ${response.status} for ${asset.path}`,
    );
  }
  const body = new Uint8Array(await response.arrayBuffer());
  if ((await sha256(body)) !== asset.sha256) {
    throw new Error(
      `[build-worker] built Worker returned different bytes for ${asset.path}`,
    );
  }
}

console.log(
  `[build-worker] verified embedded SPA routes: /index.html, ${spa.moduleEntrypoints.join(", ")}`,
);
console.log(`built ${WORKER_OUTDIR}/worker.js`);
