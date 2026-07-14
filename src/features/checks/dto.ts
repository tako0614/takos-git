/**
 * DTO + vocabulary for the checks feature (check runs + commit statuses).
 *
 * These are the versioned `/api/v1` shapes the SPA and automation read. They are a
 * takos-git surface, NOT GitHub REST wire-compat, though the vocabulary mirrors
 * GitHub's checks/statuses model so CI producers map cleanly.
 *
 * The exported query helpers `listCheckRuns` / `combinedStatus` (in `service.ts`)
 * return the row-shaped types below so the pulls merge-gate can evaluate required
 * checks without re-deriving anything.
 */

// --- check runs -------------------------------------------------------------

/** Lifecycle of a check run (mirrors `check_runs.status`). */
export type CheckRunStatus = "queued" | "in_progress" | "completed";

/** Terminal verdict of a completed check run (mirrors `check_runs.conclusion`). */
export type CheckRunConclusion =
  | "success"
  | "failure"
  | "neutral"
  | "cancelled"
  | "timed_out"
  | "action_required"
  | "skipped";

export const CHECK_RUN_STATUSES: ReadonlySet<string> = new Set<CheckRunStatus>([
  "queued",
  "in_progress",
  "completed",
]);

export const CHECK_RUN_CONCLUSIONS: ReadonlySet<string> =
  new Set<CheckRunConclusion>([
    "success",
    "failure",
    "neutral",
    "cancelled",
    "timed_out",
    "action_required",
    "skipped",
  ]);

export interface CheckRunOutput {
  readonly title: string | null;
  readonly summary: string | null;
  /** Long-form text; spilled to R2 (`check_runs.output_r2_key`) when present. */
  readonly text?: string | null;
}

/** Row-shaped projection returned by `getCheckRun` / `listCheckRuns`. */
export interface CheckRunRow {
  readonly id: string;
  readonly repoId: string;
  readonly headSha: string;
  readonly name: string;
  readonly status: CheckRunStatus;
  readonly conclusion: CheckRunConclusion | null;
  readonly detailsUrl: string | null;
  readonly externalId: string | null;
  readonly workflowRunId: string | null;
  readonly output: CheckRunOutput | null;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

// --- commit statuses --------------------------------------------------------

/** State of a commit status (mirrors `commit_statuses.state`). */
export type CommitStatusState = "pending" | "success" | "failure" | "error";

export const COMMIT_STATUS_STATES: ReadonlySet<string> =
  new Set<CommitStatusState>(["pending", "success", "failure", "error"]);

/** The rolled-up combined state over the latest status per context. */
export type CombinedStatusState = "pending" | "success" | "failure";

export interface CommitStatusRow {
  readonly id: string;
  readonly repoId: string;
  readonly sha: string;
  readonly context: string;
  readonly state: CommitStatusState;
  readonly description: string | null;
  readonly targetUrl: string | null;
  readonly creatorId: string | null;
  readonly createdAt: number;
}

export interface CombinedStatus {
  readonly sha: string;
  readonly state: CombinedStatusState;
  /** Latest status per context, most-recent first. */
  readonly statuses: readonly CommitStatusRow[];
  readonly totalCount: number;
}
