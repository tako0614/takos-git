import { describe, expect, test } from "bun:test";

import { MemoryBucket } from "../../../test-bucket.ts";
import { makeEnv, seedFullRepo, type SeededRepo, type TestEnvHandle } from "../../repos/testkit.ts";
import { handleInternalActionsRoute } from "./internal-routes.ts";
import { mintRunnerToken } from "./hmac.ts";
import { readTar } from "./tar.ts";

const SECRET = "s".repeat(40);
const BASE = "https://git.example";

interface Ctx {
  readonly handle: TestEnvHandle;
  readonly env: Record<string, unknown>;
  readonly actions: MemoryBucket;
  readonly seeded: SeededRepo;
  readonly runId: string;
  readonly jobId: string;
}

async function setup(): Promise<Ctx> {
  const handle = makeEnv();
  const actions = new MemoryBucket();
  const seeded = await seedFullRepo(handle, { ownerLogin: "acme", name: "web" });
  const runId = handle.db.id();
  const jobId = handle.db.id();
  const now = handle.db.now();
  await handle.db.run(
    `INSERT INTO workflow_runs (id, repo_id, workflow_path, event, ref, sha, status, run_number, run_attempt, queued_at, created_at)
     VALUES (?, ?, '.github/workflows/ci.yml', 'push', 'refs/heads/main', ?, 'in_progress', 1, 1, ?, ?)`,
    [runId, seeded.repoId, seeded.commitSha, now, now],
  );
  const env = {
    BUCKET: handle.bucket,
    DB: handle.fake,
    R2_ACTIONS: actions,
    ACTIONS_RUNNER_SECRET: SECRET,
  };
  return { handle, env, actions, seeded, runId, jobId };
}

function req(method: string, path: string, token?: string, body?: BodyInit): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(body !== undefined ? { body } : {}),
  });
}

async function dispatch(ctx: Ctx, request: Request): Promise<Response | null> {
  return handleInternalActionsRoute(request, ctx.env, new URL(request.url));
}

describe("internal actions routes — trust boundary", () => {
  test("returns null for non-internal paths (off /api/v1, /git/, /mcp)", async () => {
    const ctx = await setup();
    expect(await dispatch(ctx, req("GET", "/api/v1/repos/acme/web"))).toBe(null);
    expect(await dispatch(ctx, req("POST", "/git/acme/web.git/git-receive-pack"))).toBe(null);
    expect(await dispatch(ctx, req("POST", "/mcp"))).toBe(null);
  });

  test("fail-closed: no token / bad token is 401", async () => {
    const ctx = await setup();
    const noToken = await dispatch(ctx, req("GET", "/internal/actions/checkout?runId=x"));
    expect(noToken?.status).toBe(401);
    const badToken = await dispatch(ctx, req("GET", "/internal/actions/checkout?runId=x", "garbage.sig"));
    expect(badToken?.status).toBe(401);
  });

  test("fail-closed: unset ACTIONS_RUNNER_SECRET rejects every valid-looking token", async () => {
    const ctx = await setup();
    const token = await mintRunnerToken(SECRET, { runId: ctx.runId, jobId: ctx.jobId }, Date.now());
    const env = { ...ctx.env, ACTIONS_RUNNER_SECRET: undefined };
    const res = await handleInternalActionsRoute(
      req("GET", `/internal/actions/checkout?runId=${ctx.runId}`, token),
      env,
      new URL(`${BASE}/internal/actions/checkout?runId=${ctx.runId}`),
    );
    expect(res?.status).toBe(401);
  });

  test("checkout serves the run-pinned tree as a tar", async () => {
    const ctx = await setup();
    const token = await mintRunnerToken(SECRET, { runId: ctx.runId, jobId: ctx.jobId }, Date.now());
    const res = await dispatch(ctx, req("GET", `/internal/actions/checkout?runId=${ctx.runId}`, token));
    expect(res?.status).toBe(200);
    expect(res?.headers.get("content-type")).toBe("application/x-tar");
    const members = readTar(new Uint8Array(await res!.arrayBuffer()));
    const readme = members.find((m) => m.path === "README.md");
    expect(readme).toBeDefined();
    expect(new TextDecoder().decode(readme!.bytes)).toBe("# fixture\n");
  });

  test("checkout rejects a run-scope mismatch (token bound to another run)", async () => {
    const ctx = await setup();
    const token = await mintRunnerToken(SECRET, { runId: ctx.runId, jobId: ctx.jobId }, Date.now());
    const res = await dispatch(ctx, req("GET", "/internal/actions/checkout?runId=someone-else", token));
    expect(res?.status).toBe(403);
  });

  test("logs append accumulates into the sealed R2 key", async () => {
    const ctx = await setup();
    const token = await mintRunnerToken(SECRET, { runId: ctx.runId, jobId: ctx.jobId }, Date.now());
    const body = (chunk: string): string => JSON.stringify({ runId: ctx.runId, jobId: ctx.jobId, chunk });
    const first = await dispatch(ctx, req("POST", "/internal/actions/logs", token, body("hello ")));
    expect(first?.status).toBe(200);
    const key = ((await first!.json()) as { logsR2Key: string }).logsR2Key;
    expect(key).toBe(`logs/${ctx.seeded.repoId}/${ctx.runId}/${ctx.jobId}.log`);
    await dispatch(ctx, req("POST", "/internal/actions/logs", token, body("world")));
    const object = await ctx.actions.get(key);
    expect(new TextDecoder().decode(new Uint8Array(await object!.arrayBuffer()))).toBe("hello world");
  });

  test("artifact upload stores bytes + registers a row", async () => {
    const ctx = await setup();
    const token = await mintRunnerToken(SECRET, { runId: ctx.runId, jobId: ctx.jobId }, Date.now());
    const url = `/internal/actions/artifacts?runId=${ctx.runId}&jobId=${ctx.jobId}&name=build.zip`;
    const res = await dispatch(ctx, req("POST", url, token, new Uint8Array([1, 2, 3, 4])));
    expect(res?.status).toBe(201);
    const row = await ctx.handle.db.queryOne<{ name: string; r2_key: string; size_bytes: number }>(
      `SELECT name, r2_key, size_bytes FROM workflow_run_artifacts WHERE run_id = ?`,
      [ctx.runId],
    );
    expect(row).toMatchObject({
      name: "build.zip",
      r2_key: `artifacts/${ctx.seeded.repoId}/${ctx.runId}/build.zip`,
      size_bytes: 4,
    });
    const stored = await ctx.actions.get(row!.r2_key);
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  test("artifact upload rejects a run-scope mismatch", async () => {
    const ctx = await setup();
    const token = await mintRunnerToken(SECRET, { runId: ctx.runId, jobId: ctx.jobId }, Date.now());
    const url = `/internal/actions/artifacts?runId=other&jobId=${ctx.jobId}&name=x`;
    const res = await dispatch(ctx, req("POST", url, token, new Uint8Array([1])));
    expect(res?.status).toBe(403);
  });
});
