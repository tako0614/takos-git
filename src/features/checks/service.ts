/**
 * D1 service for check runs and commit statuses.
 *
 * D1 holds relational METADATA only. `check_runs.head_sha` and `commit_statuses.sha`
 * are advisory projections of R2-authoritative commits; the caller (http.ts)
 * validates the SHA against R2 before any write. This module never touches R2.
 *
 * `listCheckRuns` and `combinedStatus` are the two exported query helpers the
 * pulls merge-gate reads to evaluate required checks — they return the row-shaped
 * DTOs so the gate does not re-derive anything.
 */

import type { DbClient } from "../../db/index.ts";
import {
  type CheckRunConclusion,
  type CheckRunRow,
  type CheckRunStatus,
  type CombinedStatus,
  type CombinedStatusState,
  type CommitStatusRow,
  type CommitStatusState,
} from "./dto.ts";

// --- internal row shapes ----------------------------------------------------

/** Full projection including the R2 spill key (http.ts hydrates text on read). */
export interface CheckRunRecord extends CheckRunRow {
  readonly outputR2Key: string | null;
}

interface RawCheckRun {
  id: string;
  repo_id: string;
  head_sha: string;
  name: string;
  workflow_run_id: string | null;
  external_id: string | null;
  status: string;
  conclusion: string | null;
  details_url: string | null;
  output_title: string | null;
  output_summary: string | null;
  output_r2_key: string | null;
  started_at: number | null;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
}

interface RawCommitStatus {
  id: string;
  repo_id: string;
  sha: string;
  context: string;
  state: string;
  description: string | null;
  target_url: string | null;
  creator_id: string | null;
  created_at: number;
}

