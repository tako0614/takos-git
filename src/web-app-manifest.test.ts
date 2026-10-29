import { describe, expect, test } from "bun:test";

import worker, { type AssetFetcher, type Env } from "./worker.ts";
import { MemoryBucket } from "./test-bucket.ts";

// Home-screen install contract: web/public is copied verbatim into web/dist,
// which scripts/build-worker.ts embeds into the single Worker artifact.
const PUBLIC_DIR = new URL("../web/public/", import.meta.url);

interface ManifestIcon {
  readonly src: string;
  readonly sizes: string;
  readonly type: string;
  readonly purpose: string;
}

async function pngSize(
  path: string,
): Promise<{ width: number; height: number }> {
  const file = Bun.file(new URL(path.replace(/^\//u, ""), PUBLIC_DIR));
  expect(await file.exists()).toBe(true);
  const bytes = new Uint8Array(await file.arrayBuffer());
  // PNG signature, then the IHDR chunk: width/height are big-endian u32 at 16/20.
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(new TextDecoder().decode(bytes.subarray(12, 16))).toBe("IHDR");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function cspDirectives(csp: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const part of csp.split(";")) {
    const [name, ...values] = part.trim().split(/\s+/u);
    if (name) directives.set(name.toLowerCase(), values);
  }
  return directives;
}

describe("web app manifest", () => {
  test("declares a standalone same-origin app", async () => {
    const manifest = await Bun.file(
      new URL("manifest.webmanifest", PUBLIC_DIR),
    ).json();
    expect(manifest).toMatchObject({
      name: "Takos Git",
      short_name: "Takos Git",
      lang: "en",
      start_url: "/",
      scope: "/",
      display: "standalone",
      theme_color: "#ffffff",
      background_color: "#ffffff",
    });
    expect(typeof manifest.description).toBe("string");
    expect(manifest.description.length).toBeGreaterThan(0);
  });

  test("every declared icon exists at its declared pixel size", async () => {
    const manifest = await Bun.file(
      new URL("manifest.webmanifest", PUBLIC_DIR),
    ).json();
    const icons = manifest.icons as ManifestIcon[];
    expect(icons.map((icon) => `${icon.sizes}:${icon.purpose}`).sort()).toEqual(
      ["192x192:any", "512x512:any", "512x512:maskable"],
    );
    for (const icon of icons) {
      expect(icon.src.startsWith("/")).toBe(true);
      expect(icon.type).toBe("image/png");
      const [width, height] = icon.sizes.split("x").map(Number);
      expect(await pngSize(icon.src)).toEqual({ width, height });
    }
  });

  test("index.html links the manifest, a 180px apple-touch-icon and theme-color", async () => {
    const html = await Bun.file(
      new URL("../web/index.html", import.meta.url),
    ).text();
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    const touch = /<link rel="apple-touch-icon" sizes="180x180" href="([^"]+)"/u.exec(
      html,
    );
    expect(touch).not.toBeNull();
    expect(await pngSize(touch![1]!)).toEqual({ width: 180, height: 180 });
    expect(html).toContain('<meta name="theme-color" content="#ffffff"');
    // The launcher SVG stays the favicon.
    expect(html).toContain('<link rel="icon" href="/icons/takos-git.svg" />');
  });

  test("the SPA document CSP lets the same-origin manifest and icons load", async () => {
    const assets: AssetFetcher = {
      fetch: async () =>
        new Response("<!doctype html><div id=root></div>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    };
    const env: Env = { BUCKET: new MemoryBucket(), ASSETS: assets };
    const res = await worker.fetch(new Request("https://git.example/"), env);
    expect(res.status).toBe(200);
    const csp = cspDirectives(res.headers.get("content-security-policy") ?? "");
    const manifestSrc = csp.get("manifest-src") ?? csp.get("default-src");
    const imgSrc = csp.get("img-src") ?? csp.get("default-src");
    expect(manifestSrc).toContain("'self'");
    expect(imgSrc).toContain("'self'");
  });
});
