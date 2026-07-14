/**
 * Run-trigger orchestration — the shared PARSE→PLAN→PERSIST→PROJECT→DISPATCH path
 * used by both the push hook and the manual-dispatch route.
 *
 * Ties the pieces together: cache the workflow definition, create the run + jobs +
 * steps + projected check-runs, then hand the run to the dispatch seam. It never
 * executes anything — dispatch is Phase 5b (see `dispatch.ts`).
 */

import type { DbClient } from "../../db/index.ts";
import { dispatchWorkflowRun } from "./dispatch.ts";
import {
  createWorkflowRun,
  upsertWorkflow,
  workflowTriggerNames,
  type CreatedRun,
} from "./service.ts";
import type { Workflow } from "./engine/index.ts";

export interface RunTriggerInput {
  readonly repoId: string;
  /** `owner/name`. */
  readonly repoFullName: string;
  readonly workflowPath: string;
  readonly workflowName: string | null;
  readonly contentSha: string;
  readonly event: string;
  /** Full ref, e.g. `refs/heads/main`. */
  readonly ref: string;
  readonly sha: string;
  readonly actorId: string | null;
  readonly inputs?: Record<string, unknown> | null;
  readonly workflow: Workflow;
  readonly runNumber: number;
  readonly runAttempt?: number;
}

export interface TriggeredRun extends CreatedRun {
  readonly dispatched: boolean;
}

/**
 * Persist a run and hand it to the dispatch seam. Upserts the `workflows` cache
 * row, writes the run/jobs/steps/check-runs, then enqueues the run tick (a no-op
 * that leaves the run `queued` when the Actions Queue is unbound).
 */
export async function persistAndDispatchRun(
  db: DbClient,
  env: unknown,
  input: RunTriggerInput,
): Promise<TriggeredRun> {
  const workflowId = await upsertWorkflow(
    db,
    input.repoId,
    input.workflowPath,
    input.workflowName,
    workflowTriggerNames(input.workflow),
    input.contentSha,
  );
  const created = await createWorkflowRun(db, {
    repoId: input.repoId,
    repoFullName: input.repoFullName,
    workflowPath: input.workflowPath,
    workflowId,
    event: input.event,
    ref: input.ref,
    sha: input.sha,
    actorId: input.actorId,
    inputs: input.inputs ?? null,
    workflow: input.workflow,
    runNumber: input.runNumber,
    runAttempt: input.runAttempt,
  });
  const { dispatched } = await dispatchWorkflowRun(env, created.id, input.repoId);
  return { ...created, dispatched };
}
