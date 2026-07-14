/**
 * Read side for the Actions feature — run / job / step projections as `/api/v1`
 * DTOs.
 *
 * Ported from the Takos worker `workflow-runs/read-model.ts`, rebound onto the
 * takos-git `DbClient` + snake_case columns, with the Takos `accounts` join
 * replaced by `principals` (the re-rooted identity model).
 */

import type { DbClient } from "../../db/index.ts";
import {
  type ActorDto,
  type RunConclusion,
  type RunStatus,
  type StepStatus,
  type WorkflowJobDto,
  type WorkflowRunDto,
  type WorkflowStepDto,
} from "./dto.ts";

interface RawRun {
  id: string;
  workflow_id: string | null;
  workflow_path: string;
  event: string;
  ref: string | null;
  sha: string | null;
  status: string;
  conclusion: string | null;
  run_number: number;
  run_attempt: number;
  actor_id: string | null;
  actor_subject: string | null;
  actor_display_name: string | null;
  actor_avatar_url: string | null;
  queued_at: number | null;
  started_at: number | null;
  completed_at: number | null;
  created_at: number;
}

interface RawJob {
  id: string;
  job_key: string | null;
  name: string;
  matrix: string | null;
  needs: string | null;
  status: string;
  conclusion: string | null;
  runner_name: string | null;
  started_at: number | null;
  completed_at: number | null;
}

interface RawStep {
  number: number;
  name: string;
  status: string;
  conclusion: string | null;
  exit_code: number | null;
  error_message: string | null;
  started_at: number | null;
  completed_at: number | null;
}

const RUN_COLUMNS = `r.id, r.workflow_id, r.workflow_path, r.event, r.ref, r.sha,
  r.status, r.conclusion, r.run_number, r.run_attempt, r.actor_id,
  p.subject AS actor_subject, p.display_name AS actor_display_name,
  p.avatar_url AS actor_avatar_url,
  r.queued_at, r.started_at, r.completed_at, r.created_at`;

function actorOf(row: RawRun): ActorDto | null {
  if (!row.actor_id) return null;
  return {
    id: row.actor_id,
    subject: row.actor_subject ?? row.actor_id,
    displayName: row.actor_display_name,
    avatarUrl: row.actor_avatar_url,
  };
}

function runDto(row: RawRun): WorkflowRunDto {
  return {
    id: row.id,
    workflowPath: row.workflow_path,
    workflowId: row.workflow_id,
    event: row.event,
    ref: row.ref,
    sha: row.sha,
    status: row.status as RunStatus,
    conclusion: (row.conclusion as RunConclusion | null) ?? null,
    runNumber: row.run_number,
    runAttempt: row.run_attempt,
    actor: actorOf(row),
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
  };
}

function safeParse<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function jobDto(row: RawJob, steps?: WorkflowStepDto[]): WorkflowJobDto {
  return {
    id: row.id,
    jobKey: row.job_key,
    name: row.name,
    matrix: safeParse<Record<string, unknown> | null>(row.matrix, null),
    needs: safeParse<string[]>(row.needs, []),
    status: row.status as RunStatus,
    conclusion: (row.conclusion as RunConclusion | null) ?? null,
    runnerName: row.runner_name,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    ...(steps ? { steps } : {}),
  };
}

