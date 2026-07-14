import { describe, expect, test } from "bun:test";

import { RouteRegistry, type RouterEnv } from "../../router.ts";
import type { OAuthFetch } from "../../browser-auth.ts";
import type { DbClient } from "../../db/index.ts";
import { putBlob, putCommit } from "../../git/object-store.ts";
import { buildTreeFromPaths } from "../../git/tree-ops.ts";
import { FILE_MODES } from "../../git/git-objects.ts";
import { repositoryObjectStore } from "../../git/repo-object-store.ts";
import { writeRepoRefs } from "../../git/refs-store.ts";
import type { ObjectStoreBinding } from "../../git/types.ts";
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
import { registerActionsRoutes } from "./routes.ts";
import { onPushDiscoverWorkflows } from "./push-trigger.ts";
import { discoverWorkflows } from "./discovery.ts";
import { persistAndDispatchRun } from "./orchestrator.ts";
import { allocateRunNumber, completeJob, startJob } from "./service.ts";

/** Trigger a run through `handle.db` so state-machine writes share its clock. */
async function triggerViaDb(
  handle: TestEnvHandle,
  seeded: SeededRepo,
  sha: string,
): Promise<void> {
  const objects = repositoryObjectStore(handle.bucket, seeded.storageKey);
  for (const c of await discoverWorkflows(objects, sha)) {
    const runNumber = await allocateRunNumber(handle.db, seeded.repoId, c.path);
    await persistAndDispatchRun(handle.db, handle.env, {
      repoId: seeded.repoId,
      repoFullName: seeded.storageKey,
      workflowPath: c.path,
      workflowName: c.name,
      contentSha: c.contentSha,
      event: "push",
      ref: "refs/heads/main",
      sha,
      actorId: null,
      workflow: c.workflow,
      runNumber,
    });
  }
}

/** An env with Actions secret encryption configured. */
function secretsEnv(handle: TestEnvHandle): RouterEnv {
  return { ...handle.env, ACTIONS_SECRETS_KEY: "x".repeat(32) } as unknown as RouterEnv;
}

// --- fixtures ---------------------------------------------------------------

function router(): RouteRegistry {
  const reg = new RouteRegistry();
  registerActionsRoutes(reg);
  return reg;
}

