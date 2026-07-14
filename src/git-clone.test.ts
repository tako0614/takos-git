import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createGitWorker, type Env } from "./worker.ts";
import { MemoryBucket } from "./test-bucket.ts";
import { seedRepo } from "./seed.ts";

const REPO = "acme/widgets";
const FILE_CONTENT = "hello from the standalone takos-git service\n";
const READ_TOKEN = "taksrv_git_clone_read";
const WRITE_TOKEN = "taksrv_git_clone_write";
const MCP_TOKEN = "direct-mcp-token-for-git-cli-e2e";

const worker = createGitWorker(async (_input, init) => {
  const authorization = new Headers(init?.headers).get("authorization") ?? "";
  const token = authorization.replace(/^Bearer\s+/u, "");
  if (token !== READ_TOKEN && token !== WRITE_TOKEN) {
    return Response.json({ error: "invalid_token" }, { status: 401 });
  }
  return Response.json({
    token_use: "interface_oauth",
    sub: "principal_git_cli",
    aud: "https://git.example/git",
    scope:
      token === WRITE_TOKEN
        ? "source.git.smart_http.write"
        : "source.git.smart_http.read",
    takosumi: {
      workspace_id: "workspace_e2e",
      capsule_id: "capsule_git",
      interface_id: "interface_git_http",
      interface_binding_id: "binding_git_cli",
      interface_resolved_revision: 9,
    },
  });
});

function runtimeEnv(bucket: MemoryBucket): Env {
  return {
    BUCKET: bucket,
    PUBLISHED_MCP_AUTH_TOKEN: MCP_TOKEN,
    APP_URL: "https://git.example",
    OIDC_ISSUER_URL: "https://accounts.example",
    APP_WORKSPACE_ID: "workspace_e2e",
    APP_CAPSULE_ID: "capsule_git",
  };
}

function canonicalWorkerRequest(request: Request): Request {
  const incoming = new URL(request.url);
  return new Request(
    `https://git.example${incoming.pathname}${incoming.search}`,
    request,
  );
}

function gitAvailable(): boolean {
  try {
    return Bun.spawnSync(["git", "--version"]).exitCode === 0;
  } catch {
    return false;
  }
}