function stepDto(row: RawStep): WorkflowStepDto {
  return {
    number: row.number,
    name: row.name,
    status: row.status as StepStatus,
    conclusion: (row.conclusion as RunConclusion | null) ?? null,
    exitCode: row.exit_code,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export interface ListRunsFilters {
  readonly workflow?: string;
  readonly status?: string;
  readonly branch?: string;
  readonly event?: string;
  readonly limit: number;
  readonly offset: number;
}

export interface ListRunsResult {
  readonly runs: WorkflowRunDto[];
  readonly hasMore: boolean;
}

/** List runs newest-first with optional filters; over-fetches one for `hasMore`. */
export async function listWorkflowRuns(
  db: DbClient,
  repoId: string,
  filters: ListRunsFilters,
): Promise<ListRunsResult> {
  const conditions = ["r.repo_id = ?"];
  const params: unknown[] = [repoId];
  if (filters.workflow) {
    conditions.push("r.workflow_path = ?");
    params.push(filters.workflow);
  }
  if (filters.status) {
    conditions.push("r.status = ?");
    params.push(filters.status);
  }
  if (filters.branch) {
    conditions.push("r.ref = ?");
    params.push(`refs/heads/${filters.branch}`);
  }
  if (filters.event) {
    conditions.push("r.event = ?");
    params.push(filters.event);
  }
  params.push(filters.limit + 1, filters.offset);
  const rows = await db.query<RawRun>(
    `SELECT ${RUN_COLUMNS}
       FROM workflow_runs r
       LEFT JOIN principals p ON p.id = r.actor_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY r.created_at DESC, r.rowid DESC
      LIMIT ? OFFSET ?`,
    params,
  );
  const hasMore = rows.length > filters.limit;
  const page = hasMore ? rows.slice(0, filters.limit) : rows;
  return { runs: page.map(runDto), hasMore };
}

/** A single run with its jobs (and each job's steps) fully expanded. */
export async function getWorkflowRunDetail(
  db: DbClient,
  repoId: string,
  runId: string,
): Promise<{ run: WorkflowRunDto; jobs: WorkflowJobDto[] } | null> {
  const row = await db.queryOne<RawRun>(
    `SELECT ${RUN_COLUMNS}
       FROM workflow_runs r
       LEFT JOIN principals p ON p.id = r.actor_id
      WHERE r.id = ? AND r.repo_id = ? LIMIT 1`,
    [runId, repoId],
  );
  if (!row) return null;
  const jobs = await jobsWithSteps(db, runId);
  return { run: runDto(row), jobs };
}

async function jobRows(db: DbClient, runId: string): Promise<RawJob[]> {
  return db.query<RawJob>(
    `SELECT id, job_key, name, matrix, needs, status, conclusion, runner_name,
            started_at, completed_at
       FROM workflow_jobs WHERE run_id = ? ORDER BY created_at ASC, rowid ASC`,
    [runId],
  );
}

async function jobsWithSteps(
  db: DbClient,
  runId: string,
): Promise<WorkflowJobDto[]> {
  const jobs = await jobRows(db, runId);
  const out: WorkflowJobDto[] = [];
  for (const job of jobs) {
    const steps = await db.query<RawStep>(
      `SELECT number, name, status, conclusion, exit_code, error_message,
              started_at, completed_at
         FROM workflow_steps WHERE job_id = ? ORDER BY number ASC`,
      [job.id],
    );
    out.push(jobDto(job, steps.map(stepDto)));
  }
  return out;
}

/** List a run's jobs (no steps). Returns null when the run is not in this repo. */
export async function getWorkflowRunJobs(
  db: DbClient,
  repoId: string,
  runId: string,
): Promise<WorkflowJobDto[] | null> {
  const run = await db.queryOne<{ id: string }>(
    `SELECT id FROM workflow_runs WHERE id = ? AND repo_id = ? LIMIT 1`,
    [runId, repoId],
  );
  if (!run) return null;
  const jobs = await jobRows(db, runId);
  return jobs.map((job) => jobDto(job));
}

export interface JobWithSteps {
  readonly job: WorkflowJobDto;
  readonly runId: string;
  readonly logsR2Key: string | null;
}

/** A single job (repo-scoped via its run) with its steps + the logs R2 key. */
export async function getJobDetail(
  db: DbClient,
  repoId: string,
  jobId: string,
): Promise<JobWithSteps | null> {
  const row = await db.queryOne<RawJob & { run_id: string; logs_r2_key: string | null }>(
    `SELECT j.id, j.run_id, j.job_key, j.name, j.matrix, j.needs, j.status,
            j.conclusion, j.runner_name, j.started_at, j.completed_at, j.logs_r2_key
       FROM workflow_jobs j
       JOIN workflow_runs r ON r.id = j.run_id
      WHERE j.id = ? AND r.repo_id = ? LIMIT 1`,
    [jobId, repoId],
  );
  if (!row) return null;
  const steps = await db.query<RawStep>(
    `SELECT number, name, status, conclusion, exit_code, error_message,
            started_at, completed_at
       FROM workflow_steps WHERE job_id = ? ORDER BY number ASC`,
    [jobId],
  );
  return {
    job: jobDto(row, steps.map(stepDto)),
    runId: row.run_id,
    logsR2Key: row.logs_r2_key,
  };
}
