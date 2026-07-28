import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const roots: string[] = [];

async function fixture(
  files: Readonly<Record<string, string>>,
): Promise<{ webDist: string; outDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "takos-git-worker-build-"));
  roots.push(root);
  const webDist = join(root, "web-dist");
  const outDir = join(root, "out");
  await mkdir(webDist, { recursive: true });
  for (const [path, body] of Object.entries(files)) {
    const target = join(webDist, path);
    await mkdir(join(target, ".."), { recursive: true });
    await Bun.write(target, body);
  }
  return { webDist, outDir };
}

async function build(files: Readonly<Record<string, string>>) {
  const { webDist, outDir } = await fixture(files);
  const child = Bun.spawn(
    [process.execPath, "run", "scripts/build-worker.ts"],
    {
      cwd: new URL("..", import.meta.url).pathname,
      env: {
        ...Bun.env,
        TAKOS_GIT_WEB_DIST: webDist,
        TAKOS_GIT_WORKER_OUTDIR: outDir,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, output: `${stdout}\n${stderr}`, outDir };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("Worker artifact build contract", () => {
  test("fails closed when the SPA entrypoint is absent", async () => {
    const result = await build({});
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("index.html");
  }, 120_000);

  test("fails closed when the SPA has no browser module entrypoint", async () => {
    const result = await build({
      "index.html": "<!doctype html><html><body>Takos Git</body></html>",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("module entrypoint");
  }, 30_000);

  test("fails closed when an entrypoint asset is empty", async () => {
    const result = await build({
      "index.html":
        '<!doctype html><html><body>Takos Git<script type="module" src="/assets/app.js"></script></body></html>',
      "assets/app.js": "",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("/assets/app.js");
  }, 30_000);

  test("emits a hashed asset manifest and probes the built Worker routes", async () => {
    const result = await build({
      "index.html":
        '<!doctype html><html><body>Takos Git<div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>',
      "assets/app.js": 'document.querySelector("#root").textContent = "ready";',
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("verified embedded SPA routes");

    const manifest = await Bun.file(
      join(result.outDir, "embedded-spa-assets.json"),
    ).json();
    expect(manifest).toMatchObject({
      kind: "takos-git.embedded-spa-assets@v1",
      entrypoint: "/index.html",
      assets: [
        { path: "/assets/app.js", bytes: 54 },
        { path: "/index.html" },
      ],
    });
    for (const asset of manifest.assets) {
      expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  }, 30_000);
});
