/**
 * Run-plan expansion — turn a parsed `Workflow` into the concrete job + step rows
 * that get persisted (and, in Phase 5b, executed).
 *
 * Pure over the engine model. Matrix strategies expand into one job row per
 * combination (`buildExpandedJobs`), and every step is lowered to a
 * {@link StepExecContract} — the exact `RUNTIME_HOST` field set the Phase-5b
 * runner consumes. Job-level, workflow-level, and GitHub-context env are folded
 * into each step's `env` (step wins, then the authoritative `GITHUB_*` context) so
 * the persisted step row is fully self-contained for the runner.
 *
 * Ported from the Takos worker (`actions-execution.createWorkflowJobs` +
 * `actions-env.buildWorkflowDispatchEnv`), severed from Drizzle/queue coupling.
 */

import type {
  Job,
  MatrixContext,
  Step,
  Workflow,
} from "./engine/index.ts";
import {
  buildExpandedJobs,
  normalizeNeedsInput,
} from "./engine/scheduler/job-expansion.ts";
import type { StepExecContract } from "./dto.ts";

export interface ExpandedStep {
  readonly number: number;
  readonly name: string;
  readonly contract: StepExecContract;
}

export interface ExpandedRunJob {
  /** The YAML job key (base id); matrix expansions share it (needs target). */
  readonly jobKey: string;
  /** Display name; a matrix expansion appends its combination. */
  readonly name: string;
  /** Resolved matrix cell, or null for a non-matrix job. */
  readonly matrix: MatrixContext | null;
  /** Prerequisite job keys (base ids), from `needs`. */
  readonly needs: string[];
  readonly steps: ExpandedStep[];
}

export interface RunContext {
  readonly workflowPath: string;
  /** `owner/name`. */
  readonly repoFullName: string;
  readonly runId: string;
  readonly ref: string;
  readonly sha: string;
}

/**
 * The GitHub-shaped run context env for a job (mirrors the legacy
 * `buildWorkflowDispatchEnv`). These values are authoritative and layered on top
 * of user env so a workflow cannot clobber `GITHUB_SHA` etc.
 */
function contextEnv(
  workflow: Workflow,
  ctx: RunContext,
  jobDisplayName: string,
): Record<string, string> {
  const normalizedRef = ctx.ref.startsWith("refs/")
    ? ctx.ref
    : `refs/heads/${ctx.ref}`;
  return {
    CI: "true",
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: ctx.repoFullName,
    GITHUB_REF: normalizedRef,
    GITHUB_SHA: ctx.sha,
    GITHUB_JOB: jobDisplayName,
    GITHUB_RUN_ID: ctx.runId,
    GITHUB_WORKFLOW: workflow.name ?? ctx.workflowPath,
  };
}

/** Resolve a step's shell from step → job.defaults → workflow.defaults. */
function resolveShell(
  step: Step,
  job: Job,
  workflow: Workflow,
): string | null {
  return (
    step.shell ??
    job.defaults?.run?.shell ??
    workflow.defaults?.run?.shell ??
    null
  );
}

/** Resolve a step's working directory from step → job.defaults → workflow.defaults. */
function resolveWorkingDirectory(
  step: Step,
  job: Job,
  workflow: Workflow,
): string | null {
  return (
    step["working-directory"] ??
    job.defaults?.run?.["working-directory"] ??
    workflow.defaults?.run?.["working-directory"] ??
    null
  );
}

function matrixSuffix(matrix: MatrixContext | undefined): string {
  if (!matrix) return "";
  const parts = Object.keys(matrix)
    .sort()
    .map((key) => `${key}: ${String(matrix[key])}`);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

function stepName(step: Step, index: number): string {
  return step.name || step.uses || step.run?.slice(0, 60) || `Step ${index + 1}`;
}

/**
 * Expand a workflow into its concrete job rows + per-step exec contracts, ordered
 * by the engine's expansion. Matrix jobs become multiple rows sharing `jobKey`.
 */
export function expandRunJobs(
  workflow: Workflow,
  ctx: RunContext,
): ExpandedRunJob[] {
  const workflowEnv = workflow.env ?? {};
  const { jobs } = buildExpandedJobs(workflow);
  const result: ExpandedRunJob[] = [];

  for (const expanded of jobs.values()) {
    const job = expanded.job;
    const baseName = job.name || expanded.baseId;
    const displayName = `${baseName}${matrixSuffix(expanded.matrix)}`;
    const jobEnv = job.env ?? {};
    const context = contextEnv(workflow, ctx, displayName);
    const needs = normalizeNeedsInput(job.needs);

    const steps: ExpandedStep[] = job.steps.map((step, index) => {
      // Precedence: workflow < job < step, then the authoritative GITHUB_* context.
      const env: Record<string, string> = {
        ...workflowEnv,
        ...jobEnv,
        ...(step.env ?? {}),
        ...context,
      };
      const contract: StepExecContract = {
        run: step.run ?? null,
        uses: step.uses ?? null,
        with: step.with ?? null,
        env,
        name: stepName(step, index),
        shell: resolveShell(step, job, workflow),
        "working-directory": resolveWorkingDirectory(step, job, workflow),
        "continue-on-error": step["continue-on-error"] ?? false,
        "timeout-minutes": step["timeout-minutes"] ?? null,
      };
      return { number: index + 1, name: contract.name, contract };
    });

    result.push({
      jobKey: expanded.baseId,
      name: displayName,
      matrix: expanded.matrix ?? null,
      needs,
      steps,
    });
  }

  return result;
}
