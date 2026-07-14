/**
 * Self-hosted Actions runner (Phase 5b) — public surface.
 *
 * The execution fabric that consumes the 5a dispatch seam: a queue consumer, the
 * run-coordinator Durable Object, the per-job Container Durable Object, and the
 * HMAC-guarded `/internal/actions/*` callback routes. The in-container step
 * executor lives under `containers/runner/src/` (it is the image's program, not
 * part of the worker bundle).
 *
 * `worker.ts` re-exports the two DO classes so the `main.tf` migration
 * (`new_sqlite_classes = ["ActionsRunCoordinator", "ActionsJobRunner"]`) resolves,
 * wires `handleWorkflowQueue` into `queue()`, and dispatches
 * `handleInternalActionsRoute` before the router.
 */

export { ActionsRunCoordinator, type CoordinatorEnv } from "./coordinator-do.ts";
export { ActionsJobRunner, type JobRunnerEnv } from "./job-runner-do.ts";
export {
  handleWorkflowQueue,
  type MessageBatch,
  type QueueEnv,
  type QueueMessage,
} from "./queue-consumer.ts";
export { handleInternalActionsRoute } from "./internal-routes.ts";

// Reusable core (also consumed by tests + the in-container executor).
export {
  RunCoordinator,
  computeKeyStates,
  evaluateNeeds,
  parseNeeds,
  type CoordinatorDeps,
  type CoordinatorStorage,
  type NeedsDecision,
} from "./coordinator.ts";
export { DEFAULT_RUNNER_POLICY, type RunnerPolicy } from "./policy.ts";
export {
  ACTIONS_JOB_KIND,
  type ActionsJobDispatch,
  type ActionsJobResult,
  type RunTick,
} from "./contract.ts";
export { mintRunnerToken, verifyRunnerToken } from "./hmac.ts";