const tokens = interfaceUserInfoFetch({
  taksrv_writer_w: { scope: "source.git.smart_http.write", subject: "sub-writer" },
  taksrv_writer_r: { scope: "source.git.hosting.read", subject: "sub-writer" },
  taksrv_admin_a: { scope: "source.git.hosting.admin", subject: "sub-admin" },
  taksrv_admin_r: { scope: "source.git.hosting.read", subject: "sub-admin" },
  taksrv_stranger_a: { scope: "source.git.hosting.admin", subject: "sub-stranger" },
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

/** Write a commit containing `files`, advance `branch`, return the new SHA. */
async function commitFiles(
  bucket: ObjectStoreBinding,
  repoKey: string,
  files: Array<{ path: string; content: string }>,
  parents: string[],
  branch = "main",
): Promise<string> {
  const store = repositoryObjectStore(bucket, repoKey);
  const entries = [];
  for (const file of files) {
    const sha = await putBlob(store, new TextEncoder().encode(file.content));
    entries.push({ path: file.path, sha, mode: FILE_MODES.REGULAR_FILE });
  }
  const treeSha = await buildTreeFromPaths(store, entries);
  const sig = { name: "T", email: "t@e", timestamp: 1_700_000_000, tzOffset: "+0000" };
  const commitSha = await putCommit(store, {
    tree: treeSha,
    parents,
    author: sig,
    committer: sig,
    message: "wf\n",
  });
  await writeRepoRefs(bucket, repoKey, {
    refs: [{ name: `refs/heads/${branch}`, sha: commitSha }],
    defaultBranch: branch,
  });
  return commitSha;
}

async function seedRepoWith(
  handle: TestEnvHandle,
  opts: { name: string; visibility?: "public" | "private" },
): Promise<SeededRepo & { writerId: string; adminId: string }> {
  const seeded = await seedFullRepo(handle, {
    ownerLogin: "acme",
    name: opts.name,
    visibility: opts.visibility ?? "public",
  });
  const writerId = await seedPrincipal(handle.db, "sub-writer");
  const adminId = await seedPrincipal(handle.db, "sub-admin");
  await grant(handle.db, seeded.repoId, writerId, "writer");
  await grant(handle.db, seeded.repoId, adminId, "maintainer");
  return { ...seeded, writerId, adminId };
}

const PUSH_WORKFLOW = `name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    env:
      JOB_LEVEL: yes
    steps:
      - name: build
        run: echo build
        env:
          STEP_LEVEL: yes
      - run: echo test
`;

const MATRIX_WORKFLOW = `name: Matrix
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [18, 20]
    steps:
      - run: echo test
`;

const R = "/api/v1/repos/acme";

// --- push discovery ---------------------------------------------------------

describe("push discovery", () => {
  test("a push adds a workflow → queued run + jobs + steps + check runs", async () => {
    const handle = makeEnv();
    const seeded = await seedRepoWith(handle, { name: "web" });
    const after = await commitFiles(
      handle.bucket,
      seeded.storageKey,
      [
        { path: "README.md", content: "# fixture\n" },
        { path: ".github/workflows/ci.yml", content: PUSH_WORKFLOW },
      ],
      [seeded.commitSha],
    );

    await onPushDiscoverWorkflows(handle.env, seeded.storageKey, [
      { name: "refs/heads/main", oldSha: seeded.commitSha, newSha: after },
    ]);

    const runs = await handle.db.query<{ id: string; event: string; status: string; sha: string; run_number: number }>(
      `SELECT id, event, status, sha, run_number FROM workflow_runs WHERE repo_id = ?`,
      [seeded.repoId],
    );
    expect(runs.length).toBe(1);
    expect(runs[0].event).toBe("push");
    expect(runs[0].status).toBe("queued");
    expect(runs[0].sha).toBe(after);
    expect(runs[0].run_number).toBe(1);

    const jobs = await handle.db.query<{ id: string; job_key: string; needs: string }>(
      `SELECT id, job_key, needs FROM workflow_jobs WHERE run_id = ?`,
      [runs[0].id],
    );
    expect(jobs.length).toBe(1);
    expect(jobs[0].job_key).toBe("build");

    const steps = await handle.db.query<{ number: number; exec_contract: string }>(
      `SELECT number, exec_contract FROM workflow_steps WHERE job_id = ? ORDER BY number`,
      [jobs[0].id],
    );
    expect(steps.length).toBe(2);
    const contract = JSON.parse(steps[0].exec_contract);
    // The step exec-contract is the 5b interface: env merged (workflow→job→step→context).
    expect(contract.run).toBe("echo build");
    expect(contract.env.JOB_LEVEL).toBe("yes");
    expect(contract.env.STEP_LEVEL).toBe("yes");
    expect(contract.env.GITHUB_SHA).toBe(after);
    expect(contract.env.GITHUB_REF).toBe("refs/heads/main");

    const checks = await handle.db.query<{ status: string; head_sha: string; name: string }>(
      `SELECT status, head_sha, name FROM check_runs WHERE repo_id = ?`,
      [seeded.repoId],
    );
    expect(checks.length).toBe(1);
    expect(checks[0].status).toBe("queued");
    expect(checks[0].head_sha).toBe(after);
    expect(checks[0].name).toBe("CI / build");
  });

  test("a matrix push expands into one job row per combination", async () => {
    const handle = makeEnv();
    const seeded = await seedRepoWith(handle, { name: "mtx" });
    const after = await commitFiles(
      handle.bucket,
      seeded.storageKey,
      [{ path: ".github/workflows/m.yml", content: MATRIX_WORKFLOW }],
      [seeded.commitSha],
    );
    await onPushDiscoverWorkflows(handle.env, seeded.storageKey, [
      { name: "refs/heads/main", oldSha: seeded.commitSha, newSha: after },
    ]);
    const jobs = await handle.db.query<{ id: string; matrix: string | null }>(
      `SELECT j.id, j.matrix FROM workflow_jobs j JOIN workflow_runs r ON r.id = j.run_id WHERE r.repo_id = ?`,
      [seeded.repoId],
    );
    expect(jobs.length).toBe(2);
    const nodes = jobs.map((j) => (j.matrix ? JSON.parse(j.matrix).node : null)).sort();
    expect(nodes).toEqual([18, 20]);
  });

  test("branch filter: a workflow scoped to another branch does not fire", async () => {
    const handle = makeEnv();
    const seeded = await seedRepoWith(handle, { name: "flt" });
    const wf = `on:\n  push:\n    branches: [release]\njobs:\n  d:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo d\n`;
    const after = await commitFiles(
      handle.bucket,
      seeded.storageKey,
      [{ path: ".github/workflows/rel.yml", content: wf }],
      [seeded.commitSha],
    );
    await onPushDiscoverWorkflows(handle.env, seeded.storageKey, [
      { name: "refs/heads/main", oldSha: seeded.commitSha, newSha: after },
    ]);
    const runs = await handle.db.query(`SELECT id FROM workflow_runs WHERE repo_id = ?`, [seeded.repoId]);
    expect(runs.length).toBe(0);
  });

  test("no metadata plane → hook is a no-op (push path untouched)", async () => {
    const handle = makeEnv();
    const seeded = await seedRepoWith(handle, { name: "noplane" });
    const after = await commitFiles(
      handle.bucket,
      seeded.storageKey,
      [{ path: ".github/workflows/ci.yml", content: PUSH_WORKFLOW }],
      [seeded.commitSha],
    );
    // env without DB — the exact shape the clone/push E2E uses.
    await onPushDiscoverWorkflows(
      { BUCKET: handle.bucket },
      seeded.storageKey,
      [{ name: "refs/heads/main", oldSha: seeded.commitSha, newSha: after }],
    );
    const runs = await handle.db.query(`SELECT id FROM workflow_runs WHERE repo_id = ?`, [seeded.repoId]);
    expect(runs.length).toBe(0);
  });

  test("dispatch seam enqueues onto WORKFLOW_QUEUE when bound", async () => {
    const handle = makeEnv();
    const seeded = await seedRepoWith(handle, { name: "q" });
    const sent: Array<{ runId: string; repoId: string }> = [];
    const env = {
      ...handle.env,
      WORKFLOW_QUEUE: { send: async (m: { runId: string; repoId: string }) => void sent.push(m) },
    } as unknown as RouterEnv;
    const after = await commitFiles(
      handle.bucket,
      seeded.storageKey,
      [{ path: ".github/workflows/ci.yml", content: PUSH_WORKFLOW }],
      [seeded.commitSha],
    );
    await onPushDiscoverWorkflows(env, seeded.storageKey, [
      { name: "refs/heads/main", oldSha: seeded.commitSha, newSha: after },
    ]);
    expect(sent.length).toBe(1);
    expect(sent[0].repoId).toBe(seeded.repoId);
  });
});

// --- read + manual dispatch routes ------------------------------------------

describe("routes", () => {
  test("anon reads runs on a public repo; manual dispatch + read back", async () => {
    const handle = makeEnv();
    const reg = router();
    const seeded = await seedRepoWith(handle, { name: "web" });
    const wf = PUSH_WORKFLOW.replace("on: push", "on: [push, workflow_dispatch]");
    await commitFiles(
      handle.bucket,
      seeded.storageKey,
      [{ path: ".github/workflows/ci.yml", content: wf }],
      [seeded.commitSha],
    );

    // POST dispatch (writer scope = contents.write).
    const dispatched = await dispatch(
      reg,
      jsonRequest("POST", `${R}/web/actions/runs`, { workflow: ".github/workflows/ci.yml" }, "taksrv_writer_w"),
      handle.env,
    );
    expect(dispatched.status).toBe(201);
    const body = (await dispatched.json()) as { run: { id: string; event: string; status: string }; dispatched: boolean };
    expect(body.run.event).toBe("workflow_dispatch");
    expect(body.run.status).toBe("queued");
    expect(body.dispatched).toBe(false); // no queue bound in this env

    // anon lists runs on the public repo
    const listed = await dispatch(reg, get(`${R}/web/actions/runs`), handle.env);
    expect(listed.status).toBe(200);
    const listBody = (await listed.json()) as { runs: unknown[] };
    expect(listBody.runs.length).toBe(1);

    // anon gets the run detail with jobs+steps
    const detail = await dispatch(reg, get(`${R}/web/actions/runs/${body.run.id}`), handle.env);
    const detailBody = (await detail.json()) as { jobs: Array<{ steps: unknown[] }> };
    expect(detailBody.jobs.length).toBe(1);
    expect(detailBody.jobs[0].steps.length).toBe(2);
  });

  test("dispatch rejects a workflow without workflow_dispatch", async () => {
    const handle = makeEnv();
    const reg = router();
    const seeded = await seedRepoWith(handle, { name: "nod" });
    await commitFiles(
      handle.bucket,
      seeded.storageKey,
      [{ path: ".github/workflows/ci.yml", content: PUSH_WORKFLOW }],
      [seeded.commitSha],
    );
    const res = await dispatch(
      reg,
      jsonRequest("POST", `${R}/nod/actions/runs`, { workflow: ".github/workflows/ci.yml" }, "taksrv_writer_w"),
      handle.env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("dispatch_unsupported");
  });

  test("cancel flips a queued run + jobs to cancelled", async () => {
    const handle = makeEnv();
    const reg = router();
    const seeded = await seedRepoWith(handle, { name: "cx" });
    const after = await commitFiles(
      handle.bucket,
      seeded.storageKey,
      [{ path: ".github/workflows/ci.yml", content: PUSH_WORKFLOW }],
      [seeded.commitSha],
    );
    await onPushDiscoverWorkflows(handle.env, seeded.storageKey, [
      { name: "refs/heads/main", oldSha: seeded.commitSha, newSha: after },
    ]);
    const run = await handle.db.queryOne<{ id: string }>(`SELECT id FROM workflow_runs WHERE repo_id = ?`, [seeded.repoId]);
    const res = await dispatch(
      reg,
      jsonRequest("POST", `${R}/cx/actions/runs/${run!.id}/cancel`, {}, "taksrv_writer_w"),
      handle.env,
    );
    expect(res.status).toBe(200);
    const fresh = await handle.db.queryOne<{ status: string; conclusion: string }>(
      `SELECT status, conclusion FROM workflow_runs WHERE id = ?`,
      [run!.id],
    );
    expect(fresh).toMatchObject({ status: "completed", conclusion: "cancelled" });
  });
});

// --- secrets ----------------------------------------------------------------

describe("secrets", () => {
  test("admin puts (write-only) + lists names; writer is forbidden", async () => {
    const handle = makeEnv();
    const reg = router();
    const env = secretsEnv(handle);
    const seeded = await seedRepoWith(handle, { name: "sec" });
    // admin (maintainer role, hostingAdmin scope) sets a secret
    const put = await dispatch(
      reg,
      jsonRequest("PUT", `${R}/sec/actions/secrets/NPM_TOKEN`, { value: "s3cr3t" }, "taksrv_admin_a"),
      env,
    );
    expect(put.status).toBe(201);

    // list returns names + timestamps, never the value (admin scope required)
    const listed = await dispatch(reg, get(`${R}/sec/actions/secrets`, "taksrv_admin_a"), env);
    const listBody = (await listed.json()) as { secrets: Array<Record<string, unknown>> };
    expect(listBody.secrets.length).toBe(1);
    expect(listBody.secrets[0].name).toBe("NPM_TOKEN");
    expect(JSON.stringify(listBody.secrets[0])).not.toContain("s3cr3t");

    // stored ciphertext is not the plaintext
    const row = await handle.db.queryOne<{ value_enc: string }>(
      `SELECT value_enc FROM workflow_secrets WHERE repo_id = ? AND name = 'NPM_TOKEN'`,
      [seeded.repoId],
    );
    expect(row!.value_enc).not.toContain("s3cr3t");

    // a stranger with admin scope but no repo role is forbidden
    const forbidden = await dispatch(
      reg,
      jsonRequest("PUT", `${R}/sec/actions/secrets/X`, { value: "y" }, "taksrv_stranger_a"),
      env,
    );
    expect([403, 404]).toContain(forbidden.status);

    // delete
    const del = await dispatch(
      reg,
      jsonRequest("DELETE", `${R}/sec/actions/secrets/NPM_TOKEN`, undefined, "taksrv_admin_a"),
      env,
    );
    expect(del.status).toBe(200);
  });

  test("invalid secret name is rejected", async () => {
    const handle = makeEnv();
    const reg = router();
    await seedRepoWith(handle, { name: "sec2" });
    const res = await dispatch(
      reg,
      jsonRequest("PUT", `${R}/sec2/actions/secrets/lower-case`, { value: "y" }, "taksrv_admin_a"),
      secretsEnv(handle),
    );
    expect(res.status).toBe(400);
  });
});

// --- state machine (Phase-5b callbacks) -------------------------------------

describe("state machine", () => {
  test("startJob → completeJob projects check runs + finalizes the run", async () => {
    const handle = makeEnv();
    const seeded = await seedRepoWith(handle, { name: "sm" });
    const after = await commitFiles(
      handle.bucket,
      seeded.storageKey,
      [{ path: ".github/workflows/ci.yml", content: PUSH_WORKFLOW }],
      [seeded.commitSha],
    );
    // Trigger via handle.db so run-create + state-machine writes share one clock.
    await triggerViaDb(handle, seeded, after);
    const run = await handle.db.queryOne<{ id: string }>(`SELECT id FROM workflow_runs WHERE repo_id = ?`, [seeded.repoId]);
    const job = await handle.db.queryOne<{ id: string }>(`SELECT id FROM workflow_jobs WHERE run_id = ?`, [run!.id]);

    await startJob(handle.db, seeded.repoId, job!.id, "runner-1");
    let check = await handle.db.queryOne<{ status: string }>(
      `SELECT status FROM check_runs WHERE repo_id = ? AND external_id = ?`,
      [seeded.repoId, job!.id],
    );
    expect(check!.status).toBe("in_progress");
    const runMid = await handle.db.queryOne<{ status: string }>(`SELECT status FROM workflow_runs WHERE id = ?`, [run!.id]);
    expect(runMid!.status).toBe("in_progress");

    await completeJob(handle.db, seeded.repoId, job!.id, { conclusion: "success", logsR2Key: "logs/x.log" });
    check = await handle.db.queryOne<{ status: string; conclusion: string }>(
      `SELECT status, conclusion FROM check_runs WHERE repo_id = ? AND external_id = ?`,
      [seeded.repoId, job!.id],
    );
    expect(check).toMatchObject({ status: "completed", conclusion: "success" });

    // all jobs terminal → run finalized success
    const finalRun = await handle.db.queryOne<{ status: string; conclusion: string }>(
      `SELECT status, conclusion FROM workflow_runs WHERE id = ?`,
      [run!.id],
    );
    expect(finalRun).toMatchObject({ status: "completed", conclusion: "success" });

    // commit-status projection reflects success
    const status = await handle.db.queryOne<{ state: string }>(
      `SELECT state FROM commit_statuses WHERE repo_id = ? AND sha = ? ORDER BY created_at DESC LIMIT 1`,
      [seeded.repoId, after],
    );
    expect(status!.state).toBe("success");
  });
});
