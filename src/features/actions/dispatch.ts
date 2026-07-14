/**
 * Runner dispatch SEAM (Phase-5a → Phase-5b boundary).
 *
 * Phase 5a is the control plane: it PARSES → PLANS → PERSISTS a run (rows +
 * projected check-runs) and then hands the run to this seam. Phase 5b builds the
 * execution fabric (a coordinator Durable Object + a Cloudflare-Container Durable
 * Object) that consumes the queue message this seam enqueues.
 *
 * This module deliberately does NOT execute anything. It only enqueues a run tick
 * onto the Actions Queue (`WORKFLOW_QUEUE`, provisioned in `main.tf` behind
 * `enable_actions`). When the queue binding is absent, the run stays `queued` with
 * no execution — the exact graceful-degrade the roadmap requires.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT PHASE 5b MUST IMPLEMENT AGAINST THIS SEAM
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. QUEUE CONSUMER. Add a `queue()` handler on the Worker. Each message is a
 *    {@link WorkflowQueueMessage} `{ runId, repoId }` (the exact binding shape in
 *    main.tf). The consumer forwards the tick to
 *    `ACTIONS_RUN.idFromName(runId)` — the coordinator DO.
 *
 * 2. COORDINATOR DO (`ActionsRunCoordinator`). Owns run-scoped serialized state:
 *    the `needs:` DAG gate, `concurrency:` groups, cancellation, per-job/step
 *    timeout alarms, and idempotent status projection. It reads the persisted rows
 *    this control plane wrote — `workflow_jobs` (job_key, name, matrix, needs) and
 *    `workflow_steps` (exec_contract) — and for each job whose `needs` are all
 *    satisfied, dispatches a job to a Container DO (`ActionsJobRunner`,
 *    `ACTIONS_JOB.idFromName(jobId)`) with the body below.
 *
 * 3. JOB DISPATCH BODY (DO → container). Assemble from the persisted rows +
 *    just-in-time secret decryption ({@link decryptWorkflowSecret}). Shape:
 *
 *    ```jsonc
 *    {
 *      "kind": "takos-git.actions-job@v1",
 *      "runId": "…", "jobId": "…", "attempt": 1,
 *      "checkout": { "commit": "<sha40>", "ref": "refs/takos-actions/<runId>" },
 *      "job": { "matrix": { … } | null },
 *      "secrets": [ { "name": "NPM_TOKEN", "value": "***" } ],   // never logged
 *      "steps": [ <StepExecContract>, … ]                       // workflow_steps.exec_contract, in order
 *    }
 *    ```
 *
 *    Each element of `steps` is a `StepExecContract` (dto.ts) — the persisted
 *    per-step contract `{ run, uses, with, env, name, shell, working-directory,
 *    continue-on-error, timeout-minutes }`, with `env` already merged (workflow →
 *    job → step → authoritative GITHUB_* context). The container runs the step
 *    loop in-workspace (steps share a filesystem); secrets are injected as process
 *    env for `run:` steps only, redacted from all logs.
 *
 * 4. STATUS / LOG / ARTIFACT CALLBACKS. As the run executes, the coordinator calls
 *    the exported state-machine functions in `service.ts` (all idempotent):
 *      - `startRun(db, repoId, runId)`         — run queued → in_progress
 *      - `startJob(db, repoId, jobId, name?)`  — job queued → in_progress (+ check_run in_progress)
 *      - `updateStep(db, stepId, patch)`       — per-step status/exitCode/logsR2Key
 *      - `completeJob(db, repoId, jobId, { conclusion, logsR2Key })`
 *                                              — job → completed (+ check_run + commit_status),
 *                                                then finalizes the run when all jobs are terminal
 *      - `cancelRun(db, repoId, runId)`        — cancellation / concurrency supersede
 *    Logs seal to `R2_ACTIONS` at `logs/<repoId>/<runId>/<jobId>.log` (set
 *    `workflow_jobs.logs_r2_key` / `workflow_steps.logs_r2_key`); artifacts to
 *    `artifacts/<repoId>/<runId>/<name>` with a `workflow_run_artifacts` row.
 *
 * 5. INTERNAL ROUTES. Add `/internal/actions/{checkout,logs,artifacts}` guarded by
 *    the run-scoped HMAC bearer (`ACTIONS_RUNNER_SECRET`) — never accepted on
 *    `/api/v1`, `/git/`, or `/mcp`. These are the container's callback surface.
 *
 * The control plane above this seam (discovery, expansion, persistence,
 * projection, the routes, the read model) is COMPLETE and does not change when 5b
 * lands: 5b only fills the execution fabric behind `dispatchWorkflowRun`.
 */

import { actionsEnv, type WorkflowQueueMessage } from "./env.ts";

export type { WorkflowQueueMessage } from "./env.ts";

export interface DispatchResult {
  /** True when a run tick was enqueued; false when the queue is not configured. */
  readonly dispatched: boolean;
}

/**
 * Enqueue a run tick onto the Actions Queue. No-op (returns `{ dispatched: false }`)
 * when `WORKFLOW_QUEUE` is unbound, leaving the run `queued`. Best-effort: a queue
 * send failure is swallowed so run creation (already committed) never fails.
 */
export async function dispatchWorkflowRun(
  env: unknown,
  runId: string,
  repoId: string,
): Promise<DispatchResult> {
  const queue = actionsEnv(env).WORKFLOW_QUEUE;
  if (!queue) return { dispatched: false };
  const message: WorkflowQueueMessage = { runId, repoId };
  try {
    await queue.send(message);
    return { dispatched: true };
  } catch {
    // The run row is already persisted as `queued`; a failed enqueue degrades to
    // "not executed", never to a lost/failed run.
    return { dispatched: false };
  }
}
