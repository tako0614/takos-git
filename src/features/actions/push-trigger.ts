/**
 * Push → workflow discovery hook.
 *
 * Invoked (best-effort, non-blocking) from the receive-pack success path after
 * refs advance. For every updated branch ref it discovers `.github/workflows`
 * files at the new commit, evaluates each workflow's `push` branch/path filters,
 * and creates a queued run per matching workflow.
 *
 * INVARIANTS honored here:
 *  - D1-guarded: does nothing when the metadata plane is unconfigured, so the
 *    clone/push path (and its E2E) is unaffected when Actions is off.
 *  - Best-effort: every failure is swallowed; a discovery error must never break
 *    a push that already committed its refs to R2.
 *  - R2 authoritative: reads git objects only through the repo-scoped object
 *    store; creates no git objects.
 */

import { createDbClient, type D1Binding } from "../../db/index.ts";
import { repositoryObjectStore } from "../../git/repo-object-store.ts";
import type { ObjectStoreBinding } from "../../git/types.ts";
import {
  computeChangedFiles,
  discoverWorkflows,
} from "./discovery.ts";
import { matchesPushTrigger } from "./triggers.ts";
import { allocateRunNumber } from "./service.ts";
import { persistAndDispatchRun } from "./orchestrator.ts";

const ZERO_OID = "0".repeat(40);
const BRANCH_PREFIX = "refs/heads/";

/** One applied ref update from a successful receive-pack (smart-http contract). */
export interface AppliedRefUpdate {
  readonly name: string;
  readonly oldSha: string;
  readonly newSha: string;
}

interface PushEnv {
  readonly DB?: D1Binding;
  readonly BUCKET: ObjectStoreBinding;
}

/**
 * Discover + trigger push workflows for the branch refs a receive-pack advanced.
 * `repoStorageKey` is the `<owner>/<name>` segment used for both R2 and the
 * `repositories.storage_key` lookup.
 */
export async function onPushDiscoverWorkflows(
  env: PushEnv,
  repoStorageKey: string,
  updates: readonly AppliedRefUpdate[],
): Promise<void> {
  if (!env.DB) return; // metadata plane not configured — no-op, push path intact.
  try {
    const branchUpdates = updates.filter(
      (update) =>
        update.name.startsWith(BRANCH_PREFIX) && update.newSha !== ZERO_OID,
    );
    if (branchUpdates.length === 0) return;

    const db = createDbClient(env.DB);
    const repo = await db.queryOne<{ id: string }>(
      `SELECT id FROM repositories WHERE storage_key = ? LIMIT 1`,
      [repoStorageKey],
    );
    if (!repo) return; // repo not tracked in D1 — nothing to project onto.

    const objects = repositoryObjectStore(env.BUCKET, repoStorageKey);

    for (const update of branchUpdates) {
      await triggerForBranch(db, env, objects, repo.id, repoStorageKey, update);
    }
  } catch {
    // Best-effort: never let discovery disturb a committed push.
  }
}

async function triggerForBranch(
  db: ReturnType<typeof createDbClient>,
  env: unknown,
  objects: ObjectStoreBinding,
  repoId: string,
  repoStorageKey: string,
  update: AppliedRefUpdate,
): Promise<void> {
  const branch = update.name.slice(BRANCH_PREFIX.length);
  const beforeSha = update.oldSha === ZERO_OID ? null : update.oldSha;
  const candidates = await discoverWorkflows(objects, update.newSha);
  if (candidates.length === 0) return;

  const changedFiles = await computeChangedFiles(objects, update.newSha, beforeSha);
  for (const candidate of candidates) {
    if (!matchesPushTrigger(candidate.workflow, branch, changedFiles)) continue;
    const runNumber = await allocateRunNumber(db, repoId, candidate.path);
    await persistAndDispatchRun(db, env, {
      repoId,
      repoFullName: repoStorageKey,
      workflowPath: candidate.path,
      workflowName: candidate.name,
      contentSha: candidate.contentSha,
      event: "push",
      ref: `${BRANCH_PREFIX}${branch}`,
      sha: update.newSha,
      actorId: null,
      workflow: candidate.workflow,
      runNumber,
    });
  }
}
