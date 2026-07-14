import { describe, expect, test } from "bun:test";

import { RouteRegistry, type RouterEnv } from "../../router.ts";
import type { OAuthFetch } from "../../browser-auth.ts";
import type { DbClient } from "../../db/index.ts";
import {
  get,
  interfaceUserInfoFetch,
  jsonRequest,
  makeEnv,
  seedFullRepo,
  seedPrincipal,
  type SeededRepo,
  type TestEnvHandle,
} from "../repos/testkit.ts";
import { registerChecksRoutes } from "./routes.ts";
import { combinedStatus, listCheckRuns } from "./service.ts";

function router(): RouteRegistry {
  const reg = new RouteRegistry();
  registerChecksRoutes(reg);
  return reg;
}

// contents.write's interface-scope ceiling is source.git.smart_http.write (the
// push scope); reads take source.git.hosting.read.
const tokens = interfaceUserInfoFetch({
  taksrv_writer_w: { scope: "source.git.smart_http.write", subject: "sub-writer" },
  taksrv_writer_r: { scope: "source.git.hosting.read", subject: "sub-writer" },
  taksrv_stranger_w: { scope: "source.git.smart_http.write", subject: "sub-stranger" },
  taksrv_stranger_r: { scope: "source.git.hosting.read", subject: "sub-stranger" },
});

async function dispatch(
  reg: RouteRegistry,
  request: Request,
  env: RouterEnv,
  fetchMock: OAuthFetch = tokens,
): Promise<Response> {
  const res = await reg.handle({ request, env, interfaceUserInfoFetch: fetchMock });
  if (!res) throw new Error(`route not handled: ${request.method} ${request.url}`);
  return res;
}

/** Seed a repo (R2 refs+objects, D1 row) and grant `sub-writer` writer access. */
async function seedRepoWithWriter(
  handle: TestEnvHandle,
  opts: { name: string; visibility?: "public" | "private" },
): Promise<SeededRepo> {
  const seeded = await seedFullRepo(handle, {
    ownerLogin: "acme",
    name: opts.name,
    visibility: opts.visibility ?? "public",
  });
  const writerId = await seedPrincipal(handle.db, "sub-writer");
  await grant(handle.db, seeded.repoId, writerId, "writer");
  return seeded;
}

async function grant(
  db: DbClient,
  repoId: string,
  principalId: string,
  role: string,
): Promise<void> {
  await db.run(
    `INSERT INTO repo_collaborators (repo_id, principal_id, role, created_at) VALUES (?, ?, ?, ?)`,
    [repoId, principalId, role, db.now()],
  );
}

const R = "/api/v1/repos/acme";

