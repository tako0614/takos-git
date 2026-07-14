import { describe, expect, test } from "bun:test";

import { putBlob, putCommit } from "../../../git/object-store.ts";
import { buildTreeFromPaths } from "../../../git/tree-ops.ts";
import { FILE_MODES } from "../../../git/git-objects.ts";
import { repositoryObjectStore } from "../../../git/repo-object-store.ts";
import { writeRepoRefs, readRunPin } from "../../../git/refs-store.ts";
import type { ObjectStoreBinding } from "../../../git/types.ts";
import { makeEnv, seedFullRepo, type SeededRepo, type TestEnvHandle } from "../../repos/testkit.ts";
import { discoverWorkflows } from "../discovery.ts";
import { allocateRunNumber } from "../service.ts";
import { persistAndDispatchRun } from "../orchestrator.ts";
import { RunCoordinator, computeKeyStates, evaluateNeeds, type CoordinatorStorage } from "./coordinator.ts";
import { DEFAULT_RUNNER_POLICY, type RunnerPolicy } from "./policy.ts";
import type { ActionsJobDispatch, ActionsJobResult, RunConclusion } from "./contract.ts";

// ── fakes ───────────────────────────────────────────────────────────────────

class FakeStorage implements CoordinatorStorage {
  readonly map = new Map<string, unknown>();
  readonly alarms: number[] = [];
  async get<T>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.map.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
  async list<T>(options: { prefix: string }): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    for (const [key, value] of this.map) {
      if (key.startsWith(options.prefix)) out.set(key, value as T);
    }
    return out;
  }
  async setAlarm(scheduledTime: number): Promise<void> {
    this.alarms.push(scheduledTime);
  }
}

interface Harness {
  readonly coordinator: RunCoordinator;
  readonly storage: FakeStorage;
  readonly dispatched: ActionsJobDispatch[];
  readonly clock: { value: number };
}

function harness(
  handle: TestEnvHandle,
  overrides: { policy?: RunnerPolicy } = {},
): Harness {
  const storage = new FakeStorage();
  const dispatched: ActionsJobDispatch[] = [];
  const clock = { value: 2_000_000_000_000 };
  const coordinator = new RunCoordinator({
    db: handle.db,
    bucket: handle.bucket,
    storage,
    runnerSecret: "r".repeat(32),
    secretsKey: null,
    callbackBaseUrl: "https://git.example",
    policy: overrides.policy ?? DEFAULT_RUNNER_POLICY,
    now: () => clock.value,
    dispatchJob: async (input) => {
      dispatched.push(input);
    },
  });
  return { coordinator, storage, dispatched, clock };
}

async function commitWorkflow(
  bucket: ObjectStoreBinding,
  repoKey: string,
  yaml: string,
  parent: string,
): Promise<string> {
  const store = repositoryObjectStore(bucket, repoKey);
  const blob = await putBlob(store, new TextEncoder().encode(yaml));
  const tree = await buildTreeFromPaths(store, [
    { path: ".github/workflows/ci.yml", sha: blob, mode: FILE_MODES.REGULAR_FILE },
  ]);
  const sig = { name: "T", email: "t@e", timestamp: 1_700_000_000, tzOffset: "+0000" };
  const commit = await putCommit(store, { tree, parents: [parent], author: sig, committer: sig, message: "wf\n" });
  await writeRepoRefs(bucket, repoKey, {
    refs: [{ name: "refs/heads/main", sha: commit }],
    defaultBranch: "main",
  });
  return commit;
}

/** Seed a run from a workflow YAML; returns runId + a jobKey→jobId map. */
async function seedRun(
  handle: TestEnvHandle,
  seeded: SeededRepo,
  yaml: string,
): Promise<{ runId: string; jobIdByKey: Map<string, string[]> }> {
  const sha = await commitWorkflow(handle.bucket, seeded.storageKey, yaml, seeded.commitSha);
  const objects = repositoryObjectStore(handle.bucket, seeded.storageKey);
  const [candidate] = await discoverWorkflows(objects, sha);
  const runNumber = await allocateRunNumber(handle.db, seeded.repoId, candidate.path);
  const created = await persistAndDispatchRun(handle.db, handle.env, {
    repoId: seeded.repoId,
    repoFullName: seeded.storageKey,
    workflowPath: candidate.path,
    workflowName: candidate.name,
    contentSha: candidate.contentSha,
    event: "push",
    ref: "refs/heads/main",
    sha,
    actorId: null,
    workflow: candidate.workflow,
    runNumber,
  });
  const rows = await handle.db.query<{ id: string; job_key: string | null }>(
    `SELECT id, job_key FROM workflow_jobs WHERE run_id = ? ORDER BY created_at ASC, rowid ASC`,
    [created.id],
  );
  const jobIdByKey = new Map<string, string[]>();
  for (const row of rows) {
    const key = row.job_key ?? row.id;
    const list = jobIdByKey.get(key) ?? [];
    list.push(row.id);
    jobIdByKey.set(key, list);
  }
  return { runId: created.id, jobIdByKey };
}

