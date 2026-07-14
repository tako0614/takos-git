/**
 * Minimal per-repo ref store, backed by a small JSON blob in the same R2
 * bucket as the objects. Replaces the takos worker's D1 refs/branches tables.
 *
 * Refs are per-repo (`git/v2/refs/<repo>.json`) and object storage is scoped by
 * repository (`git/v3/repos/<repo>/objects/...`). Repository deletion can
 * therefore remove all owned data without cross-repository reachability GC.
 */

import type { ObjectStoreBinding } from "./types.ts";
import { deleteRepositoryObjects } from "./repo-object-store.ts";

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
  return (
    /^[a-zA-Z0-9._-]+(\/[a-zA-Z0-9._-]+)?$/.test(repo) && !repo.includes("..")
  );
}

function isValidRefName(name: string): boolean {
  if (!name.startsWith("refs/heads/") && !name.startsWith("refs/tags/"))
    return false;
  if (name.length > 1024 || name.endsWith("/") || name.endsWith("."))
    return false;
  if (name.includes("..") || name.includes("@{") || name.includes("//"))
    return false;
  if (/[][\\ ~^:?*\x00-\x1f\x7f]/.test(name)) return false;
  return name
    .split("/")
    .every(
      (part) =>
        part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"),
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
    const text = new TextDecoder().decode(
      new Uint8Array(await object.arrayBuffer()),
    );
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
        defaultBranch:
          typeof parsed.defaultBranch === "string"
            ? parsed.defaultBranch
            : null,
      },
      etag: object.etag,
    };
  } catch (error) {
    throw new Error(`invalid refs document for ${repo}`, { cause: error });
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
  await deleteRepositoryObjects(bucket, repo);
  await bucket.delete(refsKey(repo));
  return true;
}

// ============================================================================
// Actions run-pin refs (internal `refs/takos-actions/<runId>`)
// ============================================================================
//
// A run pin captures the exact commit an Actions run was created against so a
// concurrent force-push to the branch can never move what the run builds. Pins
// are HIDDEN internal refs: they are kept OUT of the git-visible refs doc (so
// smart-http never advertises them and a git client can never push them) and
// live in a separate per-repo pin document written with the SAME ETag CAS
// discipline as the refs doc — a create/refresh races through `onlyIf.etagMatches`
// so two coordinators can never fork a pin. The logical pin name is
// `refs/takos-actions/<runId>`; the physical store is `git/v2/actions-pins/<repo>.json`.

const ACTIONS_PIN_PREFIX = "git/v2/actions-pins/";
const RUN_PIN_REF_PREFIX = "refs/takos-actions/";
const PIN_CAS_MAX_ATTEMPTS = 6;

/** The internal, hidden ref name a run pins its commit under. */
export function runPinRefName(runId: string): string {
  return `${RUN_PIN_REF_PREFIX}${runId}`;
}

/** True for an internal Actions run-pin ref (never advertised or client-pushable). */
export function isRunPinRefName(name: string): boolean {
  return name.startsWith(RUN_PIN_REF_PREFIX);
}

interface RunPinDoc {
  /** runId → 40-hex pinned commit SHA. */
  readonly pins: Readonly<Record<string, string>>;
}

const EMPTY_PINS: RunPinDoc = { pins: {} };

function pinKey(repo: string): string {
  return `${ACTIONS_PIN_PREFIX}${repo}.json`;
}

function isValidRunId(runId: string): boolean {
  return /^[0-9A-Za-z]{1,64}$/.test(runId);
}

async function readRunPinSnapshot(
  bucket: ObjectStoreBinding,
  repo: string,
): Promise<{ doc: RunPinDoc; etag: string | null }> {
  if (!isValidRepoName(repo)) throw new Error(`invalid repo name: ${repo}`);
  const object = await bucket.get(pinKey(repo));
  if (!object) return { doc: EMPTY_PINS, etag: null };
  try {
    const text = new TextDecoder().decode(new Uint8Array(await object.arrayBuffer()));
    const parsed = JSON.parse(text) as Partial<RunPinDoc>;
    const pins: Record<string, string> = {};
    if (parsed.pins && typeof parsed.pins === "object") {
      for (const [runId, sha] of Object.entries(parsed.pins)) {
        if (isValidRunId(runId) && typeof sha === "string" && /^[0-9a-f]{40}$/.test(sha)) {
          pins[runId] = sha;
        }
      }
    }
    return { doc: { pins }, etag: object.etag };
  } catch (error) {
    throw new Error(`invalid run-pin document for ${repo}`, { cause: error });
  }
}

/** Read a run's pinned commit SHA, or null when the run is not pinned. */
export async function readRunPin(
  bucket: ObjectStoreBinding,
  repo: string,
  runId: string,
): Promise<string | null> {
  if (!isValidRunId(runId)) return null;
  const { doc } = await readRunPinSnapshot(bucket, repo);
  return doc.pins[runId] ?? null;
}

/**
 * Idempotently pin `commitSha` for `runId` through the pin-doc ETag CAS. A pin
 * that already matches is a no-op; a lost CAS race is retried against the fresh
 * doc. Throws only when the CAS cannot converge (extreme contention).
 */
export async function pinRunCommit(
  bucket: ObjectStoreBinding,
  repo: string,
  runId: string,
  commitSha: string,
): Promise<void> {
  if (!isValidRepoName(repo)) throw new Error(`invalid repo name: ${repo}`);
  if (!isValidRunId(runId)) throw new Error(`invalid run id: ${runId}`);
  if (!/^[0-9a-f]{40}$/.test(commitSha)) throw new Error(`invalid commit sha: ${commitSha}`);
  for (let attempt = 0; attempt < PIN_CAS_MAX_ATTEMPTS; attempt += 1) {
    const { doc, etag } = await readRunPinSnapshot(bucket, repo);
    if (doc.pins[runId] === commitSha) return; // already pinned — idempotent
    const next: RunPinDoc = { pins: { ...doc.pins, [runId]: commitSha } };
    const written = await bucket.put(
      pinKey(repo),
      new TextEncoder().encode(JSON.stringify(next)),
      etag === null
        ? { onlyIf: { etagDoesNotMatch: "*" } }
        : { onlyIf: { etagMatches: etag } },
    );
    if (written !== null) return;
    // Lost the CAS race — re-read and retry.
  }
  throw new Error(`run-pin CAS did not converge for ${repo}/${runId}`);
}

/** Remove a run's pin (best-effort cleanup on run finalize). CAS-guarded. */
export async function unpinRun(
  bucket: ObjectStoreBinding,
  repo: string,
  runId: string,
): Promise<void> {
  if (!isValidRepoName(repo) || !isValidRunId(runId)) return;
  for (let attempt = 0; attempt < PIN_CAS_MAX_ATTEMPTS; attempt += 1) {
    const { doc, etag } = await readRunPinSnapshot(bucket, repo);
    if (!(runId in doc.pins)) return;
    if (etag === null) return;
    const pins = { ...doc.pins };
    delete pins[runId];
    const written = await bucket.put(
      pinKey(repo),
      new TextEncoder().encode(JSON.stringify({ pins })),
      { onlyIf: { etagMatches: etag } },
    );
    if (written !== null) return;
  }
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