describe("check runs", () => {
  test("writer creates, gets, lists, and completes a check run", async () => {
    const handle = makeEnv();
    const reg = router();
    const seeded = await seedRepoWithWriter(handle, { name: "web" });

    const created = await dispatch(
      reg,
      jsonRequest(
        "POST",
        `${R}/web/check-runs`,
        {
          headSha: seeded.commitSha,
          name: "ci/build",
          status: "in_progress",
          detailsUrl: "https://ci.example/1",
          output: { title: "Building", summary: "in progress", text: "line1\nline2" },
        },
        "taksrv_writer_w",
      ),
      handle.env,
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { checkRun: Record<string, unknown> };
    const id = createdBody.checkRun.id as string;
    expect(createdBody.checkRun).toMatchObject({
      headSha: seeded.commitSha,
      name: "ci/build",
      status: "in_progress",
      conclusion: null,
    });
    expect(createdBody.checkRun.startedAt).not.toBeNull();
    expect((createdBody.checkRun.output as Record<string, unknown>).text).toBe("line1\nline2");

    // GET hydrates the spilled output text from R2.
    const fetched = await dispatch(reg, get(`${R}/web/check-runs/${id}`, "taksrv_writer_r"), handle.env);
    expect(fetched.status).toBe(200);
    const fetchedBody = (await fetched.json()) as { checkRun: Record<string, unknown> };
    expect((fetchedBody.checkRun.output as Record<string, unknown>).text).toBe("line1\nline2");

    // list by sha
    const listed = await dispatch(reg, get(`${R}/web/commits/${seeded.commitSha}/check-runs`, "taksrv_writer_r"), handle.env);
    const listedBody = (await listed.json()) as { totalCount: number; checkRuns: unknown[] };
    expect(listedBody.totalCount).toBe(1);

    // complete it
    const done = await dispatch(
      reg,
      jsonRequest("PATCH", `${R}/web/check-runs/${id}`, { status: "completed", conclusion: "success" }, "taksrv_writer_w"),
      handle.env,
    );
    expect(done.status).toBe(200);
    const doneBody = (await done.json()) as { checkRun: Record<string, unknown> };
    expect(doneBody.checkRun).toMatchObject({ status: "completed", conclusion: "success" });
    expect(doneBody.checkRun.completedAt).not.toBeNull();

    // exported helper agrees
    const helper = await listCheckRuns(handle.db, seeded.repoId, seeded.commitSha);
    expect(helper).toHaveLength(1);
    expect(helper[0]).toMatchObject({ name: "ci/build", status: "completed", conclusion: "success" });
  });

  test("completed without a conclusion is rejected", async () => {
    const handle = makeEnv();
    const reg = router();
    const seeded = await seedRepoWithWriter(handle, { name: "web" });
    const res = await dispatch(
      reg,
      jsonRequest("POST", `${R}/web/check-runs`, { headSha: seeded.commitSha, name: "x", status: "completed" }, "taksrv_writer_w"),
      handle.env,
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({ error: { code: "conclusion_required" } });
  });

  test("head_sha must be a real commit in the repo", async () => {
    const handle = makeEnv();
    const reg = router();
    await seedRepoWithWriter(handle, { name: "web" });
    const ghost = "0".repeat(40);
    const res = await dispatch(
      reg,
      jsonRequest("POST", `${R}/web/check-runs`, { headSha: ghost, name: "x", status: "queued" }, "taksrv_writer_w"),
      handle.env,
    );
    expect(res.status).toBe(422);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({ error: { code: "unknown_commit" } });
  });

  test("malformed head_sha is a 400", async () => {
    const handle = makeEnv();
    const reg = router();
    await seedRepoWithWriter(handle, { name: "web" });
    const res = await dispatch(
      reg,
      jsonRequest("POST", `${R}/web/check-runs`, { headSha: "nothex", name: "x" }, "taksrv_writer_w"),
      handle.env,
    );
    expect(res.status).toBe(400);
  });
});

describe("commit statuses + combined rollup", () => {
  test("statuses post, combined rollup reflects latest-per-context precedence", async () => {
    const handle = makeEnv();
    const reg = router();
    const seeded = await seedRepoWithWriter(handle, { name: "web" });
    const sha = seeded.commitSha;

    // ci/build: pending then success (latest wins)
    await dispatch(reg, jsonRequest("POST", `${R}/web/statuses/${sha}`, { context: "ci/build", state: "pending" }, "taksrv_writer_w"), handle.env);
    const ok = await dispatch(reg, jsonRequest("POST", `${R}/web/statuses/${sha}`, { context: "ci/build", state: "success", targetUrl: "https://ci.example" }, "taksrv_writer_w"), handle.env);
    expect(ok.status).toBe(201);

    // security/scan: pending -> combined should be pending
    await dispatch(reg, jsonRequest("POST", `${R}/web/statuses/${sha}`, { context: "security/scan", state: "pending" }, "taksrv_writer_w"), handle.env);

    let combined = await dispatch(reg, get(`${R}/web/commits/${sha}/status`, "taksrv_writer_r"), handle.env);
    let body = (await combined.json()) as { state: string; totalCount: number; statuses: Array<{ context: string; state: string }> };
    expect(body.state).toBe("pending");
    expect(body.totalCount).toBe(2); // latest per context
    expect(body.statuses.find((s) => s.context === "ci/build")?.state).toBe("success");

    // security/scan fails -> combined failure dominates
    await dispatch(reg, jsonRequest("POST", `${R}/web/statuses/${sha}`, { context: "security/scan", state: "failure" }, "taksrv_writer_w"), handle.env);
    combined = await dispatch(reg, get(`${R}/web/commits/${sha}/status`, "taksrv_writer_r"), handle.env);
    body = (await combined.json()) as typeof body;
    expect(body.state).toBe("failure");

    // exported helper agrees with the route rollup
    const helper = await combinedStatus(handle.db, seeded.repoId, sha);
    expect(helper.state).toBe("failure");
    expect(helper.totalCount).toBe(2);

    // full history via the statuses list endpoint
    const list = await dispatch(reg, get(`${R}/web/commits/${sha}/statuses`, "taksrv_writer_r"), handle.env);
    const listBody = (await list.json()) as { totalCount: number };
    expect(listBody.totalCount).toBe(4);
  });

  test("empty combined rollup is pending", async () => {
    const handle = makeEnv();
    const reg = router();
    const seeded = await seedRepoWithWriter(handle, { name: "web" });
    const res = await dispatch(reg, get(`${R}/web/commits/${seeded.commitSha}/status`), handle.env);
    expect(res.status).toBe(200);
    expect((await res.json()) as { state: string; totalCount: number }).toMatchObject({ state: "pending", totalCount: 0 });
  });

  test("status target must be a real commit", async () => {
    const handle = makeEnv();
    const reg = router();
    await seedRepoWithWriter(handle, { name: "web" });
    const ghost = "a".repeat(40);
    const res = await dispatch(reg, jsonRequest("POST", `${R}/web/statuses/${ghost}`, { context: "ci", state: "success" }, "taksrv_writer_w"), handle.env);
    expect(res.status).toBe(422);
  });
});

describe("checks authorization", () => {
  test("anonymous cannot read a private repo's checks (404 non-disclosure)", async () => {
    const handle = makeEnv();
    const reg = router();
    const seeded = await seedRepoWithWriter(handle, { name: "secret", visibility: "private" });
    const res = await dispatch(reg, get(`${R}/secret/commits/${seeded.commitSha}/status`), handle.env);
    expect(res.status).toBe(404);
  });

  test("anonymous cannot post a status (401)", async () => {
    const handle = makeEnv();
    const reg = router();
    const seeded = await seedRepoWithWriter(handle, { name: "web" });
    const res = await dispatch(reg, jsonRequest("POST", `${R}/web/statuses/${seeded.commitSha}`, { context: "ci", state: "success" }), handle.env);
    expect(res.status).toBe(401);
  });

  test("a reader-only principal cannot post a check run (403)", async () => {
    const handle = makeEnv();
    const reg = router();
    // stranger has no grant on a PUBLIC repo → reader floor → write forbidden.
    const seeded = await seedRepoWithWriter(handle, { name: "web" });
    const res = await dispatch(
      reg,
      jsonRequest("POST", `${R}/web/check-runs`, { headSha: seeded.commitSha, name: "x", status: "queued" }, "taksrv_stranger_w"),
      handle.env,
    );
    expect(res.status).toBe(403);
  });

  test("interface reader can read combined status on a public repo", async () => {
    const handle = makeEnv();
    const reg = router();
    const seeded = await seedRepoWithWriter(handle, { name: "web" });
    const res = await dispatch(reg, get(`${R}/web/commits/${seeded.commitSha}/status`, "taksrv_stranger_r"), handle.env);
    expect(res.status).toBe(200);
  });

  test("listing checks for an unknown ref name is 404", async () => {
    const handle = makeEnv();
    const reg = router();
    await seedRepoWithWriter(handle, { name: "web" });
    const res = await dispatch(reg, get(`${R}/web/commits/nope-branch/check-runs`, "taksrv_writer_r"), handle.env);
    expect(res.status).toBe(404);
  });
});
