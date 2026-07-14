/**
 * D1 service for Actions run lifecycle + status projection.
 *
 * D1 holds relational METADATA only. `workflow_runs.sha` / `check_runs.head_sha`
 * are advisory projections of R2-authoritative commits; callers resolve/validate
 * the SHA against R2 before creating a run. This module never touches R2 git
 * objects (log/artifact bytes live in the separate `R2_ACTIONS` bucket, handled by
 * the routes + Phase-5b runner).
 *
 * Two responsibilities:
 *  1. PERSIST — `createWorkflowRun` writes the `workflow_runs` + expanded
 *     `workflow_jobs` + `workflow_steps` rows and PROJECTS one queued `check_run`
 *     (+ pending `commit_status`) per job through the checks feature.
 *  2. STATE MACHINE — `startRun` / `startJob` / `updateStep` / `completeJob` /
 *     `cancelRun` are the idempotent transitions Phase 5b calls as jobs execute;
 *     each updates both the `workflow_*` rows and the projected check-run /
 *     commit-status.
 *
 * Ported from the Takos worker (`workflow-runs/commands.ts` +
 * `actions/actions-execution.ts`), severed from Drizzle / the retired
 * `RUNTIME_HOST` runtime.
 */

import type { DbClient } from "../../db/index.ts";
import {
  createCheckRun,
  createCommitStatus,
  getCheckRun,
  updateCheckRun,
  type CheckRunRecord,
} from "../checks/service.ts";
import {
  toCheckConclusion,
  toCommitStatusState,
  type RunConclusion,
} from "./dto.ts";
import { expandRunJobs, type ExpandedRunJob } from "./expansion.ts";
import type { Workflow } from "./engine/index.ts";
import { triggerEventNames } from "./triggers.ts";

// ============================================================================
// Sequence allocation
// ============================================================================

/**
 * Atomically allocate the next `run_number` for `(repo, workflowPath)` from
 * `repo_counters` scope `workflow:<path>`. A single upsert reserves the current
 * value and advances the cursor, so concurrent triggers never collide.
 */
export async function allocateRunNumber(
  db: DbClient,
  repoId: string,
  workflowPath: string,
): Promise<number> {
  const row = await db.queryOne<{ nv: number }>(
    `INSERT INTO repo_counters (repo_id, scope, next_value) VALUES (?, ?, 2)
     ON CONFLICT(repo_id, scope) DO UPDATE SET next_value = next_value + 1
     RETURNING next_value AS nv`,
    [repoId, `workflow:${workflowPath}`],
  );
  return (row?.nv ?? 2) - 1;
}

/** Next `run_attempt` for a rerun of an existing `(repo, workflowPath, runNumber)`. */
export async function nextRunAttempt(
  db: DbClient,
  repoId: string,
  workflowPath: string,
  runNumber: number,
): Promise<number> {
  const row = await db.queryOne<{ mx: number | null }>(
    `SELECT MAX(run_attempt) AS mx FROM workflow_runs
      WHERE repo_id = ? AND workflow_path = ? AND run_number = ?`,
    [repoId, workflowPath, runNumber],
  );
  return (row?.mx ?? 0) + 1;
}

// ============================================================================
// Workflow-definition cache (workflows table)
// ============================================================================

/**
 * Upsert the `workflows` cache row for `(repo, path)` and return its id. The row
 * is a convenience index (name + triggers + content SHA); the workflow file in R2
 * stays authoritative.
 */
