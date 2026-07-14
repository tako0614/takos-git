/**
 * Fork + upstream-sync service — the D1/R2 mechanics behind the `forks` feature.
 *
 * Ported from the takos worker's `application/services/source/fork.ts`
 * (`forkWithWorkflows` fork mechanics + `syncWithUpstream` fast-forward). The
 * `targetWorkspaceId` / `accountId` / `space_id` coupling and the D1-index
 * `gitStore` indirection are severed: a fork is a NEW `repositories` row under the
 * caller's own owner namespace, git objects are copied straight between the two
 * repo-scoped R2 prefixes, and every ref advance goes through the sanctioned
 * two-phase writer (R2 refs-doc ETag CAS is the atomic commit point).
 *
 * Invariants preserved from this repo's foundation:
 *  - R2 stays authoritative for git objects/refs; D1 rows are rebuildable
 *    projections (ref_index, repo_forks).
 *  - No ref is written outside `writeRefsWithMetadata`.
 *  - Provisioning reuses `provisionRepo` (R2-CAS-then-D1), so a fork's empty
 *    refs-doc is created atomically before objects land.
 */

import type { DbClient } from "../../db/index.ts";
import { findMergeBase, isAncestor } from "../../git/merge-base.ts";
import { getCommitData } from "../../git/object-store.ts";
import {
  deleteRepo,
  readRepoRefs,
  type RefRecord,
  type RefsDoc,
} from "../../git/refs-store.ts";
import { repositoryObjectStore } from "../../git/repo-object-store.ts";
import type { ObjectStoreBinding } from "../../git/types.ts";
import { writeRefsWithMetadata } from "../../git/two-phase.ts";
import type { RepositoryDto, Visibility } from "../../contract/v1.ts";
import {
  cloneUrlFor,
  provisionRepo,
  type RepoRow,
} from "../repos/index.ts";
import type { OwnerRow } from "../repos/index.ts";

// ============================================================================
// Row shapes
// ============================================================================