function mapCheckRun(row: RawCheckRun): CheckRunRecord {
  const hasOutput =
    row.output_title !== null ||
    row.output_summary !== null ||
    row.output_r2_key !== null;
  return {
    id: row.id,
    repoId: row.repo_id,
    headSha: row.head_sha,
    name: row.name,
    status: row.status as CheckRunStatus,
    conclusion: (row.conclusion as CheckRunConclusion | null) ?? null,
    detailsUrl: row.details_url,
    externalId: row.external_id,
    workflowRunId: row.workflow_run_id,
    output: hasOutput
      ? { title: row.output_title, summary: row.output_summary }
      : null,
    outputR2Key: row.output_r2_key,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCommitStatus(row: RawCommitStatus): CommitStatusRow {
  return {
    id: row.id,
    repoId: row.repo_id,
    sha: row.sha,
    context: row.context,
    state: row.state as CommitStatusState,
    description: row.description,
    targetUrl: row.target_url,
    creatorId: row.creator_id,
    createdAt: row.created_at,
  };
}

const CHECK_RUN_COLUMNS = `id, repo_id, head_sha, name, workflow_run_id, external_id,
  status, conclusion, details_url, output_title, output_summary, output_r2_key,
  started_at, completed_at, created_at, updated_at`;

// --- check runs -------------------------------------------------------------

export interface CreateCheckRunInput {
  readonly headSha: string;
  readonly name: string;
  readonly status: CheckRunStatus;
  readonly conclusion?: CheckRunConclusion | null;
  readonly detailsUrl?: string | null;
  readonly externalId?: string | null;
  readonly workflowRunId?: string | null;
  readonly outputTitle?: string | null;
  readonly outputSummary?: string | null;
  readonly outputR2Key?: string | null;
  readonly startedAt?: number | null;
  readonly completedAt?: number | null;
}

export async function createCheckRun(
  db: DbClient,
  repoId: string,
  input: CreateCheckRunInput,
): Promise<CheckRunRecord> {
  const id = db.id();
  const now = db.now();
  await db.run(
    `INSERT INTO check_runs
       (id, repo_id, head_sha, name, workflow_run_id, external_id, status,
        conclusion, details_url, output_title, output_summary, output_r2_key,
        started_at, completed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      repoId,
      input.headSha,
      input.name,
      input.workflowRunId ?? null,
      input.externalId ?? null,
      input.status,
      input.conclusion ?? null,
      input.detailsUrl ?? null,
      input.outputTitle ?? null,
      input.outputSummary ?? null,
      input.outputR2Key ?? null,
      input.startedAt ?? null,
      input.completedAt ?? null,
      now,
      now,
    ],
  );
  const created = await getCheckRun(db, repoId, id);
  if (!created) throw new Error("check run vanished after insert");
  return created;
}

export interface UpdateCheckRunPatch {
  readonly name?: string;
  readonly status?: CheckRunStatus;
  readonly conclusion?: CheckRunConclusion | null;
  readonly detailsUrl?: string | null;
  readonly externalId?: string | null;
  readonly outputTitle?: string | null;
  readonly outputSummary?: string | null;
  readonly outputR2Key?: string | null;
  readonly startedAt?: number | null;
  readonly completedAt?: number | null;
}

export async function updateCheckRun(
  db: DbClient,
  repoId: string,
  id: string,
  patch: UpdateCheckRunPatch,
): Promise<CheckRunRecord | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (col: string, value: unknown): void => {
    sets.push(`${col} = ?`);
    params.push(value);
  };
  if (patch.name !== undefined) push("name", patch.name);
  if (patch.status !== undefined) push("status", patch.status);
  if (patch.conclusion !== undefined) push("conclusion", patch.conclusion);
  if (patch.detailsUrl !== undefined) push("details_url", patch.detailsUrl);
  if (patch.externalId !== undefined) push("external_id", patch.externalId);
  if (patch.outputTitle !== undefined) push("output_title", patch.outputTitle);
  if (patch.outputSummary !== undefined)
    push("output_summary", patch.outputSummary);
  if (patch.outputR2Key !== undefined) push("output_r2_key", patch.outputR2Key);
  if (patch.startedAt !== undefined) push("started_at", patch.startedAt);
  if (patch.completedAt !== undefined) push("completed_at", patch.completedAt);

  // updated_at always advances on a touch.
  push("updated_at", db.now());
  params.push(repoId, id);
  const result = await db.run(
    `UPDATE check_runs SET ${sets.join(", ")} WHERE repo_id = ? AND id = ?`,
    params,
  );
  if (!result.meta.changes) return null;
  return getCheckRun(db, repoId, id);
}

export async function getCheckRun(
  db: DbClient,
  repoId: string,
  id: string,
): Promise<CheckRunRecord | null> {
  const row = await db.queryOne<RawCheckRun>(
    `SELECT ${CHECK_RUN_COLUMNS} FROM check_runs WHERE repo_id = ? AND id = ?`,
    [repoId, id],
  );
  return row ? mapCheckRun(row) : null;
}

/**
 * Every check run posted against `headSha`, newest first. Exported for the pulls
 * merge-gate (required-check evaluation reads name + status + conclusion).
 */
export async function listCheckRuns(
  db: DbClient,
  repoId: string,
  headSha: string,
): Promise<CheckRunRecord[]> {
  const rows = await db.query<RawCheckRun>(
    `SELECT ${CHECK_RUN_COLUMNS} FROM check_runs
     WHERE repo_id = ? AND head_sha = ?
     ORDER BY created_at DESC, rowid DESC`,
    [repoId, headSha],
  );
  return rows.map(mapCheckRun);
}

// --- commit statuses --------------------------------------------------------

export interface CreateCommitStatusInput {
  readonly sha: string;
  readonly context: string;
  readonly state: CommitStatusState;
  readonly description?: string | null;
  readonly targetUrl?: string | null;
  readonly creatorId?: string | null;
}

export async function createCommitStatus(
  db: DbClient,
  repoId: string,
  input: CreateCommitStatusInput,
): Promise<CommitStatusRow> {
  const id = db.id();
  const now = db.now();
  await db.run(
    `INSERT INTO commit_statuses
       (id, repo_id, sha, context, state, description, target_url, creator_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      repoId,
      input.sha,
      input.context,
      input.state,
      input.description ?? null,
      input.targetUrl ?? null,
      input.creatorId ?? null,
      now,
    ],
  );
  return {
    id,
    repoId,
    sha: input.sha,
    context: input.context,
    state: input.state,
    description: input.description ?? null,
    targetUrl: input.targetUrl ?? null,
    creatorId: input.creatorId ?? null,
    createdAt: now,
  };
}

/** All status posts for a sha (full history), newest first. */
export async function listCommitStatuses(
  db: DbClient,
  repoId: string,
  sha: string,
): Promise<CommitStatusRow[]> {
  const rows = await db.query<RawCommitStatus>(
    `SELECT id, repo_id, sha, context, state, description, target_url, creator_id, created_at
     FROM commit_statuses
     WHERE repo_id = ? AND sha = ?
     ORDER BY created_at DESC, rowid DESC`,
    [repoId, sha],
  );
  return rows.map(mapCommitStatus);
}

/** Reduce a status history to the LATEST post per context (newest-first input). */
function latestPerContext(
  statuses: readonly CommitStatusRow[],
): CommitStatusRow[] {
  const seen = new Set<string>();
  const latest: CommitStatusRow[] = [];
  for (const status of statuses) {
    if (seen.has(status.context)) continue;
    seen.add(status.context);
    latest.push(status);
  }
  return latest;
}

/** Precedence for the combined rollup: failure/error dominates pending dominates success. */
function rollup(latest: readonly CommitStatusRow[]): CombinedStatusState {
  let sawSuccess = false;
  let sawPending = false;
  for (const status of latest) {
    if (status.state === "failure" || status.state === "error") return "failure";
    if (status.state === "pending") sawPending = true;
    if (status.state === "success") sawSuccess = true;
  }
  if (sawPending) return "pending";
  if (sawSuccess) return "success";
  // No statuses at all → nothing has reported yet → pending (GitHub parity).
  return "pending";
}

/**
 * Combined commit-status rollup for a sha: the LATEST state per context reduced to
 * a single {@link CombinedStatusState}. Exported for the pulls merge-gate.
 */
export async function combinedStatus(
  db: DbClient,
  repoId: string,
  sha: string,
): Promise<CombinedStatus> {
  const history = await listCommitStatuses(db, repoId, sha);
  const latest = latestPerContext(history);
  return {
    sha,
    state: rollup(latest),
    statuses: latest,
    totalCount: latest.length,
  };
}
