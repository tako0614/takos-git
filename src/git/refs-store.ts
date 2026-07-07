/**
 * Minimal per-repo ref store, backed by a small JSON blob in the same R2
 * bucket as the objects. Replaces the takos worker's D1 refs/branches tables.
 *
 * Objects stay content-addressed and shared across repos (`git/v2/objects/...`),
 * but refs are per-repo (`git/v2/refs/<repo>.json`); the upload-pack tip guard
 * (want ⊆ this repo's advertised tips) confines a clone to its own objects.
 */

import type { ObjectStoreBinding } from "./types.ts";

export interface RefRecord {
  /** Fully-qualified ref name, e.g. `refs/heads/main` or `refs/tags/v1`. */
  readonly name: string;
  /** 40-hex commit SHA the ref points at. */
  readonly sha: string;
}

export interface RefsDoc {
  readonly refs: readonly RefRecord[];
  /** Default branch SHORT name (e.g. `main`), used to synthesize HEAD. */
  readonly defaultBranch: string | null;
}

const EMPTY: RefsDoc = { refs: [], defaultBranch: null };

function refsKey(repo: string): string {
  return `git/v2/refs/${repo}.json`;
}

function isValidRepoName(repo: string): boolean {
  return /^[a-zA-Z0-9._-]+(\/[a-zA-Z0-9._-]+)?$/.test(repo) && !repo.includes("..");
}

export async function readRepoRefs(
  bucket: ObjectStoreBinding,
  repo: string,
): Promise<RefsDoc> {
  if (!isValidRepoName(repo)) return EMPTY;
  const object = await bucket.get(refsKey(repo));
  if (!object) return EMPTY;
  try {
    const text = new TextDecoder().decode(new Uint8Array(await object.arrayBuffer()));
    const parsed = JSON.parse(text) as Partial<RefsDoc>;
    const refs = Array.isArray(parsed.refs)
      ? parsed.refs.filter(
          (ref): ref is RefRecord =>
            !!ref &&
            typeof ref.name === "string" &&
            /^[0-9a-f]{40}$/.test((ref as RefRecord).sha ?? ""),
        )
      : [];
    return {
      refs,
      defaultBranch: typeof parsed.defaultBranch === "string" ? parsed.defaultBranch : null,
    };
  } catch {
    return EMPTY;
  }
}

export async function writeRepoRefs(
  bucket: ObjectStoreBinding,
  repo: string,
  doc: RefsDoc,
): Promise<void> {
  if (!isValidRepoName(repo)) throw new Error(`invalid repo name: ${repo}`);
  await bucket.put(refsKey(repo), new TextEncoder().encode(JSON.stringify(doc)));
}

export { isValidRepoName };
