/**
 * Wire contracts for the self-hosted Actions runner (Phase 5b).
 *
 * Three boundaries share these shapes:
 *  1. Coordinator DO → job-runner DO → Container: {@link ActionsJobDispatch}.
 *  2. Container → coordinator: {@link ActionsJobResult} (relayed by the job DO).
 *  3. Container → worker internal callback routes
 *     (`/internal/actions/{checkout,logs,artifacts}`): the request bodies below.
 *
 * These are takos-git-internal shapes (NOT a customer API and NOT GitHub
 * wire-compat). The step contract itself is the persisted
 * {@link StepExecContract} from the control plane (`../dto.ts`), unchanged.
 *
 * Framework-free: no `@cloudflare/workers-types`. Every binding surface is a
 * narrow local interface, mirroring `src/git/types.ts` and `src/db/client.ts`.
 */

import type { RunConclusion, StepExecContract } from "../dto.ts";

/** Discriminator baked into every dispatch body (versioned). */
export const ACTIONS_JOB_KIND = "takos-git.actions-job@v1" as const;

/** One repo secret decrypted just-in-time for injection (never logged). */
export interface DispatchSecret {
  readonly name: string;
  readonly value: string;
}

/** The immutable checkout coordinate a job runs against. */
export interface DispatchCheckout {
  /** 40-hex pinned commit SHA (authoritative in R2). */
  readonly commit: string;
  /** The internal run-pin ref, `refs/takos-actions/<runId>`. */
  readonly ref: string;
}

/** One step to execute, addressed by its persisted `workflow_steps` row id. */
export interface DispatchStep {
  /** `workflow_steps.id` — the step-status callback target. */
  readonly stepId: string;
  /** 1-based ordinal within the job. */
  readonly number: number;
  /** The persisted, self-contained per-step contract (env already merged). */
  readonly contract: StepExecContract;
}

/**
 * The body the coordinator assembles and the container consumes. Mirrors the
 * shape documented on the 5a dispatch seam (`../dispatch.ts`).
 */
export interface ActionsJobDispatch {
  readonly kind: typeof ACTIONS_JOB_KIND;
  readonly runId: string;
  readonly jobId: string;
  readonly repoId: string;
  /** `owner/name` R2 storage key — the checkout route target. */
  readonly repo: string;
  readonly attempt: number;
  readonly checkout: DispatchCheckout;
  readonly job: { readonly matrix: Record<string, unknown> | null };
  /** Repo secrets, injected as process env for `run:` steps only. */
  readonly secrets: readonly DispatchSecret[];
  readonly steps: readonly DispatchStep[];
  /** Per-job wall-clock ceiling (ms). The container enforces it and self-times-out. */
  readonly timeoutMs: number;
  /** Base URL the container calls back on for checkout/logs/artifacts. */
  readonly callbackBaseUrl: string;
  /** Short-lived HMAC bearer authorizing this run's internal callbacks. */
  readonly callbackToken: string;
}

/** Per-step outcome the container reports back. */
export interface StepResultReport {
  readonly stepId: string;
  readonly number: number;
  readonly conclusion: RunConclusion;
  readonly exitCode: number | null;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly errorMessage?: string | null;
}

/** The terminal job outcome the container returns / the job DO relays. */
export interface ActionsJobResult {
  readonly runId: string;
  readonly jobId: string;
  readonly conclusion: RunConclusion;
  readonly steps: readonly StepResultReport[];
  /** R2 key of the sealed job log, when the container uploaded one. */
  readonly logsR2Key: string | null;
}

// ── Internal callback route bodies (container → worker) ─────────────────────

/** `POST /internal/actions/logs` — append a log chunk for a job/step. */
export interface LogAppendRequest {
  readonly runId: string;
  readonly jobId: string;
  readonly stepId?: string;
  /** Already secret-redacted UTF-8 text. */
  readonly chunk: string;
}

/** `POST /internal/actions/artifacts` — register + store one uploaded artifact. */
export interface ArtifactUploadMeta {
  readonly runId: string;
  readonly jobId: string;
  readonly name: string;
  readonly contentType?: string;
}

/** Step-status callback the container fires as it progresses. */
export interface StepStatusRequest {
  readonly runId: string;
  readonly jobId: string;
  readonly stepId: string;
  readonly status: "in_progress" | "completed";
  readonly conclusion?: RunConclusion | null;
  readonly exitCode?: number | null;
}

/** The tick the queue consumer forwards to the coordinator DO. */
export interface RunTick {
  readonly runId: string;
  readonly repoId: string;
}
