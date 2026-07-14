/**
 * Narrow view of the worker Env for the Actions feature.
 *
 * The frozen router `RouterEnv` (src/router.ts) is not edited by feature code; the
 * Actions bindings (all optional, present only when the operator sets
 * `enable_actions` in main.tf) are read structurally from `ctx.env` through this
 * interface — the same decoupling the webhooks + event-bridge features use. Every
 * field is optional so the control plane degrades cleanly when Actions is off.
 */

import type { ObjectStoreBinding } from "../../git/types.ts";

/** The queue message the run-level dispatch seam enqueues (main.tf binding shape). */
export interface WorkflowQueueMessage {
  readonly runId: string;
  readonly repoId: string;
}

/** Minimal producer surface of a Cloudflare Queue binding. */
export interface QueueBinding<T = WorkflowQueueMessage> {
  send(message: T): Promise<void>;
}

/** Actions bindings, mirrored from main.tf (`local.actions_enabled` block). */
export interface ActionsEnv {
  /** Run-tick queue → Phase-5b coordinator DO. Absent ⇒ runs stay `queued`. */
  readonly WORKFLOW_QUEUE?: QueueBinding;
  /** Logs (`logs/…`) + artifacts (`artifacts/…`) bucket, distinct from git BUCKET. */
  readonly R2_ACTIONS?: ObjectStoreBinding;
  /** AES key material for Actions secret encryption at rest. */
  readonly ACTIONS_SECRETS_KEY?: string;
  /** HMAC key for the run-scoped /internal/actions/* routes (Phase 5b). */
  readonly ACTIONS_RUNNER_SECRET?: string;
  /** Fallback secret-encryption key material when ACTIONS_SECRETS_KEY is unset. */
  readonly APP_SESSION_SECRET?: string;
}

/** Read the Actions bindings off any worker env without touching RouterEnv. */
export function actionsEnv(env: unknown): ActionsEnv {
  return (env ?? {}) as ActionsEnv;
}

/**
 * Key material used to seal Actions secrets. A dedicated `ACTIONS_SECRETS_KEY` is
 * preferred; `APP_SESSION_SECRET` is the fallback so a single-secret deploy still
 * gets at-rest encryption. Returns null when neither is configured (callers then
 * reject secret storage, fail-closed).
 */
export function actionsSecretKey(env: unknown): string | null {
  const bag = actionsEnv(env);
  if (
    typeof bag.ACTIONS_SECRETS_KEY === "string" &&
    bag.ACTIONS_SECRETS_KEY.trim().length > 0
  ) {
    return bag.ACTIONS_SECRETS_KEY;
  }
  if (
    typeof bag.APP_SESSION_SECRET === "string" &&
    bag.APP_SESSION_SECRET.trim().length > 0
  ) {
    return bag.APP_SESSION_SECRET;
  }
  return null;
}