async function runGit(
  args: string[],
  options: { cwd?: string } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const process = Bun.spawn(["git", ...args], {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: { ...globalThis.process.env, GIT_TERMINAL_PROMPT: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test("real `git clone` works end-to-end against the standalone worker", async () => {
  if (!gitAvailable()) {
    console.warn("git binary not available — skipping real clone E2E");
    return;
  }

  const bucket = new MemoryBucket();
  const seeded = await seedRepo(bucket, {
    repo: REPO,
    content: FILE_CONTENT,
    fileName: "README.md",
  });

  const env = runtimeEnv(bucket);
  const server = Bun.serve({
    port: 0,
    fetch: (request) => worker.fetch(canonicalWorkerRequest(request), env),
  });
  const dir = mkdtempSync(join(tmpdir(), "takos-git-clone-"));

  try {
    // git sends the token as the HTTP Basic password (username ignored).
    const cloneUrl = `http://x:${READ_TOKEN}@127.0.0.1:${server.port}/git/${REPO}.git`;
    const clone = Bun.spawn(
      ["git", "-c", "protocol.version=1", "clone", "-q", cloneUrl, dir],
      {
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const exitCode = await clone.exited;
    const stderr = await new Response(clone.stderr).text();
    expect(exitCode, `git clone failed: ${stderr}`).toBe(0);

    // The working tree came through intact...
    expect(readFileSync(join(dir, "README.md"), "utf8")).toBe(FILE_CONTENT);

    // ...and points at the exact commit we seeded.
    const revParse = Bun.spawnSync(["git", "-C", dir, "rev-parse", "HEAD"]);
    expect(new TextDecoder().decode(revParse.stdout).trim()).toBe(
      seeded.commitSha,
    );
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test("git clone is refused without a valid token", async () => {
  if (!gitAvailable()) return;
  const bucket = new MemoryBucket();
  await seedRepo(bucket, { repo: REPO, content: FILE_CONTENT });
  const env = runtimeEnv(bucket);
  const server = Bun.serve({
    port: 0,
    fetch: (request) => worker.fetch(canonicalWorkerRequest(request), env),
  });
  const dir = mkdtempSync(join(tmpdir(), "takos-git-noauth-"));
  try {
    const clone = Bun.spawn(
      [
        "git",
        "-c",
        "protocol.version=1",
        "clone",
        "-q",
        `http://x:bad@127.0.0.1:${server.port}/git/${REPO}.git`,
        dir,
      ],
      {
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await clone.exited).not.toBe(0);
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test("real Git CLI can push, fast-forward, and reclone while force-push is rejected", async () => {
  if (!gitAvailable()) {
    console.warn("git binary not available — skipping push/reclone E2E");
    return;
  }

  const bucket = new MemoryBucket();
  const env = runtimeEnv(bucket);
  const created = await worker.fetch(
    new Request("https://git.example/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${MCP_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "git_repo_create", arguments: { repo: REPO } },
      }),
    }),
    env,
  );
  expect(created.status).toBe(200);
  expect(await created.text()).not.toContain('"error"');

  const server = Bun.serve({
    port: 0,
    fetch: (request) => worker.fetch(canonicalWorkerRequest(request), env),
  });
  const root = mkdtempSync(join(tmpdir(), "takos-git-push-"));
  const source = join(root, "source");
  const clone = join(root, "clone");
  mkdirSync(source);

  try {
    const remote = `http://x:${WRITE_TOKEN}@127.0.0.1:${server.port}/git/${REPO}.git`;
    const readRemote = `http://x:${READ_TOKEN}@127.0.0.1:${server.port}/git/${REPO}.git`;
    expect(
      (await runGit(["init", "-q", "-b", "main"], { cwd: source })).exitCode,
    ).toBe(0);
    await runGit(["config", "user.name", "Takos Git Test"], { cwd: source });
    await runGit(["config", "user.email", "git-test@takos.test"], {
      cwd: source,
    });
    writeFileSync(join(source, "README.md"), "first\n");
    await runGit(["add", "README.md"], { cwd: source });
    await runGit(["commit", "-q", "-m", "first"], { cwd: source });
    await runGit(["remote", "add", "origin", remote], { cwd: source });

    const initialPush = await runGit(["push", "-q", "-u", "origin", "main"], {
      cwd: source,
    });
    expect(initialPush.exitCode, initialPush.stderr).toBe(0);

    writeFileSync(join(source, "README.md"), "second\n");
    await runGit(["add", "README.md"], { cwd: source });
    await runGit(["commit", "-q", "-m", "second"], { cwd: source });
    const fastForward = await runGit(["push", "-q", "origin", "main"], {
      cwd: source,
    });
    expect(fastForward.exitCode, fastForward.stderr).toBe(0);

    const remoteTip = (
      await runGit(["rev-parse", "HEAD"], { cwd: source })
    ).stdout.trim();
    const reclone = await runGit([
      "-c",
      "protocol.version=1",
      "clone",
      "-q",
      readRemote,
      clone,
    ]);
    expect(reclone.exitCode, reclone.stderr).toBe(0);
    expect(readFileSync(join(clone, "README.md"), "utf8")).toBe("second\n");
    expect(
      (await runGit(["rev-parse", "HEAD"], { cwd: clone })).stdout.trim(),
    ).toBe(remoteTip);

    await runGit(["reset", "--hard", "HEAD~1"], { cwd: source });
    const force = await runGit(["push", "--force", "origin", "main"], {
      cwd: source,
    });
    expect(force.exitCode).not.toBe(0);
    expect(force.stderr).toContain("non-fast-forward branch update");
  } finally {
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