function result(runId: string, jobId: string, conclusion: RunConclusion): ActionsJobResult {
  return { runId, jobId, conclusion, steps: [], logsR2Key: null };
}

async function jobStatus(handle: TestEnvHandle, jobId: string): Promise<{ status: string; conclusion: string | null }> {
  const row = await handle.db.queryOne<{ status: string; conclusion: string | null }>(
    `SELECT status, conclusion FROM workflow_jobs WHERE id = ?`,
    [jobId],
  );
  return row!;
}

async function runStatus(handle: TestEnvHandle, runId: string): Promise<{ status: string; conclusion: string | null }> {
  const row = await handle.db.queryOne<{ status: string; conclusion: string | null }>(
    `SELECT status, conclusion FROM workflow_runs WHERE id = ?`,
    [runId],
  );
  return row!;
}

const LINEAR = `name: CI
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps: [{ run: echo a }]
  b:
    needs: a
    runs-on: ubuntu-latest
    steps: [{ run: echo b }]
  c:
    needs: b
    runs-on: ubuntu-latest
    steps: [{ run: echo c }]
`;

const DIAMOND = `name: CI
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps: [{ run: echo a }]
  b:
    needs: a
    runs-on: ubuntu-latest
    steps: [{ run: echo b }]
  c:
    needs: a
    runs-on: ubuntu-latest
    steps: [{ run: echo c }]
  d:
    needs: [b, c]
    runs-on: ubuntu-latest
    steps: [{ run: echo d }]
`;

// ── pure-helper tests ─────────────────────────────────────────────────────────

describe("needs gating (pure)", () => {
  test("no needs → ready", () => {
    expect(evaluateNeeds([], new Map())).toBe("ready");
  });
  test("unsettled prerequisite → waiting", () => {
    const states = new Map([["a", { settled: false, conclusion: null }]]);
    expect(evaluateNeeds(["a"], states)).toBe("waiting");
  });
  test("all needs success → ready; any non-success → skip", () => {
    const ok = new Map([["a", { settled: true, conclusion: "success" as RunConclusion }]]);
    expect(evaluateNeeds(["a"], ok)).toBe("ready");
    const bad = new Map([["a", { settled: true, conclusion: "failure" as RunConclusion }]]);
    expect(evaluateNeeds(["a"], bad)).toBe("skip");
    const skipped = new Map([["a", { settled: true, conclusion: "skipped" as RunConclusion }]]);
    expect(evaluateNeeds(["a"], skipped)).toBe("skip");
  });
  test("matrix aggregate is the worst cell", () => {
    const jobs = [
      { id: "1", job_key: "a", matrix: null, needs: null, status: "completed", conclusion: "success" },
      { id: "2", job_key: "a", matrix: null, needs: null, status: "completed", conclusion: "failure" },
    ];
    const states = computeKeyStates(jobs as never);
    expect(states.get("a")).toEqual({ settled: true, conclusion: "failure" });
  });
});

// ── coordinator behavior ──────────────────────────────────────────────────────