/** The subset of `repositories` (+ owner) rows this feature reads. */
export interface RepoFullRow {
  readonly id: string;
  readonly ownerId: string;
  readonly ownerLogin: string;
  readonly ownerType: "user" | "org";
  readonly ownerPrincipalId: string | null;
  readonly name: string;
  readonly storageKey: string;
  readonly description: string | null;
  readonly visibility: Visibility;
  readonly defaultBranch: string;
  readonly forkOfId: string | null;
  readonly isArchived: boolean;
  readonly isTemplate: boolean;
  readonly pushedAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface RawRepoFullRow {
  id: string;
  owner_id: string;
  owner_login: string;
  owner_type: string;
  owner_principal_id: string | null;
  name: string;
  storage_key: string;
  description: string | null;
  visibility: string;
  default_branch: string;
  fork_of_id: string | null;
  is_archived: number;
  is_template: number;
  pushed_at: number | null;
  created_at: number;
  updated_at: number;
}

const REPO_SELECT = `
  SELECT r.id, r.owner_id, r.name, r.storage_key, r.description, r.visibility,
         r.default_branch, r.fork_of_id, r.is_archived, r.is_template, r.pushed_at,
         r.created_at, r.updated_at,
         o.login AS owner_login, o.type AS owner_type,
         o.principal_id AS owner_principal_id
    FROM repositories r
    JOIN owners o ON o.id = r.owner_id`;

function normalizeVisibility(value: string): Visibility {
  return value === "public" || value === "internal" ? value : "private";
}

function toRepoFullRow(row: RawRepoFullRow): RepoFullRow {
  return {
    id: row.id,
    ownerId: row.owner_id,
    ownerLogin: row.owner_login,
    ownerType: row.owner_type === "org" ? "org" : "user",
    ownerPrincipalId: row.owner_principal_id,
    name: row.name,
    storageKey: row.storage_key,
    description: row.description,
    visibility: normalizeVisibility(row.visibility),
    defaultBranch: row.default_branch,
    forkOfId: row.fork_of_id,
    isArchived: row.is_archived !== 0,
    isTemplate: row.is_template !== 0,
    pushedAt: row.pushed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getRepoById(
  db: DbClient,
  id: string,
): Promise<RepoFullRow | null> {
  const row = await db.queryOne<RawRepoFullRow>(
    `${REPO_SELECT} WHERE r.id = ? LIMIT 1`,
    [id],
  );
  return row ? toRepoFullRow(row) : null;
}

export async function getRepoByOwnerName(
  db: DbClient,
  owner: string,
  name: string,
): Promise<RepoFullRow | null> {
  const row = await db.queryOne<RawRepoFullRow>(
    `${REPO_SELECT} WHERE o.login = ? COLLATE NOCASE AND r.name = ? COLLATE NOCASE LIMIT 1`,
    [owner, name],
  );
  return row ? toRepoFullRow(row) : null;
}

/** Direct fork children of `repoId`, newest first (bounded). */
export async function listForkChildren(
  db: DbClient,
  repoId: string,
  limit: number,
): Promise<RepoFullRow[]> {
  const rows = await db.query<RawRepoFullRow>(
    `${REPO_SELECT} WHERE r.fork_of_id = ? ORDER BY r.updated_at DESC, r.id DESC LIMIT ?`,
    [repoId, Math.max(1, Math.min(limit, 200))],
  );
  return rows.map(toRepoFullRow);
}

/**
 * Walk `fork_of_id` up to the network root (the topmost non-fork ancestor).
 * Bounded so a pathological cycle can never loop forever.
 */
export async function forkNetworkRoot(
  db: DbClient,
  repo: RepoFullRow,
): Promise<RepoFullRow> {
  let current = repo;
  const seen = new Set<string>([current.id]);
  for (let hops = 0; hops < 64 && current.forkOfId; hops += 1) {
    const parent = await getRepoById(db, current.forkOfId);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    current = parent;
  }
  return current;
}

/**
 * Every member of the fork network rooted at `root`: the root plus all
 * transitive fork descendants, discovered by BFS over `fork_of_id`. Bounded.
 */
export async function forkNetworkMembers(
  db: DbClient,
  root: RepoFullRow,
  cap = 500,
): Promise<RepoFullRow[]> {
  const members: RepoFullRow[] = [root];
  const seen = new Set<string>([root.id]);
  const queue: string[] = [root.id];
  while (queue.length > 0 && members.length < cap) {
    const parentId = queue.shift() as string;
    const children = await listForkChildren(db, parentId, cap);
    for (const child of children) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      members.push(child);
      queue.push(child.id);
      if (members.length >= cap) break;
    }
  }
  return members;
}

// ============================================================================
// DTO mapping
// ============================================================================

export function toRepositoryDtoFull(
  row: RepoFullRow,
  parentFullName: string | null,
  originBase: string,
): RepositoryDto {
  return {
    owner: row.ownerLogin,
    name: row.name,
    fullName: `${row.ownerLogin}/${row.name}`,
    visibility: row.visibility,
    defaultBranch: row.defaultBranch,
    description: row.description,
    isArchived: row.isArchived,
    isTemplate: row.isTemplate,
    forkOf: parentFullName,
    cloneUrl: cloneUrlFor(originBase, row.storageKey),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    pushedAt: row.pushedAt,
  };
}

// ============================================================================
// R2 object copy (content-addressed, idempotent)
// ============================================================================

/**
 * Copy every git object from `fromStorageKey`'s repo prefix into
 * `toStorageKey`'s. Objects are content-addressed, so an existing object at the
 * destination (head hit) is skipped — the copy is idempotent and safe to retry.
 */
export async function copyRepoObjects(
  bucket: ObjectStoreBinding,
  fromStorageKey: string,
  toStorageKey: string,
): Promise<number> {
  const src = repositoryObjectStore(bucket, fromStorageKey);
  const dst = repositoryObjectStore(bucket, toStorageKey);
  let copied = 0;
  let cursor: string | undefined;
  do {
    const page = await src.list({
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    for (const { key } of page.objects) {
      if (await dst.head(key)) continue;
      const body = await src.get(key);
      if (!body) continue;
      await dst.put(key, new Uint8Array(await body.arrayBuffer()));
      copied += 1;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return copied;
}

// ============================================================================
// ref_index projection (rebuildable D1 mirror of the R2 refs-doc)
// ============================================================================

function refKind(name: string): "branch" | "tag" | null {
  if (name.startsWith("refs/heads/")) return "branch";
  if (name.startsWith("refs/tags/")) return "tag";
  return null;
}

/** Rebuild `ref_index` rows for `repoId` from an authoritative refs-doc. */
export async function projectRefIndex(
  db: DbClient,
  repoId: string,
  doc: RefsDoc,
): Promise<void> {
  const now = db.now();
  const defaultName = doc.defaultBranch
    ? `refs/heads/${doc.defaultBranch}`
    : null;
  await db.run(`DELETE FROM ref_index WHERE repo_id = ?`, [repoId]);
  for (const ref of doc.refs) {
    const kind = refKind(ref.name);
    if (!kind) continue;
    await db.run(
      `INSERT INTO ref_index (repo_id, name, kind, target_sha, is_default, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [repoId, ref.name, kind, ref.sha, ref.name === defaultName ? 1 : 0, now],
    );
  }
}

// ============================================================================
// Fork
// ============================================================================

export type ForkOutcome =
  | { readonly ok: true; readonly fork: RepoFullRow; readonly objectsCopied: number }
  | {
      readonly ok: false;
      readonly code:
        | "self_fork"
        | "name_conflict"
        | "provision_failed"
        | "copy_failed";
    };

/**
 * Fork `source` into `targetOwner` as `forkName`. Steps (cross-store order):
 *   1. `provisionRepo` — R2 refs-doc create-if-absent CAS, then D1 row (with
 *      `fork_of_id = source.id`).
 *   2. Copy git objects source→fork.
 *   3. Two-phase advance the fork's refs to mirror source's refs (the only
 *      sanctioned ref writer); project `ref_index`.
 *   4. Record the `repo_forks` network edge.
 * A failure after (1) rolls the half-provisioned fork back by deleting it.
 */
export async function forkRepository(
  bucket: ObjectStoreBinding,
  db: DbClient,
  source: RepoFullRow,
  targetOwner: OwnerRow,
  forkName: string,
): Promise<ForkOutcome> {
  if (targetOwner.id === source.ownerId && forkName === source.name) {
    return { ok: false, code: "self_fork" };
  }

  const provisioned = await provisionRepo(bucket, db, targetOwner, {
    name: forkName,
    visibility: source.visibility,
    defaultBranch: source.defaultBranch,
    description: source.description,
    forkOfId: source.id,
  });
  if (!provisioned.ok) {
    return {
      ok: false,
      code: provisioned.code === "repo_exists" ? "name_conflict" : "provision_failed",
    };
  }
  const forkRow: RepoRow = provisioned.repo;
  const forkStorageKey = forkRow.storageKey;

  try {
    const objectsCopied = await copyRepoObjects(
      bucket,
      source.storageKey,
      forkStorageKey,
    );

    const sourceRefs = await readRepoRefs(bucket, source.storageKey);
    const result = await writeRefsWithMetadata(bucket, {
      repo: forkStorageKey,
      mutateRefs: () => ({
        refs: sourceRefs.refs,
        defaultBranch: sourceRefs.defaultBranch ?? source.defaultBranch,
      }),
      projectMetadata: async (committed) => {
        await projectRefIndex(db, forkRow.id, committed.refs);
      },
    });
    if (result.status !== "committed") {
      throw new Error(`fork refs advance failed: ${result.status}`);
    }

    await db.run(
      `INSERT INTO repo_forks (id, fork_repo_id, upstream_repo_id, created_at)
       VALUES (?, ?, ?, ?)`,
      [db.id(), forkRow.id, source.id, db.now()],
    );

    const fork = await getRepoById(db, forkRow.id);
    if (!fork) throw new Error("fork row vanished after provision");
    return { ok: true, fork, objectsCopied };
  } catch {
    // Roll back the half-provisioned fork: remove R2 objects/refs then the D1
    // row (cascades repo_forks). The parent is untouched.
    await deleteForkRollback(bucket, db, forkStorageKey, forkRow.id);
    return { ok: false, code: "copy_failed" };
  }
}

async function deleteForkRollback(
  bucket: ObjectStoreBinding,
  db: DbClient,
  storageKey: string,
  repoId: string,
): Promise<void> {
  await deleteRepo(bucket, storageKey).catch(() => undefined);
  await db.run(`DELETE FROM repositories WHERE id = ?`, [repoId]).catch(
    () => undefined,
  );
}

// ============================================================================
// Sync with upstream (fast-forward only)
// ============================================================================

/** Resolve a fork's upstream repo via `repo_forks`, falling back to `fork_of_id`. */
export async function resolveUpstream(
  db: DbClient,
  fork: RepoFullRow,
): Promise<RepoFullRow | null> {
  const edge = await db.queryOne<{ upstream_repo_id: string | null }>(
    `SELECT upstream_repo_id FROM repo_forks WHERE fork_repo_id = ? LIMIT 1`,
    [fork.id],
  );
  const upstreamId = edge?.upstream_repo_id ?? fork.forkOfId;
  if (!upstreamId) return null;
  return getRepoById(db, upstreamId);
}

export type SyncOutcome =
  | {
      readonly ok: true;
      readonly branch: string;
      readonly previousHead: string | null;
      readonly newHead: string;
      readonly commitsSynced: number;
      readonly alreadyUpToDate: boolean;
    }
  | {
      readonly ok: false;
      readonly code:
        | "not_a_fork"
        | "upstream_gone"
        | "upstream_branch_missing"
        | "diverged"
        | "conflict"
        | "advance_failed";
    };

function findBranch(doc: RefsDoc, branch: string): RefRecord | undefined {
  return doc.refs.find((ref) => ref.name === `refs/heads/${branch}`);
}

/**
 * Fast-forward `fork`'s `branch` to its upstream tip. Rejects any non-fast-
 * forward (diverged history) — there is no merge or rebase path. Objects
 * reachable in the upstream are copied into the fork before the ref advance so
 * the new tip is fully present in the fork's own prefix.
 */
export async function syncFork(
  bucket: ObjectStoreBinding,
  db: DbClient,
  fork: RepoFullRow,
  branch: string,
): Promise<SyncOutcome> {
  const upstream = await resolveUpstream(db, fork);
  if (!upstream) {
    // No edge AND no fork_of_id ⇒ not a fork; an edge to a deleted repo ⇒ gone.
    const hasEdge = await db.queryOne<{ id: string }>(
      `SELECT id FROM repo_forks WHERE fork_repo_id = ? LIMIT 1`,
      [fork.id],
    );
    return { ok: false, code: hasEdge || fork.forkOfId ? "upstream_gone" : "not_a_fork" };
  }

  const upstreamRefs = await readRepoRefs(bucket, upstream.storageKey);
  const upstreamRef = findBranch(upstreamRefs, branch);
  if (!upstreamRef) return { ok: false, code: "upstream_branch_missing" };
  const upstreamTip = upstreamRef.sha;

  const forkRefs = await readRepoRefs(bucket, fork.storageKey);
  const forkTip = findBranch(forkRefs, branch)?.sha ?? null;

  if (forkTip === upstreamTip) {
    return {
      ok: true,
      branch,
      previousHead: forkTip,
      newHead: upstreamTip,
      commitsSynced: 0,
      alreadyUpToDate: true,
    };
  }

  const upstreamStore = repositoryObjectStore(bucket, upstream.storageKey);

  // Fast-forward requires the fork tip to be an ancestor of the upstream tip.
  // A missing fork branch is treated as a fresh fast-forwardable create.
  if (forkTip !== null) {
    const ff = await isAncestor(upstreamStore, forkTip, upstreamTip);
    if (!ff) return { ok: false, code: "diverged" };
  }

  // Bring the new commits (and their trees/blobs) into the fork prefix.
  await copyRepoObjects(bucket, upstream.storageKey, fork.storageKey);

  const result = await writeRefsWithMetadata(bucket, {
    repo: fork.storageKey,
    mutateRefs: (current) => {
      const others = current.refs.filter(
        (ref) => ref.name !== `refs/heads/${branch}`,
      );
      return {
        refs: [...others, { name: `refs/heads/${branch}`, sha: upstreamTip }],
        defaultBranch: current.defaultBranch,
      };
    },
    projectMetadata: async (committed) => {
      await projectRefIndex(db, fork.id, committed.refs);
      await db.run(
        `UPDATE repo_forks SET last_synced_at = ? WHERE fork_repo_id = ?`,
        [db.now(), fork.id],
      );
    },
  });

  if (result.status === "conflict") return { ok: false, code: "conflict" };
  if (result.status !== "committed") return { ok: false, code: "advance_failed" };

  let commitsSynced = 0;
  try {
    commitsSynced =
      forkTip === null
        ? 0
        : await countAhead(upstreamStore, forkTip, upstreamTip);
  } catch {
    commitsSynced = 0;
  }

  return {
    ok: true,
    branch,
    previousHead: forkTip,
    newHead: upstreamTip,
    commitsSynced,
    alreadyUpToDate: false,
  };
}

/** Commits on `headSha` not reachable from `baseSha` (best-effort, bounded). */
async function countAhead(
  store: ObjectStoreBinding,
  baseSha: string,
  headSha: string,
): Promise<number> {
  const base = await findMergeBase(store, baseSha, headSha);
  const stop = base ?? baseSha;
  let count = 0;
  const visited = new Set<string>();
  const queue: string[] = [headSha];
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    if (visited.has(sha) || sha === stop) continue;
    visited.add(sha);
    if (visited.size > 100_000) break;
    count += 1;
    const commit = await getCommitData(store, sha);
    if (commit) for (const parent of commit.parents) queue.push(parent);
  }
  return count;
}
