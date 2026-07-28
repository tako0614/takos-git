/**
 * Repository metadata service — the D1 authority for repo existence, visibility,
 * and settings. Git objects/refs stay authoritative in R2; the D1 row is the
 * ACL/identity record keyed by the same `<owner>/<name>`.
 *
 * Creation and deletion are the cross-store writes: R2 refs-doc is the atomic
 * boundary (created/removed first), the D1 row is the metadata follow-up. An
 * empty just-created repo carries no objects, so a failed D1 insert safely rolls
 * back its empty R2 refs-doc (no ref advance, no data loss).
 */

import { effectiveRole } from "../../auth/acl.ts";
import type {
  Principal,
  RepositoryDto,
  Visibility,
} from "../../contract/v1.ts";
import type { DbClient } from "../../db/index.ts";
import {
  createRepo,
  deleteRepo,
  readRepoRefs,
} from "../../git/refs-store.ts";
import {
  cleanupQuarantinedRepository,
  quarantineRepository,
  removeRepositoryQuarantineMarker,
  repositoryQuarantineKey,
} from "../../git/repository-deletion.ts";
import type { ObjectStoreBinding } from "../../git/types.ts";
import type { OwnerRow } from "./owners.ts";

export interface RepoRow {
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
  readonly forkParent: string | null;
  readonly isArchived: boolean;
  readonly isTemplate: boolean;
  readonly pushedAt: number | null;
  readonly generation: string;
  readonly lifecycleState: "active" | "deleting";
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
  fork_owner_login: string | null;
  fork_name: string | null;
  is_archived: number;
  is_template: number;
  pushed_at: number | null;
  generation: string;
  lifecycle_state: string;
  created_at: number;
  updated_at: number;
}

const REPO_SELECT = `
  SELECT r.id, r.owner_id, r.name, r.storage_key, r.description, r.visibility,
         r.default_branch, r.fork_of_id, r.is_archived, r.is_template, r.pushed_at,
         r.generation, r.lifecycle_state,
         r.created_at, r.updated_at,
         o.login AS owner_login, o.type AS owner_type, o.principal_id AS owner_principal_id,
         po.login AS fork_owner_login, pr.name AS fork_name
    FROM repositories r
    JOIN owners o ON o.id = r.owner_id
    LEFT JOIN repositories pr ON pr.id = r.fork_of_id
    LEFT JOIN owners po ON po.id = pr.owner_id`;

function normalizeVisibility(value: string): Visibility {
  return value === "public" || value === "internal" ? value : "private";
}

export function isValidVisibility(value: unknown): value is Visibility {
  return value === "public" || value === "private" || value === "internal";
}