export async function upsertWorkflow(
  db: DbClient,
  repoId: string,
  path: string,
  name: string | null,
  triggers: readonly string[],
  contentSha: string,
): Promise<string> {
  const now = db.now();
  const existing = await db.queryOne<{ id: string }>(
    `SELECT id FROM workflows WHERE repo_id = ? AND path = ? LIMIT 1`,
    [repoId, path],
  );
  const triggersJson = JSON.stringify(triggers);
  if (existing) {
    await db.run(
      `UPDATE workflows SET name = ?, content_sha = ?, triggers = ?, parsed_at = ?, updated_at = ?
        WHERE id = ?`,
      [name, contentSha, triggersJson, now, now, existing.id],
    );
    return existing.id;
  }
  const id = db.id();
  await db.run(
    `INSERT INTO workflows
       (id, repo_id, path, name, content_sha, triggers, state, parsed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    [id, repoId, path, name, contentSha, triggersJson, now, now, now],
  );
  return id;
}

// ============================================================================
// Run creation (PERSIST + status projection)
// ============================================================================

export interface CreateWorkflowRunInput {
  readonly repoId: string;
  /** `owner/name`, for the GitHub-context env baked into step contracts. */
  readonly repoFullName: string;
  readonly workflowPath: string;
  readonly workflowId: string | null;
  readonly event: string;
  /** Stored ref, e.g. `refs/heads/main`. */
  readonly ref: string;
  readonly sha: string;
  readonly actorId: string | null;
  readonly inputs?: Record<string, unknown> | null;
  readonly workflow: Workflow;
  /** Allocated run number (fresh) — reused on reruns. */
  readonly runNumber: number;
  readonly runAttempt?: number;
}

export interface CreatedRun {
  readonly id: string;
  readonly runNumber: number;
  readonly runAttempt: number;
  readonly jobIds: string[];
}

/** Truncate a value to a safe column length for check/status text. */
function cap(value: string, max = 255): string {
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Create a workflow run: insert the run + expanded jobs + steps and project one
 * queued check-run (+ pending commit-status) per job. Returns the created ids.
 */
export async function createWorkflowRun(
  db: DbClient,
  input: CreateWorkflowRunInput,
): Promise<CreatedRun> {
  const now = db.now();
  const runId = db.id();
  const runAttempt = input.runAttempt ?? 1;

  await db.run(
    `INSERT INTO workflow_runs
       (id, repo_id, workflow_id, workflow_path, event, ref, sha, actor_id, status,
        conclusion, run_number, run_attempt, inputs, queued_at, started_at,
        completed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, ?, ?, ?, ?, NULL, NULL, ?)`,
    [
      runId,
      input.repoId,
      input.workflowId,
      input.workflowPath,
      input.event,
      input.ref,
      input.sha,
      input.actorId,
      input.runNumber,
      runAttempt,
      input.inputs ? JSON.stringify(input.inputs) : null,
      now,
      now,
    ],
  );

  const expanded = expandRunJobs(input.workflow, {
    workflowPath: input.workflowPath,
    repoFullName: input.repoFullName,
    runId,
    ref: input.ref,
    sha: input.sha,
  });

  const workflowLabel = input.workflow.name ?? input.workflowPath;
  const jobIds: string[] = [];

  for (const job of expanded) {
    const jobId = await insertJob(db, runId, job, now);
    jobIds.push(jobId);
    await insertSteps(db, jobId, job, now);
    // Projection: one queued check-run + pending commit-status per job.
    const context = cap(`${workflowLabel} / ${job.name}`);
    await createCheckRun(db, input.repoId, {
      headSha: input.sha,
      name: context,
      status: "queued",
      workflowRunId: runId,
      externalId: jobId,
    });
    await createCommitStatus(db, input.repoId, {
      sha: input.sha,
      context,
      state: "pending",
      description: "Queued",
      creatorId: input.actorId,
    });
  }

  return { id: runId, runNumber: input.runNumber, runAttempt, jobIds };
}

async function insertJob(
  db: DbClient,
  runId: string,
  job: ExpandedRunJob,
  now: number,
): Promise<string> {
  const jobId = db.id();
  await db.run(
    `INSERT INTO workflow_jobs
       (id, run_id, job_key, name, matrix, needs, status, conclusion, runner_id,
        runner_name, logs_r2_key, queued_at, started_at, completed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'queued', NULL, NULL, NULL, NULL, ?, NULL, NULL, ?)`,
    [
      jobId,
      runId,
      job.jobKey,
      job.name,
      job.matrix ? JSON.stringify(job.matrix) : null,
      JSON.stringify(job.needs),
      now,
      now,
    ],
  );
  return jobId;
}

async function insertSteps(
  db: DbClient,
  jobId: string,
  job: ExpandedRunJob,
  now: number,
): Promise<void> {
  for (const step of job.steps) {
    await db.run(
      `INSERT INTO workflow_steps
         (id, job_id, number, name, exec_contract, status, conclusion, exit_code,
          error_message, logs_r2_key, started_at, completed_at, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, NULL, NULL, NULL, ?)`,
      [
        db.id(),
        jobId,
        step.number,
        step.name,
        JSON.stringify(step.contract),
        now,
      ],
    );
  }
}

// ============================================================================
// State machine (Phase-5b callbacks)
// ============================================================================

interface RunRow {
  id: string;
  repo_id: string;
  workflow_path: string;
  sha: string | null;
  status: string;
  run_number: number;
  run_attempt: number;
}

interface JobRow {
  id: string;
  run_id: string;
  name: string;
  status: string;
  conclusion: string | null;
}

async function getRun(
  db: DbClient,
  repoId: string,
  runId: string,
): Promise<RunRow | null> {
  return db.queryOne<RunRow>(
    `SELECT id, repo_id, workflow_path, sha, status, run_number, run_attempt
       FROM workflow_runs WHERE id = ? AND repo_id = ? LIMIT 1`,
    [runId, repoId],
  );
}

/** A job row joined to its run so a jobId alone can be repo-scoped + projected. */
async function getJobScoped(
  db: DbClient,
  repoId: string,
  jobId: string,
): Promise<(JobRow & { sha: string | null }) | null> {
  return db.queryOne<JobRow & { sha: string | null }>(
    `SELECT j.id, j.run_id, j.name, j.status, j.conclusion, r.sha
       FROM workflow_jobs j
       JOIN workflow_runs r ON r.id = j.run_id
      WHERE j.id = ? AND r.repo_id = ? LIMIT 1`,
    [jobId, repoId],
  );
}

async function findJobCheckRun(
  db: DbClient,
  repoId: string,
  runId: string,
  jobId: string,
): Promise<CheckRunRecord | null> {
  const row = await db.queryOne<{ id: string }>(
    `SELECT id FROM check_runs
      WHERE repo_id = ? AND workflow_run_id = ? AND external_id = ? LIMIT 1`,
    [repoId, runId, jobId],
  );
  if (!row) return null;
  // Reuse the checks service getter so the returned shape stays canonical.
  return getCheckRun(db, repoId, row.id);
}

/** Mark a run in progress (idempotent; only advances a queued run). */
export async function startRun(
  db: DbClient,
  repoId: string,
  runId: string,
): Promise<void> {
  const now = db.now();
  await db.run(
    `UPDATE workflow_runs
        SET status = 'in_progress', started_at = COALESCE(started_at, ?)
      WHERE id = ? AND repo_id = ? AND status = 'queued'`,
    [now, runId, repoId],
  );
}

/** Mark a job in progress + project its check-run to in_progress. */
export async function startJob(
  db: DbClient,
  repoId: string,
  jobId: string,
  runnerName?: string | null,
): Promise<void> {
  const job = await getJobScoped(db, repoId, jobId);
  if (!job) return;
  const now = db.now();
  await db.run(
    `UPDATE workflow_jobs
        SET status = 'in_progress', started_at = COALESCE(started_at, ?), runner_name = ?
      WHERE id = ? AND status = 'queued'`,
    [now, runnerName ?? null, jobId],
  );
  await startRun(db, repoId, job.run_id);
  const check = await findJobCheckRun(db, repoId, job.run_id, jobId);
  if (check && check.status !== "completed") {
    await updateCheckRun(db, repoId, check.id, {
      status: "in_progress",
      startedAt: now,
    });
  }
}

export interface StepPatch {
  readonly status?: "pending" | "in_progress" | "completed";
  readonly conclusion?: RunConclusion | null;
  readonly exitCode?: number | null;
  readonly errorMessage?: string | null;
  readonly logsR2Key?: string | null;
  readonly startedAt?: number | null;
  readonly completedAt?: number | null;
}

/** Update one step's execution state (Phase-5b per-step callback). */
export async function updateStep(
  db: DbClient,
  stepId: string,
  patch: StepPatch,
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (col: string, value: unknown): void => {
    sets.push(`${col} = ?`);
    params.push(value);
  };
  if (patch.status !== undefined) push("status", patch.status);
  if (patch.conclusion !== undefined) push("conclusion", patch.conclusion);
  if (patch.exitCode !== undefined) push("exit_code", patch.exitCode);
  if (patch.errorMessage !== undefined) push("error_message", patch.errorMessage);
  if (patch.logsR2Key !== undefined) push("logs_r2_key", patch.logsR2Key);
  if (patch.startedAt !== undefined) push("started_at", patch.startedAt);
  if (patch.completedAt !== undefined) push("completed_at", patch.completedAt);
  if (sets.length === 0) return;
  params.push(stepId);
  await db.run(
    `UPDATE workflow_steps SET ${sets.join(", ")} WHERE id = ?`,
    params,
  );
}

/** Complete a job with a verdict; project the check-run + commit-status, then
 * finalize the run when every job is terminal. */
export async function completeJob(
  db: DbClient,
  repoId: string,
  jobId: string,
  outcome: { conclusion: RunConclusion; logsR2Key?: string | null },
): Promise<void> {
  const job = await getJobScoped(db, repoId, jobId);
  if (!job) return;
  const now = db.now();
  const changed = await db.run(
    `UPDATE workflow_jobs
        SET status = 'completed', conclusion = ?, completed_at = ?,
            started_at = COALESCE(started_at, ?), logs_r2_key = COALESCE(?, logs_r2_key)
      WHERE id = ? AND status != 'completed'`,
    [outcome.conclusion, now, now, outcome.logsR2Key ?? null, jobId],
  );
  if (!changed.meta.changes) return; // already terminal — idempotent no-op
  await projectJobConclusion(db, repoId, job.run_id, jobId, job.name, job.sha, outcome.conclusion);
  await finalizeRunIfComplete(db, repoId, job.run_id);
}

async function projectJobConclusion(
  db: DbClient,
  repoId: string,
  runId: string,
  jobId: string,
  jobName: string,
  sha: string | null,
  conclusion: RunConclusion,
): Promise<void> {
  const now = db.now();
  const check = await findJobCheckRun(db, repoId, runId, jobId);
  if (check) {
    await updateCheckRun(db, repoId, check.id, {
      status: "completed",
      conclusion: toCheckConclusion(conclusion) as CheckRunRecord["conclusion"],
      completedAt: now,
      startedAt: check.startedAt ?? now,
    });
  }
  if (sha) {
    // Reuse the check-run's name as the commit-status context so the create-time
    // (pending) post and this terminal post share one context and the combined
    // status transitions in place rather than accumulating two contexts.
    const context = check?.name ?? cap(jobName);
    await createCommitStatus(db, repoId, {
      sha,
      context,
      state: toCommitStatusState(conclusion),
      description: conclusion,
    });
  }
}

const RUN_RANK: Record<RunConclusion, number> = {
  failure: 4,
  timed_out: 3,
  cancelled: 2,
  success: 1,
  skipped: 0,
};

/** Finalize a run to `completed` once every job is terminal (all-jobs rollup). */
export async function finalizeRunIfComplete(
  db: DbClient,
  repoId: string,
  runId: string,
): Promise<void> {
  const jobs = await db.query<{ status: string; conclusion: string | null }>(
    `SELECT status, conclusion FROM workflow_jobs WHERE run_id = ?`,
    [runId],
  );
  if (jobs.length === 0) return;
  if (jobs.some((job) => job.status !== "completed")) return;
  let best: RunConclusion = "skipped";
  for (const job of jobs) {
    const conclusion = (job.conclusion as RunConclusion | null) ?? "failure";
    if (RUN_RANK[conclusion] >= RUN_RANK[best]) best = conclusion;
  }
  const now = db.now();
  await db.run(
    `UPDATE workflow_runs
        SET status = 'completed', conclusion = ?, completed_at = ?,
            started_at = COALESCE(started_at, ?)
      WHERE id = ? AND repo_id = ? AND status != 'completed'`,
    [best, now, now, runId, repoId],
  );
}

/**
 * Cancel a run: flip the run + every non-terminal job/step to a cancelled
 * verdict and project the check-runs / commit-statuses. Returns false when the
 * run is unknown or already terminal.
 */
export async function cancelRun(
  db: DbClient,
  repoId: string,
  runId: string,
): Promise<boolean> {
  const run = await getRun(db, repoId, runId);
  if (!run) return false;
  if (run.status === "completed") return false;
  const now = db.now();

  const activeJobs = await db.query<JobRow>(
    `SELECT id, run_id, name, status, conclusion FROM workflow_jobs
      WHERE run_id = ? AND status != 'completed'`,
    [runId],
  );

  await db.run(
    `UPDATE workflow_steps SET status = 'completed', conclusion = 'cancelled', completed_at = ?
      WHERE job_id IN (SELECT id FROM workflow_jobs WHERE run_id = ?)
        AND status != 'completed'`,
    [now, runId],
  );
  await db.run(
    `UPDATE workflow_jobs SET status = 'completed', conclusion = 'cancelled', completed_at = ?
      WHERE run_id = ? AND status != 'completed'`,
    [now, runId],
  );
  await db.run(
    `UPDATE workflow_runs SET status = 'completed', conclusion = 'cancelled', completed_at = ?
      WHERE id = ? AND repo_id = ? AND status != 'completed'`,
    [now, runId, repoId],
  );

  for (const job of activeJobs) {
    await projectJobConclusion(db, repoId, runId, job.id, job.name, run.sha, "cancelled");
  }
  return true;
}

// ============================================================================
// Trigger-name helper (used by workflow upsert on discovery)
// ============================================================================

export function workflowTriggerNames(workflow: Workflow): string[] {
  return triggerEventNames(workflow.on);
}
