/**
 * SPA assets embedded into the Worker bundle at build time.
 *
 * The install model ships ONE self-contained `dist/worker.js` (no static-asset
 * bucket). `scripts/build-worker.ts` walks `web/dist` and injects the built SPA
 * as `__EMBEDDED_SPA__` via Bun.build `define`, so a Takosumi/OpenTofu install
 * serves the full GitHub-parity UI from the single Worker artifact — no separate
 * assets binding required. In dev/tests the define is absent, so the map is empty
 * and the dev harness supplies `env.ASSETS` instead.
 */

export interface EmbeddedAsset {
  /** Content-Type header. */
  readonly ct: string;
  /** Body: UTF-8 text, or base64 when `e === "base64"`. */
  readonly b: string;
  readonly e?: "base64";
}

// Replaced at build time by Bun.build `define`. `typeof` guard keeps it safe as an
// undeclared global at runtime (tests / dev) without throwing a ReferenceError.
declare const __EMBEDDED_SPA__: Record<string, EmbeddedAsset> | undefined;

export const EMBEDDED_SPA: Record<string, EmbeddedAsset> =
  typeof __EMBEDDED_SPA__ !== "undefined" && __EMBEDDED_SPA__
    ? __EMBEDDED_SPA__
    : {};

/** True when the Worker was built with the SPA embedded (production artifact). */
export function hasEmbeddedSpa(): boolean {
  return Object.keys(EMBEDDED_SPA).length > 0;
}

function bytesFromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Serve a built SPA asset from the embedded map, with a single-page-app deep-link
 * fallback to `/index.html` for non-asset paths. Returns null when nothing embedded
 * matches (a missing hashed `/assets/*` file 404s rather than serving HTML). The
 * caller stamps CSP + cache headers (worker.ts `withAppSecurityHeaders`).
 */
export function serveEmbeddedAsset(pathname: string): Response | null {
  if (!hasEmbeddedSpa()) return null;
  let path = pathname;
  if (path === "/" || path === "") path = "/index.html";

  let asset = EMBEDDED_SPA[path];
  const isHashedAsset = /^\/assets\//u.test(path);
  if (!asset && !isHashedAsset) asset = EMBEDDED_SPA["/index.html"];
  if (!asset) return null;

  const headers = { "content-type": asset.ct };
  if (asset.e === "base64") {
    // Cast: newer TS lib types `Uint8Array<ArrayBufferLike>` doesn't unify with
    // the DOM `BodyInit` BufferSource member; the bytes are a valid body.
    return new Response(bytesFromBase64(asset.b) as unknown as BodyInit, {
      headers,
    });
  }
  return new Response(asset.b, { headers });
}
