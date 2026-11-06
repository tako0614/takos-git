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
import {
  jsonRequest,
  makeEnv,
  TEST_APP_URL,
  TEST_CAPSULE,
  TEST_WORKSPACE,
} from "./features/repos/testkit.ts";

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

const NULL_FILE = process.platform === "win32" ? "NUL" : "/dev/null";

function gitCommand(args: string[]): string[] {
  return [
    "git", "-c", "credential.helper=", "-c", "http.proxy=",
    "-c", `core.hooksPath=${NULL_FILE}`, "-c", "core.fsmonitor=false",
    "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args,
  ];
}

function gitEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: NULL_FILE,
    GIT_CONFIG_GLOBAL: NULL_FILE, GIT_TERMINAL_PROMPT: "0",
    LANG: "C", LC_ALL: "C",
  };
  // Deliberate allowlist: do not inherit credentials, injected Git config,
  // askpass, proxies, signing commands or the developer's global profile.
  for (const key of ["PATH", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "TMPDIR", "TMP", "TEMP"]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key]!;
  }
  return environment;
}

function gitAvailable(): boolean {
  try {
    return Bun.spawnSync(gitCommand(["--version"]), { env: gitEnvironment() }).exitCode === 0;
  } catch { return false; }
}

async function runGit(
  args: string[],
  options: { cwd?: string } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const process = Bun.spawn(gitCommand(args), {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: gitEnvironment(),
    stdin: "ignore",
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

// Synthetic UserInfo only: MCP and Git remain distinct Interface identities.
const METADATA_MCP_TOKEN = "taksrv_git_metadata_mcp";
const METADATA_API_ADMIN = "taksrv_git_metadata_api_admin";
const METADATA_API_READ = "taksrv_git_metadata_api_read";

function metadataFixture() {
  const handle = makeEnv();
  const worker = createGitWorker(async (_input, init) => {
    const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer\s+/u, "");
    if (token !== METADATA_MCP_TOKEN && token !== READ_TOKEN && token !== WRITE_TOKEN && token !== METADATA_API_ADMIN && token !== METADATA_API_READ) {
      return new Response(null, { status: 401 });
    }
    const mcp = token === METADATA_MCP_TOKEN;
    const api = token === METADATA_API_ADMIN || token === METADATA_API_READ;
    return Response.json({
      token_use: "interface_oauth",
      sub: "principal_git_cli",
      aud: `${TEST_APP_URL}/${mcp ? "mcp" : api ? "api/v1" : "git"}`,
      scope: mcp ? "mcp.invoke" : api
        ? token === METADATA_API_ADMIN ? "source.git.hosting.admin" : "source.git.hosting.read"
        : token === WRITE_TOKEN
        ? "source.git.smart_http.write" : "source.git.smart_http.read",
      takosumi: {
        workspace_id: TEST_WORKSPACE,
        capsule_id: TEST_CAPSULE,
        interface_id: mcp ? "interface_mcp" : api ? "interface_hosting" : "interface_git",
        interface_binding_id: mcp ? "binding_creator_mcp" : api ? "binding_owner_api" : "binding_writer_git",
        interface_resolved_revision: 1,
      },
    });
  });
  const call = async (name: string, repo: string, token = METADATA_MCP_TOKEN) => {
    const response = await worker.fetch(new Request(`${TEST_APP_URL}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { repo } } }),
    }), handle.env);
    expect(response.status).toBe(200);
    return response.json() as Promise<{
      result?: { structuredContent: { repo: string; url: string; refs?: { name: string; sha: string }[] } };
      error?: { message: string };
    }>;
  };
  const api = (method: string, path: string, body?: unknown) => worker.fetch(
    jsonRequest(method, path, body, method === "GET" ? METADATA_API_READ : METADATA_API_ADMIN), handle.env,
  );
  return { ...handle, worker, call, api };
}

test("normal org and grant APIs authorize MCP creation and a distinct real Git binding", async () => {
  expect(gitAvailable()).toBe(true);
  const handle = metadataFixture();
  expect((await handle.api("POST", "/api/v1/orgs", { login: "Alice" })).status).toBe(201);
  const mcpGrant = await handle.api("PUT", "/api/v1/orgs/alice/members/principal_git_cli", {
    role: "admin", bindingId: "binding_creator_mcp",
  });
  expect(mcpGrant.status).toBe(200);
  const mcpPrincipalId = (await mcpGrant.json() as { member: { principalId: string } }).member.principalId;
  const created = await handle.call("git_repo_create", "aLICE/Widgets");
  expect(created.error).toBeUndefined();
  const read = await handle.api("GET", "/api/v1/repos/alice/widgets");
  expect(read.status).toBe(200);
  const repository = (await read.json() as { repository: { fullName: string; cloneUrl: string } }).repository;
  expect(repository.fullName).toBe("Alice/Widgets");
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: (request) => handle.worker.fetch(canonicalWorkerRequest(request), handle.env),
  });
  const root = mkdtempSync(join(tmpdir(), "takos-git-metadata-cli-"));
  const source = join(root, "source");
  const clone = join(root, "clone");
  // Preserve the returned path exactly; only map the canonical origin to loopback.
  const remote = new URL(created.result!.structuredContent.url);
  remote.protocol = "http:";
  remote.host = `127.0.0.1:${server.port}`;
  const canonicalRemote = new URL(repository.cloneUrl);
  canonicalRemote.protocol = remote.protocol;
  canonicalRemote.host = remote.host;
  const auth = (token: string) => ["-c", `http.extraHeader=Authorization: Bearer ${token}`];
  try {
    // Same subject does not inherit the creator's distinct binding authority.
    expect((await runGit([...auth(READ_TOKEN), "ls-remote", canonicalRemote.href])).exitCode).not.toBe(0);
    const grant = await handle.api("PUT", "/api/v1/repos/alice/widgets/collaborators/principal_git_cli", {
      role: "writer", bindingId: "binding_writer_git",
    });
    expect(grant.status).toBe(200);
    const gitPrincipalId = (await grant.json() as { principalId: string }).principalId;
    const control = await runGit([...auth(READ_TOKEN), "ls-remote", canonicalRemote.href]);
    expect(control.exitCode, control.stderr).toBe(0);
    const accessible = await runGit([...auth(READ_TOKEN), "ls-remote", remote.href]);
    expect(accessible.exitCode, accessible.stderr).toBe(0);
    expect(created.result!.structuredContent.repo).toBe("Alice/Widgets");
    expect(created.result!.structuredContent.url).toBe(`${TEST_APP_URL}/git/Alice/Widgets.git`);

    const initialClone = await runGit([...auth(READ_TOKEN), "-c", "protocol.version=1", "clone", "-q", remote.href, source]);
    expect(initialClone.exitCode, initialClone.stderr).toBe(0);
    expect((await runGit(["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: source })).exitCode).toBe(0);
    const commit = async (content: string) => {
      writeFileSync(join(source, "README.md"), content);
      expect((await runGit(["add", "README.md"], { cwd: source })).exitCode).toBe(0);
      const result = await runGit(["-c", "user.name=Git Fixture", "-c", "user.email=git-fixture@example.test", "commit", "-q", "-m", "fixture"], { cwd: source });
      expect(result.exitCode, result.stderr).toBe(0);
    };
    await commit("first\n");
    const push = await runGit([...auth(WRITE_TOKEN), "push", "-q", "origin", "main"], { cwd: source });
    expect(push.exitCode, push.stderr).toBe(0);
    const firstInfo = await handle.call("git_repo_info", "ALICE/widgets");
    expect(firstInfo.error).toBeUndefined();
    expect(firstInfo.result!.structuredContent.repo).toBe("Alice/Widgets");
    expect(firstInfo.result!.structuredContent.url).toBe(created.result!.structuredContent.url);
    const reclone = await runGit([...auth(READ_TOKEN), "-c", "protocol.version=1", "clone", "-q", remote.href, clone]);
    expect(reclone.exitCode, reclone.stderr).toBe(0);
    expect(readFileSync(join(clone, "README.md"), "utf8")).toBe("first\n");
    await commit("second\n");
    const secondPush = await runGit([...auth(WRITE_TOKEN), "push", "-q", "origin", "main"], { cwd: source });
    expect(secondPush.exitCode, secondPush.stderr).toBe(0);
    const fetch = await runGit([...auth(READ_TOKEN), "pull", "--ff-only", "-q"], { cwd: clone });
    expect(fetch.exitCode, fetch.stderr).toBe(0);
    expect(readFileSync(join(clone, "README.md"), "utf8")).toBe("second\n");
    const head = await runGit(["rev-parse", "HEAD"], { cwd: source });
    expect(head.exitCode).toBe(0);
    expect((await runGit(["rev-parse", "HEAD"], { cwd: clone })).stdout).toBe(head.stdout);
    const info = await handle.call("git_repo_info", "alice/WIDGETS");
    expect(info.error).toBeUndefined();
    expect(info.result!.structuredContent.refs).toContainEqual({ name: "refs/heads/main", sha: head.stdout.trim() });
    expect((await handle.api("DELETE", `/api/v1/repos/alice/widgets/collaborators/principal_git_cli?principalId=${encodeURIComponent(gitPrincipalId)}`)).status).toBe(200);
    expect((await runGit([...auth(READ_TOKEN), "ls-remote", remote.href])).exitCode).not.toBe(0);
    expect((await handle.api("DELETE", `/api/v1/orgs/alice/members/${encodeURIComponent(mcpPrincipalId)}`)).status).toBe(200);
    expect((await handle.call("git_repo_create", "Alice/after-revocation")).error?.message).toBe("forbidden");
    expect((await handle.api("GET", "/api/v1/repos/alice/widgets")).status).toBe(200);
  } finally {
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("metadata MCP info resolves the persisted owner and repository spelling", async () => {
  const handle = metadataFixture();
  const created = await handle.call("git_repo_create", "Alice/Widgets");
  expect(created.error).toBeUndefined();
  const info = await handle.call("git_repo_info", "aLICE/wIDGETS");
  expect(info.error).toBeUndefined();
  expect(info.result?.structuredContent).toEqual({
    repo: "Alice/Widgets", url: `${TEST_APP_URL}/git/Alice/Widgets.git`,
    defaultBranch: null, refs: [],
  });
});

test("standalone MCP retains R2-only repositories and canonical metadata URLs", async () => {
  const handle = metadataFixture();
  handle.env.PUBLISHED_MCP_AUTH_TOKEN = MCP_TOKEN;
  await handle.call("git_repo_create", "Alice/bootstrap", MCP_TOKEN);
  const created = await handle.call("git_repo_create", "aLICE/Widgets", MCP_TOKEN);
  expect(created.error).toBeUndefined();
  expect(created.result?.structuredContent.repo).toBe("Alice/Widgets");
  const info = await handle.call("git_repo_info", "ALICE/widgets", MCP_TOKEN);
  expect(info.error).toBeUndefined();
  expect(info.result?.structuredContent.url).toBe(`${TEST_APP_URL}/git/Alice/Widgets.git`);
  // Legacy trusted lookup does not acquire a new metadata-row requirement.
  await seedRepo(handle.bucket, { repo: "Legacy/Unindexed", content: "legacy\n" });
  const legacy = await handle.call("git_repo_info", "Legacy/Unindexed", MCP_TOKEN);
  expect(legacy.error).toBeUndefined();
  expect(legacy.result?.structuredContent.repo).toBe("Legacy/Unindexed");

  handle.env.DB = undefined;
  const direct = await handle.call("git_repo_create", "MiXeD/Case");
  expect(direct.error).toBeUndefined();
  expect(direct.result?.structuredContent.repo).toBe("MiXeD/Case");
  const directInfo = await handle.call("git_repo_info", "MiXeD/Case");
  expect(directInfo.error).toBeUndefined();
  expect(directInfo.result?.structuredContent.url).toBe(`${TEST_APP_URL}/git/MiXeD/Case.git`);
});

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
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => worker.fetch(canonicalWorkerRequest(request), env),
  });
  const dir = mkdtempSync(join(tmpdir(), "takos-git-clone-"));

  try {
    // git sends the token as the HTTP Basic password (username ignored).
    const cloneUrl = `http://x:${READ_TOKEN}@127.0.0.1:${server.port}/git/${REPO}.git`;
    const clone = await runGit(["-c", "protocol.version=1", "clone", "-q", cloneUrl, dir]);
    expect(clone.exitCode, `git clone failed: ${clone.stderr}`).toBe(0);

    // The working tree came through intact...
    expect(readFileSync(join(dir, "README.md"), "utf8")).toBe(FILE_CONTENT);

    // ...and points at the exact commit we seeded.
    const revParse = await runGit(["-C", dir, "rev-parse", "HEAD"]);
    expect(revParse.exitCode, revParse.stderr).toBe(0);
    expect(revParse.stdout.trim()).toBe(
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
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => worker.fetch(canonicalWorkerRequest(request), env),
  });
  const dir = mkdtempSync(join(tmpdir(), "takos-git-noauth-"));
  try {
    const clone = await runGit([
      "-c", "protocol.version=1", "clone", "-q",
      `http://x:bad@127.0.0.1:${server.port}/git/${REPO}.git`, dir,
    ]);
    expect(clone.exitCode).not.toBe(0);
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
    hostname: "127.0.0.1",
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
    expect(
      (await runGit(["tag", "-a", "v1.0.0", "-m", "release"], { cwd: source }))
        .exitCode,
    ).toBe(0);
    const tagPush = await runGit(["push", "-q", "origin", "v1.0.0"], {
      cwd: source,
    });
    expect(tagPush.exitCode, tagPush.stderr).toBe(0);

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
    expect(
      (await runGit(["rev-parse", "v1.0.0^{}"], { cwd: clone })).stdout.trim(),
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