describe("RunCoordinator", () => {
  test("dispatches only the DAG frontier and advances wave-by-wave", async () => {
    const handle = makeEnv();
    const seeded = await seedFullRepo(handle, { ownerLogin: "acme", name: "lin" });
    const { runId, jobIdByKey } = await seedRun(handle, seeded, LINEAR);
    const h = harness(handle);
    const [a] = jobIdByKey.get("a")!;
    const [b] = jobIdByKey.get("b")!;
    const [c] = jobIdByKey.get("c")!;

    await h.coordinator.tick(seeded.repoId, runId);
    expect(h.dispatched.map((d) => d.jobId)).toEqual([a]);
    expect((await jobStatus(handle, a)).status).toBe("in_progress");
    expect((await jobStatus(handle, b)).status).toBe("queued");
    expect((await runStatus(handle, runId)).status).toBe("in_progress");
    // the run pinned its commit through the refs-doc CAS
    const runSha = (await handle.db.queryOne<{ sha: string }>(`SELECT sha FROM workflow_runs WHERE id = ?`, [runId]))!.sha;
    expect(await readRunPin(handle.bucket, seeded.storageKey, runId)).toBe(runSha);

    await h.coordinator.reportJobResult(result(runId, a, "success"));
    expect(h.dispatched.map((d) => d.jobId)).toEqual([a, b]);

    await h.coordinator.reportJobResult(result(runId, b, "success"));
    expect(h.dispatched.map((d) => d.jobId)).toEqual([a, b, c]);

    await h.coordinator.reportJobResult(result(runId, c, "success"));
    expect(await runStatus(handle, runId)).toMatchObject({ status: "completed", conclusion: "success" });
  });

  test("diamond: fan-out then fan-in join waits for both parents", async () => {
    const handle = makeEnv();
    const seeded = await seedFullRepo(handle, { ownerLogin: "acme", name: "dia" });
    const { runId, jobIdByKey } = await seedRun(handle, seeded, DIAMOND);
    const h = harness(handle);
    const [a] = jobIdByKey.get("a")!;
    const [b] = jobIdByKey.get("b")!;
    const [c] = jobIdByKey.get("c")!;
    const [d] = jobIdByKey.get("d")!;

    await h.coordinator.tick(seeded.repoId, runId);
    expect(h.dispatched.map((x) => x.jobId)).toEqual([a]);

    await h.coordinator.reportJobResult(result(runId, a, "success"));
    expect(new Set(h.dispatched.map((x) => x.jobId))).toEqual(new Set([a, b, c]));

    await h.coordinator.reportJobResult(result(runId, b, "success"));
    expect(h.dispatched.map((x) => x.jobId)).not.toContain(d); // c still pending

    await h.coordinator.reportJobResult(result(runId, c, "success"));
    expect(h.dispatched.map((x) => x.jobId)).toContain(d);
  });

  test("a failed prerequisite skips its dependents and fails the run", async () => {
    const handle = makeEnv();
    const seeded = await seedFullRepo(handle, { ownerLogin: "acme", name: "skp" });
    const { runId, jobIdByKey } = await seedRun(handle, seeded, LINEAR);
    const h = harness(handle);
    const [a] = jobIdByKey.get("a")!;
    const [b] = jobIdByKey.get("b")!;
    const [c] = jobIdByKey.get("c")!;

    await h.coordinator.tick(seeded.repoId, runId);
    await h.coordinator.reportJobResult(result(runId, a, "failure"));

    expect(await jobStatus(handle, b)).toMatchObject({ status: "completed", conclusion: "skipped" });
    expect(await jobStatus(handle, c)).toMatchObject({ status: "completed", conclusion: "skipped" });
    expect(await runStatus(handle, runId)).toMatchObject({ status: "completed", conclusion: "failure" });
    expect(h.dispatched.map((x) => x.jobId)).toEqual([a]); // b, c never dispatched
  });

  test("honors the per-run concurrency budget", async () => {
    const handle = makeEnv();
    const seeded = await seedFullRepo(handle, { ownerLogin: "acme", name: "cc" });
    const yaml = `name: CI\non: push\njobs:\n  a: { runs-on: x, steps: [{ run: echo a }] }\n  b: { runs-on: x, steps: [{ run: echo b }] }\n  c: { runs-on: x, steps: [{ run: echo c }] }\n`;
    const { runId } = await seedRun(handle, seeded, yaml);
    const policy: RunnerPolicy = { ...DEFAULT_RUNNER_POLICY, maxConcurrentJobs: 2 };
    const h = harness(handle, { policy });

    await h.coordinator.tick(seeded.repoId, runId);
    expect(h.dispatched.length).toBe(2); // budget capped at 2 of 3

    await h.coordinator.reportJobResult(result(runId, h.dispatched[0].jobId, "success"));
    expect(h.dispatched.length).toBe(3); // freed budget dispatches the third
  });

  test("re-delivery is idempotent (no double dispatch)", async () => {
    const handle = makeEnv();
    const seeded = await seedFullRepo(handle, { ownerLogin: "acme", name: "idem" });
    const { runId, jobIdByKey } = await seedRun(handle, seeded, LINEAR);
    const h = harness(handle);
    await h.coordinator.tick(seeded.repoId, runId);
    await h.coordinator.tick(seeded.repoId, runId); // duplicate delivery
    expect(h.dispatched.map((x) => x.jobId)).toEqual([jobIdByKey.get("a")![0]]);
  });

  test("cancellation stops the run and dispatches nothing further", async () => {
    const handle = makeEnv();
    const seeded = await seedFullRepo(handle, { ownerLogin: "acme", name: "cx" });
    const { runId } = await seedRun(handle, seeded, LINEAR);
    const h = harness(handle);
    await h.coordinator.tick(seeded.repoId, runId);
    const before = h.dispatched.length;
    await h.coordinator.requestCancel(seeded.repoId, runId);
    expect(await runStatus(handle, runId)).toMatchObject({ status: "completed", conclusion: "cancelled" });
    await h.coordinator.tick(seeded.repoId, runId); // a re-delivered tick after cancel
    expect(h.dispatched.length).toBe(before);
  });

  test("timeout alarm reaps an in-flight job as timed_out", async () => {
    const handle = makeEnv();
    const seeded = await seedFullRepo(handle, { ownerLogin: "acme", name: "to" });
    const yaml = `name: CI\non: push\njobs:\n  a: { runs-on: x, steps: [{ run: sleep 1 }] }\n`;
    const { runId, jobIdByKey } = await seedRun(handle, seeded, yaml);
    const h = harness(handle);
    await h.coordinator.tick(seeded.repoId, runId);
    const [a] = jobIdByKey.get("a")!;
    expect((await jobStatus(handle, a)).status).toBe("in_progress");

    h.clock.value += DEFAULT_RUNNER_POLICY.resources.defaultJobTimeoutMinutes * 60_000 + 1;
    await h.coordinator.alarm();
    expect(await jobStatus(handle, a)).toMatchObject({ status: "completed", conclusion: "timed_out" });
    expect(await runStatus(handle, runId)).toMatchObject({ status: "completed", conclusion: "timed_out" });
  });
});
