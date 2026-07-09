import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import worker, { type Env } from "./worker.ts";
import { MemoryBucket } from "./test-bucket.ts";
import { seedRepo } from "./seed.ts";
import { mintGitToken } from "./git-token.ts";

const SIGNING_KEY = "git-clone-e2e-signing-key-000";
const REPO = "acme/widgets";
const FILE_CONTENT = "hello from the standalone takos-git service\n";

function gitAvailable(): boolean {
  try {
    return Bun.spawnSync(["git", "--version"]).exitCode === 0;
  } catch {
    return false;
  }
}

test("real `git clone` works end-to-end against the standalone worker", async () => {
  if (!gitAvailable()) {
    console.warn("git binary not available — skipping real clone E2E");
    return;
  }

  const bucket = new MemoryBucket();
  const seeded = await seedRepo(bucket, { repo: REPO, content: FILE_CONTENT, fileName: "README.md" });

  const now = Math.floor(Date.now() / 1000);
  const token = await mintGitToken(SIGNING_KEY, {
    v: 1,
    ws: "space_e2e",
    sub: "inst_e2e",
    pfx: REPO,
    cap: ["r"],
    aud: "source.git.smart_http",
    iat: now,
    exp: now + 3600,
  });

  const env: Env = { BUCKET: bucket, GIT_TOKEN_SIGNING_KEY: SIGNING_KEY };
  const server = Bun.serve({ port: 0, fetch: (request) => worker.fetch(request, env) });
  const dir = mkdtempSync(join(tmpdir(), "takos-git-clone-"));

  try {
    // git sends the token as the HTTP Basic password (username ignored).
    const cloneUrl = `http://x:${token}@127.0.0.1:${server.port}/git/${REPO}.git`;
    const clone = Bun.spawn(
      ["git", "-c", "protocol.version=1", "clone", "-q", cloneUrl, dir],
      { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, stdout: "pipe", stderr: "pipe" },
    );
    const exitCode = await clone.exited;
    const stderr = await new Response(clone.stderr).text();
    expect(exitCode, `git clone failed: ${stderr}`).toBe(0);

    // The working tree came through intact...
    expect(readFileSync(join(dir, "README.md"), "utf8")).toBe(FILE_CONTENT);

    // ...and points at the exact commit we seeded.
    const revParse = Bun.spawnSync(["git", "-C", dir, "rev-parse", "HEAD"]);
    expect(new TextDecoder().decode(revParse.stdout).trim()).toBe(seeded.commitSha);
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test("git clone is refused without a valid token", async () => {
  if (!gitAvailable()) return;
  const bucket = new MemoryBucket();
  await seedRepo(bucket, { repo: REPO, content: FILE_CONTENT });
  const env: Env = { BUCKET: bucket, GIT_TOKEN_SIGNING_KEY: SIGNING_KEY };
  const server = Bun.serve({ port: 0, fetch: (request) => worker.fetch(request, env) });
  const dir = mkdtempSync(join(tmpdir(), "takos-git-noauth-"));
  try {
    const clone = Bun.spawn(
      ["git", "-c", "protocol.version=1", "clone", "-q", `http://x:bad@127.0.0.1:${server.port}/git/${REPO}.git`, dir],
      { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, stdout: "pipe", stderr: "pipe" },
    );
    expect(await clone.exited).not.toBe(0);
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
