/**
 * Generation-fenced repository deletion over R2.
 *
 * Active refs are the repository existence signal. Deletion first CAS-replaces
 * that document with a tombstone, writes a generation-specific quarantine
 * marker, then removes the active refs key. Object bytes remain under the
 * reserved repository namespace until the D1 deletion ledger permits cleanup.
 */

import { deleteRepositoryObjects } from "./repo-object-store.ts";
import {
  isValidRepoName,
  readRepoRefsSnapshot,
} from "./refs-store.ts";
import type { ObjectStoreBinding } from "./types.ts";

const REFS_PREFIX = "git/v2/refs/";
const ACTIONS_PIN_PREFIX = "git/v2/actions-pins/";
const QUARANTINE_PREFIX = "git/v4/quarantine/";
const MAX_TOMBSTONE_CAS_ATTEMPTS = 8;

function validGeneration(generation: string): boolean {
  return /^[0-9A-Za-z_-]{1,128}$/u.test(generation);
}

function refsKey(repo: string): string {
  return `${REFS_PREFIX}${repo}.json`;
}

function actionsPinKey(repo: string): string {
  return `${ACTIONS_PIN_PREFIX}${repo}.json`;
}

export function repositoryQuarantineKey(generation: string): string {
  if (!validGeneration(generation)) {
    throw new Error(`invalid repository generation: ${generation}`);
  }
  return `${QUARANTINE_PREFIX}${generation}/tombstone.json`;
}

interface QuarantineMarker {
  readonly kind: "takos-git.repository-quarantine@v1";
  readonly generation: string;
  readonly repo: string;
  readonly state: "quarantined";
  readonly quarantinedAt: number;
  readonly sourceEtag: string | null;
  readonly refs: unknown;
}

function markerBody(
  repo: string,
  generation: string,
  quarantinedAt: number,
  sourceEtag: string | null,
  refs: unknown,
): string {
  const marker: QuarantineMarker = {
    kind: "takos-git.repository-quarantine@v1",
    generation,
    repo,
    state: "quarantined",
    quarantinedAt,
    sourceEtag,
    refs,
  };
  return JSON.stringify(marker);
}

async function readMarker(
  bucket: ObjectStoreBinding,
  generation: string,
): Promise<QuarantineMarker | null> {
  const object = await bucket.get(repositoryQuarantineKey(generation));
  if (!object) return null;
  try {
    const value = JSON.parse(
      new TextDecoder().decode(new Uint8Array(await object.arrayBuffer())),
    ) as Partial<QuarantineMarker>;
    return value.kind === "takos-git.repository-quarantine@v1" &&
      value.generation === generation &&
      typeof value.repo === "string" &&
      value.state === "quarantined"
      ? (value as QuarantineMarker)
      : null;
  } catch {
    return null;
  }
}

/**
 * Fence a repository and persist its last ref snapshot under a unique
 * generation. Safe to retry after any intermediate failure.
 */
export async function quarantineRepository(
  bucket: ObjectStoreBinding,
  repo: string,
  generation: string,
  quarantinedAt: number,
): Promise<string> {
  if (!isValidRepoName(repo)) throw new Error(`invalid repo name: ${repo}`);
  const quarantineKey = repositoryQuarantineKey(generation);

  for (let attempt = 0; attempt < MAX_TOMBSTONE_CAS_ATTEMPTS; attempt += 1) {
    const snapshot = await readRepoRefsSnapshot(bucket, repo);
    if (!snapshot) {
      const existing = await readMarker(bucket, generation);
      if (existing && existing.repo !== repo) {
        throw new Error("repository generation belongs to another namespace");
      }
      if (!existing) {
        await bucket.put(
          quarantineKey,
          markerBody(repo, generation, quarantinedAt, null, null),
        );
      }
      return quarantineKey;
    }

    // Write the recoverable snapshot before cutting over the existence key.
    await bucket.put(
      quarantineKey,
      markerBody(
        repo,
        generation,
        quarantinedAt,
        snapshot.etag,
        snapshot.doc,
      ),
    );
    const tombstoned = await bucket.put(
      refsKey(repo),
      JSON.stringify({
        refs: [],
        defaultBranch: null,
        deletion: { generation, quarantinedAt },
      }),
      { onlyIf: { etagMatches: snapshot.etag } },
    );
    if (!tombstoned) continue;

    // Any in-flight ref writer holding the pre-tombstone ETag now fails. D1
    // keeps the namespace reserved, so no new writer can obtain authorization.
    await bucket.delete(refsKey(repo));
    await bucket.delete(actionsPinKey(repo));
    return quarantineKey;
  }
  throw new Error(`repository tombstone CAS did not converge for ${repo}`);
}

/**
 * Remove bytes for one already-quarantined generation. It refuses to touch a
 * namespace without the matching marker.
 */
export async function cleanupQuarantinedRepository(
  bucket: ObjectStoreBinding,
  repo: string,
  generation: string,
): Promise<number> {
  if (!isValidRepoName(repo)) throw new Error(`invalid repo name: ${repo}`);
  const marker = await readMarker(bucket, generation);
  if (!marker || marker.repo !== repo) {
    throw new Error("repository quarantine marker is missing or mismatched");
  }
  // Re-assert the tombstone after a crash between marker creation and ref
  // removal. No active generation may be cleaned through this path.
  await quarantineRepository(
    bucket,
    repo,
    generation,
    marker.quarantinedAt,
  );
  const deleted = await deleteRepositoryObjects(bucket, repo);
  await bucket.delete(actionsPinKey(repo));
  return deleted;
}

export async function removeRepositoryQuarantineMarker(
  bucket: ObjectStoreBinding,
  generation: string,
): Promise<void> {
  await bucket.delete(repositoryQuarantineKey(generation));
}
