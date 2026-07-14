/**
 * DTO + vocabulary for the Actions feature (workflows / runs / jobs / steps /
 * secrets / artifacts).
 *
 * These are the versioned `/api/v1` shapes the SPA and automation read. They are a
 * takos-git surface, NOT GitHub Actions wire-compat, though the vocabulary mirrors
 * GitHub Actions so CI-shaped clients map cleanly.
 *
 * The `StepExecContract` is the load-bearing shape: it is stored verbatim on
 * `workflow_steps.exec_contract` and is the exact interface the Phase-5b container
 * runner consumes. It preserves the legacy Takos `RUNTIME_HOST` step message field
 * set (`{ run, uses, with, env, name, shell, working-directory,
 * continue-on-error, timeout-minutes }`) so the runner is unchanged above the
 * dispatch seam.
 */

// --- run / job / step lifecycle ---------------------------------------------

/** Lifecycle of a run / job (mirrors `workflow_runs.status` / `workflow_jobs.status`). */
export type RunStatus = "queued" | "in_progress" | "completed";

/** Terminal verdict of a completed run / job (engine `Conclusion` + `timed_out`). */
export type RunConclusion =
  | "success"
  | "failure"
  | "cancelled"
  | "skipped"
  | "timed_out";

export const RUN_STATUSES: ReadonlySet<string> = new Set<RunStatus>([
  "queued",
  "in_progress",
  "completed",
]);

export const RUN_CONCLUSIONS: ReadonlySet<string> = new Set<RunConclusion>([
  "success",
  "failure",
  "cancelled",
  "skipped",
  "timed_out",
]);

/** Lifecycle of a step (mirrors `workflow_steps.status`). */
export type StepStatus = "pending" | "in_progress" | "completed";

/**
 * The per-step execution contract stored on `workflow_steps.exec_contract` and
 * dispatched to the Phase-5b runner. Field names match the GitHub Actions /
 * legacy `RUNTIME_HOST` step message verbatim (kebab-case keys preserved).
 *
 * `env` is the fully-merged, self-contained process environment for the step:
 * workflow env, then job env, then step env, with the GitHub-shaped run context
 * (`GITHUB_SHA`, `GITHUB_REF`, `CI`, …) layered on top so the runner needs no
 * additional lookup. Secrets are NEVER included here (injected at run time by the
 * runner from `workflow_secrets`).
 */
export interface StepExecContract {
  readonly run: string | null;
  readonly uses: string | null;
  readonly with: Record<string, unknown> | null;
  readonly env: Record<string, string>;
  readonly name: string;
  readonly shell: string | null;
  readonly "working-directory": string | null;
  readonly "continue-on-error": boolean;
  readonly "timeout-minutes": number | null;
}

// --- read-model DTOs --------------------------------------------------------

export interface ActorDto {
  readonly id: string;
  readonly subject: string;
  readonly displayName: string | null;
  readonly avatarUrl: string | null;
}

export interface WorkflowRunDto {
  readonly id: string;
  readonly workflowPath: string;
  readonly workflowId: string | null;
  readonly event: string;
  readonly ref: string | null;
  readonly sha: string | null;
  readonly status: RunStatus;
  readonly conclusion: RunConclusion | null;
  readonly runNumber: number;
  readonly runAttempt: number;
  readonly actor: ActorDto | null;
  readonly queuedAt: number | null;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly createdAt: number;
}

export interface WorkflowStepDto {
  readonly number: number;
  readonly name: string;
  readonly status: StepStatus;
  readonly conclusion: RunConclusion | null;
  readonly exitCode: number | null;
  readonly errorMessage: string | null;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
}

export interface WorkflowJobDto {
  readonly id: string;
  readonly jobKey: string | null;
  readonly name: string;
  readonly matrix: Record<string, unknown> | null;
  readonly needs: readonly string[];
  readonly status: RunStatus;
  readonly conclusion: RunConclusion | null;
  readonly runnerName: string | null;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly steps?: readonly WorkflowStepDto[];
}

export interface WorkflowSecretDto {
  readonly name: string;
  readonly createdAt: number;
  readonly updatedAt: number | null;
}

export interface WorkflowArtifactDto {
  readonly id: string;
  readonly name: string;
  readonly sizeBytes: number | null;
  readonly contentType: string | null;
  readonly expiresAt: number | null;
  readonly createdAt: number;
}

export interface WorkflowDto {
  readonly id: string | null;
  readonly path: string;
  readonly name: string | null;
  readonly triggers: readonly string[];
  readonly state: string;
  readonly parsedAt: number | null;
  readonly updatedAt: number | null;
}

/** Map a job/step engine conclusion to the checks-feature check-run conclusion. */
export function toCheckConclusion(conclusion: RunConclusion): string {
  // check_runs conclusion vocabulary is a superset; every RunConclusion is valid.
  return conclusion;
}

/** Map a run/job conclusion to a combined commit-status state. */
export function toCommitStatusState(
  conclusion: RunConclusion,
): "success" | "failure" {
  return conclusion === "success" || conclusion === "skipped"
    ? "success"
    : "failure";
}
