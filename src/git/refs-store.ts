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
const REFS_PREFIX = "git/v2/refs/";

export interface RefsSnapshot {
  readonly doc: RefsDoc;
  readonly etag: string;
}

function refsKey(repo: string): string {
  return `${REFS_PREFIX}${repo}.json`;
}

function isValidRepoName(repo: string): boolean {
  return /^[a-zA-Z0-9._-]+(\/[a-zA-Z0-9._-]+)?$/.test(repo) && !repo.includes("..");
}

function isValidRefName(name: string): boolean {
  if (!name.startsWith("refs/heads/") && !name.startsWith("refs/tags/")) return false;
  if (name.length > 1024 || name.endsWith("/") || name.endsWith(".")) return false;
  if (name.includes("..") || name.includes("@{") || name.includes("//")) return false;
  if (/[][\\ ~^:?*\x00-\x1f\x7f]/.test(name)) return false;
  return name.split("/").every(
    (part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"),
  );
}

export async function readRepoRefs(
  bucket: ObjectStoreBinding,
  repo: string,
): Promise<RefsDoc> {
  return (await readRepoRefsSnapshot(bucket, repo))?.doc ?? EMPTY;
}

export async function readRepoRefsSnapshot(
  bucket: ObjectStoreBinding,
  repo: string,
): Promise<RefsSnapshot | null> {
  if (!isValidRepoName(repo)) return null;
  const object = await bucket.get(refsKey(repo));
  if (!object) return null;
  try {
    const text = new TextDecoder().decode(new Uint8Array(await object.arrayBuffer()));
    const parsed = JSON.parse(text) as Partial<RefsDoc>;
    if (!Array.isArray(parsed.refs)) throw new Error("refs must be an array");
    const refs = parsed.refs.map((ref) => {
      if (
        !ref ||
        typeof ref.name !== "string" ||
        !isValidRefName(ref.name) ||
        !/^[0-9a-f]{40}$/.test((ref as RefRecord).sha ?? "")
      ) {
        throw new Error("invalid ref record");
      }
      return ref as RefRecord;
    });
    if (
      parsed.defaultBranch !== undefined &&
      parsed.defaultBranch !== null &&
      typeof parsed.defaultBranch !== "string"
    ) {
      throw new Error("defaultBranch must be a string or null");
    }
    return {
      doc: {
        refs,
        defaultBranch: typeof parsed.defaultBranch === "string" ? parsed.defaultBranch : null,
      },
      etag: object.etag,
    };
  } catch (error) {
    throw new Error(
      `invalid refs document for ${repo}`,
      { cause: error },
    );
  }
}

export async function writeRepoRefs(
  bucket: ObjectStoreBinding,
  repo: string,
  doc: RefsDoc,
  expectedEtag?: string,
): Promise<boolean> {
  if (!isValidRepoName(repo)) throw new Error(`invalid repo name: ${repo}`);
  const written = await bucket.put(
    refsKey(repo),
    new TextEncoder().encode(JSON.stringify(doc)),
    expectedEtag === undefined
      ? undefined
      : { onlyIf: { etagMatches: expectedEtag } },
  );
  return written !== null;
}

export async function repoExists(
  bucket: ObjectStoreBinding,
  repo: string,
): Promise<boolean> {
  if (!isValidRepoName(repo)) return false;
  return (await bucket.head(refsKey(repo))) !== null;
}

export async function createRepo(
  bucket: ObjectStoreBinding,
  repo: string,
): Promise<boolean> {
  if (!isValidRepoName(repo)) throw new Error(`invalid repo name: ${repo}`);
  const written = await bucket.put(
    refsKey(repo),
    new TextEncoder().encode(JSON.stringify(EMPTY)),
    { onlyIf: { etagDoesNotMatch: "*" } },
  );
  return written !== null;
}

export async function deleteRepo(
  bucket: ObjectStoreBinding,
  repo: string,
): Promise<boolean> {
  if (!isValidRepoName(repo)) throw new Error(`invalid repo name: ${repo}`);
  if (!(await repoExists(bucket, repo))) return false;
  await bucket.delete(refsKey(repo));
  return true;
}

export interface RepoListPage {
  readonly repos: readonly string[];
  readonly cursor: string | null;
}

export async function listRepos(
  bucket: ObjectStoreBinding,
  options: { prefix?: string; cursor?: string; limit?: number } = {},
): Promise<RepoListPage> {
  const prefix = options.prefix ?? "";
  const page = await bucket.list({
    prefix: `${REFS_PREFIX}${prefix}`,
    ...(options.cursor ? { cursor: options.cursor } : {}),
    limit: Math.max(1, Math.min(options.limit ?? 100, 100)),
  });
  const repos = page.objects.flatMap(({ key }) => {
    if (!key.startsWith(REFS_PREFIX) || !key.endsWith(".json")) return [];
    const repo = key.slice(REFS_PREFIX.length, -".json".length);
    return isValidRepoName(repo) ? [repo] : [];
  });
  return { repos, cursor: page.truncated ? (page.cursor ?? null) : null };
}

export { isValidRefName, isValidRepoName };