function toRepoRow(row: RawRepoFullRow): RepoRow {
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
    forkParent:
      row.fork_owner_login && row.fork_name
        ? `${row.fork_owner_login}/${row.fork_name}`
        : null,
    isArchived: row.is_archived !== 0,
    isTemplate: row.is_template !== 0,
    pushedAt: row.pushed_at,
    generation: row.generation,
    lifecycleState: row.lifecycle_state === "deleting" ? "deleting" : "active",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function encodedRepoPath(storageKey: string): string {
  return storageKey.split("/").map(encodeURIComponent).join("/");
}

export function cloneUrlFor(originBase: string, storageKey: string): string {
  const base = originBase.replace(/\/$/u, "");
  return `${base}/git/${encodedRepoPath(storageKey)}.git`;
}

export function toRepositoryDto(row: RepoRow, originBase: string): RepositoryDto {
  return {
    owner: row.ownerLogin,
    name: row.name,
    fullName: `${row.ownerLogin}/${row.name}`,
    visibility: row.visibility,
    defaultBranch: row.defaultBranch,
    description: row.description,
    isArchived: row.isArchived,
    isTemplate: row.isTemplate,
    forkOf: row.forkParent,
    cloneUrl: cloneUrlFor(originBase, row.storageKey),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    pushedAt: row.pushedAt,
  };
}

export async function getRepoRow(
  db: DbClient,
  owner: string,
  name: string,
): Promise<RepoRow | null> {
  const row = await db.queryOne<RawRepoFullRow>(
    `${REPO_SELECT} WHERE o.login = ? COLLATE NOCASE AND r.name = ? COLLATE NOCASE
      AND r.lifecycle_state = 'active' LIMIT 1`,
    [owner, name],
  );
  return row ? toRepoRow(row) : null;
}

async function getRepoRowById(
  db: DbClient,
  id: string,
  includeDeleting = false,
): Promise<RepoRow | null> {
  const row = await db.queryOne<RawRepoFullRow>(
    `${REPO_SELECT} WHERE r.id = ?
      ${includeDeleting ? "" : "AND r.lifecycle_state = 'active'"} LIMIT 1`,
    [id],
  );
  return row ? toRepoRow(row) : null;
}

export interface ProvisionRepoInput {
  readonly name: string;
  readonly visibility?: Visibility;
  readonly defaultBranch?: string;
  readonly description?: string | null;
  readonly forkOfId?: string | null;
}

export type ProvisionResult =
  | { readonly ok: true; readonly repo: RepoRow }
  | { readonly ok: false; readonly code: "repo_exists" | "repo_conflict" };

/** Repo name is a single R2 path segment. */
export function isValidRepoNameSegment(name: string): boolean {
  return /^[a-zA-Z0-9._-]+$/u.test(name) && !name.includes("..");
}

/**
 * Create a repo under an existing owner: R2 refs-doc first (atomic create-if-
 * absent CAS), then the D1 metadata row. A D1 failure rolls back the empty R2
 * doc.
 */
export async function provisionRepo(
  bucket: ObjectStoreBinding,
  db: DbClient,
  owner: OwnerRow,
  input: ProvisionRepoInput,
): Promise<ProvisionResult> {
  const storageKey = `${owner.login}/${input.name}`;
  const dup = await db.queryOne<{ id: string }>(
    `SELECT id FROM repositories WHERE owner_id = ? AND name = ? COLLATE NOCASE LIMIT 1`,
    [owner.id, input.name],
  );
  if (dup) return { ok: false, code: "repo_exists" };

  const now = db.now();
  const id = db.id();
  const generation = id;

  // --- ATOMIC create-if-absent on R2 (the ref-state boundary) ---
  const createdR2 = await createRepo(bucket, storageKey);
  if (!createdR2) return { ok: false, code: "repo_exists" };

  try {
    await db.run(
      `INSERT INTO repositories
         (id, owner_id, name, storage_key, description, visibility,
          default_branch, fork_of_id, generation, lifecycle_state,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      [
        id,
        owner.id,
        input.name,
        storageKey,
        input.description ?? null,
        input.visibility ?? "private",
        input.defaultBranch ?? "main",
        input.forkOfId ?? null,
        generation,
        now,
        now,
      ],
    );
  } catch {
    // The empty refs-doc has no objects — safe to roll back (no ref advance).
    await deleteRepo(bucket, storageKey).catch(() => undefined);
    return { ok: false, code: "repo_conflict" };
  }
  const repo = await getRepoRowById(db, id);
  if (!repo) return { ok: false, code: "repo_conflict" };
  return { ok: true, repo };
}

export interface UpdateRepoInput {
  readonly description?: string | null;
  readonly visibility?: Visibility;
  readonly defaultBranch?: string;
  readonly isArchived?: boolean;
}

/** Patch mutable repo settings. Returns the refreshed row. */
export async function updateRepo(
  db: DbClient,
  repoId: string,
  input: UpdateRepoInput,
): Promise<RepoRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (input.description !== undefined) {
    sets.push("description = ?");
    params.push(input.description);
  }
  if (input.visibility !== undefined) {
    sets.push("visibility = ?");
    params.push(input.visibility);
  }
  if (input.defaultBranch !== undefined) {
    sets.push("default_branch = ?");
    params.push(input.defaultBranch);
  }
  if (input.isArchived !== undefined) {
    sets.push("is_archived = ?");
    params.push(input.isArchived ? 1 : 0);
  }
  sets.push("updated_at = ?");
  params.push(db.now());
  params.push(repoId);
  await db.run(
    `UPDATE repositories SET ${sets.join(", ")} WHERE id = ?`,
    params,
  );
  return getRepoRowById(db, repoId);
}

const REPOSITORY_QUARANTINE_MS = 10 * 60_000;
const MAX_DELETION_BATCH = 20;
const MAX_DELETION_ERROR_LENGTH = 512;

export interface RepositoryDeletionReceipt {
  readonly generation: string;
  readonly cleanupPending: true;
}

interface RepositoryDeletionRow {
  readonly generation: string;
  readonly repo_id: string;
  readonly storage_key: string;
  readonly quarantine_key: string;
  readonly status: string;
  readonly not_before: number;
}

const REPOSITORY_AUXILIARY_DELETE_PAGE = 100;

async function deleteObjectPrefix(
  bucket: ObjectStoreBinding,
  prefix: string,
): Promise<number> {
  let deleted = 0;
  for (;;) {
    const page = await bucket.list({
      prefix,
      limit: REPOSITORY_AUXILIARY_DELETE_PAGE,
    });
    if (page.objects.length === 0) return deleted;
    await bucket.delete(page.objects.map((object) => object.key));
    deleted += page.objects.length;
  }
}

/**
 * Remove legacy outbox payloads whose old key layout did not include repo id.
 * Each successful R2 batch clears its D1 pointers before the next batch, so a
 * retry cannot loop over already-deleted bytes.
 */
async function deleteLegacyWebhookPayloads(
  db: DbClient,
  bucket: ObjectStoreBinding,
  repoId: string,
): Promise<number> {
  let deleted = 0;
  for (;;) {
    const rows = await db.query<{ id: string; payload_r2_key: string }>(
      `SELECT wd.id, wd.payload_r2_key
         FROM webhook_deliveries wd
         JOIN webhooks w ON w.id = wd.webhook_id
        WHERE w.repo_id = ? AND wd.payload_r2_key IS NOT NULL
        LIMIT ?`,
      [repoId, REPOSITORY_AUXILIARY_DELETE_PAGE],
    );
    if (rows.length === 0) return deleted;
    await bucket.delete([
      ...new Set(rows.map((row) => row.payload_r2_key)),
    ]);
    await db.batch(
      rows.map((row) => ({
        sql: `UPDATE webhook_deliveries
              SET payload_r2_key = NULL, payload_sha256 = NULL, updated_at = ?
              WHERE id = ?`,
        params: [db.now(), row.id],
      })),
    );
    deleted += rows.length;
  }
}

/**
 * Logically delete a repository without racing a recreate.
 *
 * D1 first reserves the namespace in `deleting`; the R2 refs CAS then fences
 * in-flight writers and leaves a generation-specific quarantine marker.
 * Physical bytes and relational metadata are removed by the bounded cleanup
 * queue after the drain window.
 */
export async function deleteRepository(
  bucket: ObjectStoreBinding,
  db: DbClient,
  repo: RepoRow,
): Promise<RepositoryDeletionReceipt> {
  const now = db.now();
  const quarantineKey = repositoryQuarantineKey(repo.generation);
  await db.batch([
    {
      sql: `UPDATE repositories
            SET lifecycle_state = 'deleting', updated_at = ?
            WHERE id = ? AND generation = ? AND lifecycle_state = 'active'`,
      params: [now, repo.id, repo.generation],
    },
    {
      sql: `INSERT OR IGNORE INTO repository_deletions
              (generation, repo_id, storage_key, quarantine_key, status,
               not_before, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`,
      params: [
        repo.generation,
        repo.id,
        repo.storageKey,
        quarantineKey,
        now + REPOSITORY_QUARANTINE_MS,
        now,
        now,
      ],
    },
  ]);
  try {
    await quarantineRepository(
      bucket,
      repo.storageKey,
      repo.generation,
      now,
    );
    await db.run(
      `UPDATE repository_deletions
       SET status = 'quarantined', last_error = NULL, updated_at = ?
       WHERE generation = ?`,
      [db.now(), repo.generation],
    );
  } catch (error) {
    await db.run(
      `UPDATE repository_deletions
       SET status = 'failed', last_error = ?, updated_at = ?
       WHERE generation = ?`,
      [
        error instanceof Error
          ? error.message.slice(0, MAX_DELETION_ERROR_LENGTH)
          : "repository quarantine failed",
        db.now(),
        repo.generation,
      ],
    );
    throw error;
  }
  return { generation: repo.generation, cleanupPending: true };
}

/**
 * Retry tombstones immediately and physically clean only generations whose
 * quarantine window elapsed. Completed ledger rows remain as audit evidence.
 */
export async function processRepositoryDeletionQueue(
  db: DbClient,
  bucket: ObjectStoreBinding,
  options: {
    readonly now?: number;
    readonly limit?: number;
    readonly actionsBucket?: ObjectStoreBinding;
  } = {},
): Promise<{ cleaned: number; failed: number }> {
  const now = options.now ?? db.now();
  const limit = Math.max(
    1,
    Math.min(options.limit ?? MAX_DELETION_BATCH, MAX_DELETION_BATCH),
  );
  const rows = await db.query<RepositoryDeletionRow>(
    `SELECT generation, repo_id, storage_key, quarantine_key, status, not_before
     FROM repository_deletions
     WHERE status IN ('queued', 'failed')
        OR (status IN ('quarantined', 'cleaning') AND not_before <= ?)
     ORDER BY created_at ASC
     LIMIT ?`,
    [now, limit],
  );
  let cleaned = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const repo = await getRepoRowById(db, row.repo_id, true);
      if (!repo) {
        await db.run(
          `UPDATE repository_deletions
           SET status = 'completed', last_error = NULL,
               completed_at = COALESCE(completed_at, ?), updated_at = ?
           WHERE generation = ?`,
          [now, now, row.generation],
        );
        continue;
      }
      if (
        repo.generation !== row.generation ||
        repo.storageKey !== row.storage_key ||
        repo.lifecycleState !== "deleting"
      ) {
        throw new Error("repository deletion generation fence mismatch");
      }
      await quarantineRepository(
        bucket,
        row.storage_key,
        row.generation,
        now,
      );
      await db.run(
        `UPDATE repository_deletions
         SET status = 'quarantined', last_error = NULL, updated_at = ?
         WHERE generation = ?`,
        [db.now(), row.generation],
      );
      if (now < row.not_before) continue;

      await db.run(
        `UPDATE repository_deletions SET status = 'cleaning', updated_at = ?
         WHERE generation = ?`,
        [db.now(), row.generation],
      );
      await cleanupQuarantinedRepository(
        bucket,
        row.storage_key,
        row.generation,
      );
      await Promise.all([
        deleteObjectPrefix(
          bucket,
          `release-assets/${row.storage_key}/`,
        ),
        deleteObjectPrefix(
          bucket,
          `webhooks/v1/repos/${row.repo_id}/`,
        ),
        deleteLegacyWebhookPayloads(db, bucket, row.repo_id),
        ...(options.actionsBucket
          ? [
              deleteObjectPrefix(
                options.actionsBucket,
                `logs/${row.repo_id}/`,
              ),
              deleteObjectPrefix(
                options.actionsBucket,
                `artifacts/${row.repo_id}/`,
              ),
            ]
          : []),
      ]);
      await db.batch([
        {
          sql: `DELETE FROM repositories
                WHERE id = ? AND generation = ? AND lifecycle_state = 'deleting'`,
          params: [row.repo_id, row.generation],
        },
        {
          sql: `UPDATE repository_deletions
                SET status = 'completed', last_error = NULL,
                    completed_at = ?, updated_at = ?
                WHERE generation = ?`,
          params: [now, now, row.generation],
        },
      ]);
      const remaining = await getRepoRowById(db, row.repo_id, true);
      if (remaining) {
        throw new Error("repository row survived generation-fenced cleanup");
      }
      await removeRepositoryQuarantineMarker(bucket, row.generation);
      cleaned += 1;
    } catch (error) {
      failed += 1;
      await db.run(
        `UPDATE repository_deletions
         SET status = 'failed', last_error = ?, updated_at = ?
         WHERE generation = ?`,
        [
          error instanceof Error
            ? error.message.slice(0, MAX_DELETION_ERROR_LENGTH)
            : "repository cleanup failed",
          db.now(),
          row.generation,
        ],
      );
    }
  }
  return { cleaned, failed };
}

/** R2-derived branch/tag counts for the repo detail view. */
export async function repoRefCounts(
  bucket: ObjectStoreBinding,
  storageKey: string,
): Promise<{ branchCount: number; tagCount: number }> {
  const refs = await readRepoRefs(bucket, storageKey);
  let branchCount = 0;
  let tagCount = 0;
  for (const ref of refs.refs) {
    if (ref.name.startsWith("refs/heads/")) branchCount += 1;
    else if (ref.name.startsWith("refs/tags/")) tagCount += 1;
  }
  return { branchCount, tagCount };
}

export interface RepoListPage {
  readonly repos: readonly RepoRow[];
  readonly nextCursor: string | null;
}

// Bound on rows scanned per list request when filtering by effective access, so
// a page dominated by unreadable private repos cannot fan out unboundedly.
const MAX_LIST_SCAN = 500;

/**
 * List repos the principal can read (`contents.read`), newest first. The opaque
 * cursor encodes a scan offset; per-row ACL filtering keeps private repos out of
 * a caller's list without existence disclosure.
 */
export async function listReadableRepos(
  db: DbClient,
  principal: Principal,
  options: { limit: number; cursor: string | null },
): Promise<RepoListPage> {
  const startOffset = decodeOffset(options.cursor);
  const visible: RepoRow[] = [];
  let offset = startOffset;
  let scanned = 0;
  const batch = Math.min(Math.max(options.limit * 2, options.limit + 1), 100);

  while (visible.length < options.limit && scanned < MAX_LIST_SCAN) {
    const rows = await db.query<RawRepoFullRow>(
      `${REPO_SELECT} WHERE r.lifecycle_state = 'active'
       ORDER BY r.updated_at DESC, r.id DESC LIMIT ? OFFSET ?`,
      [batch, offset],
    );
    if (rows.length === 0) break;
    for (const raw of rows) {
      offset += 1;
      scanned += 1;
      const row = toRepoRow(raw);
      const role = await effectiveRole(db, principal, {
        id: row.id,
        ownerId: row.ownerId,
        ownerLogin: row.ownerLogin,
        ownerType: row.ownerType,
        ownerPrincipalId: row.ownerPrincipalId,
        name: row.name,
        visibility: row.visibility,
        defaultBranch: row.defaultBranch,
      });
      if (role !== null) visible.push(row);
      if (visible.length >= options.limit) break;
      if (scanned >= MAX_LIST_SCAN) break;
    }
    if (rows.length < batch) break;
  }

  // A non-null cursor only when we stopped on a full page (more may remain).
  const nextCursor =
    visible.length >= options.limit ? encodeOffset(offset) : null;
  return { repos: visible, nextCursor };
}

function decodeOffset(cursor: string | null): number {
  if (!cursor) return 0;
  const value = Number.parseInt(cursor, 10);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function encodeOffset(offset: number): string {
  return String(offset);
}
