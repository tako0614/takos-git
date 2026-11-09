import { expect, test } from "bun:test";

import { MemoryBucket } from "../test-bucket.ts";
import {
  createRepo,
  deleteRepo,
  readRepoRefs,
  readRepoRefsSnapshot,
  writeRepoRefs,
  writeRepoRefsSnapshot,
} from "./refs-store.ts";
import { repositoryObjectStore } from "./repo-object-store.ts";

const REPO = "space_test/project";

test("snapshot writes return their own receipt and reject a stale ETag", async () => {
  const bucket = new MemoryBucket();
  expect(await createRepo(bucket, REPO)).toBe(true);
  const before = await readRepoRefsSnapshot(bucket, REPO);
  const doc = {
    refs: [{ name: "refs/heads/main", sha: "1".repeat(40) }],
    defaultBranch: "main",
  };

  const written = await writeRepoRefsSnapshot(bucket, REPO, doc, before!.etag);

  expect(written).not.toBeNull();
  expect(written?.doc).toEqual(doc);
  expect(written?.etag).toBe((await readRepoRefsSnapshot(bucket, REPO))?.etag);
  expect(written?.etag).not.toBe(before!.etag);
  expect(await writeRepoRefsSnapshot(
    bucket,
    REPO,
    { refs: [], defaultBranch: null },
    before!.etag,
  )).toBeNull();
  expect(await readRepoRefsSnapshot(bucket, REPO)).toEqual(written);
});

test("repository creation and ref replacement use R2 conditional writes", async () => {
  const bucket = new MemoryBucket();
  expect(await createRepo(bucket, REPO)).toBe(true);
  expect(await createRepo(bucket, REPO)).toBe(false);

  const first = await readRepoRefsSnapshot(bucket, REPO);
  const stale = await readRepoRefsSnapshot(bucket, REPO);
  expect(first).not.toBeNull();
  expect(stale).not.toBeNull();

  const firstDoc = {
    refs: [{ name: "refs/heads/main", sha: "1".repeat(40) }],
    defaultBranch: "main",
  } as const;
  const staleDoc = {
    refs: [{ name: "refs/heads/main", sha: "2".repeat(40) }],
    defaultBranch: "main",
  } as const;

  expect(await writeRepoRefs(bucket, REPO, firstDoc, first!.etag)).toBe(true);
  expect(await writeRepoRefs(bucket, REPO, staleDoc, stale!.etag)).toBe(false);
  expect(await readRepoRefs(bucket, REPO)).toEqual(firstDoc);
});

test("a corrupt refs document fails closed", async () => {
  const bucket = new MemoryBucket();
  await bucket.put(`git/v2/refs/${REPO}.json`, '{"refs":"broken"}');
  expect(readRepoRefs(bucket, REPO)).rejects.toThrow("invalid refs document");
});

test("pending merge receipts reject corrupt or unbounded durable state", async () => {
  const bucket = new MemoryBucket();
  const receipt = { repoId: "repo", issueId: "issue", actorId: "actor", baseRef: "main", headRef: "feature",
    baseSha: "a".repeat(40), headSha: "b".repeat(40), commitSha: "c".repeat(40), method: "squash", at: 1, advanced: true };
  for (const pendingMerges of [null, [], { pr: { ...receipt, commitSha: "invalid" } },
    { pr: { ...receipt, baseRef: "../other" } }, { pr: { ...receipt, method: "unknown" } },
    Object.fromEntries(Array.from({ length: 129 }, (_, i) => [String(i), receipt]))]) {
    await bucket.put(`git/v2/refs/${REPO}.json`, JSON.stringify({ refs: [], defaultBranch: null, pendingMerges }));
    await expect(readRepoRefs(bucket, REPO)).rejects.toThrow("invalid refs document");
  }
  const valid = { refs: [], defaultBranch: null, pendingMerges: { pr: receipt } };
  await bucket.put(`git/v2/refs/${REPO}.json`, JSON.stringify(valid));
  expect(await readRepoRefs(bucket, REPO)).toEqual(valid);
});

test("repository deletion removes only that repository's object namespace", async () => {
  const bucket = new MemoryBucket();
  const otherRepo = "space_test/other";
  expect(await createRepo(bucket, REPO)).toBe(true);
  expect(await createRepo(bucket, otherRepo)).toBe(true);
  await repositoryObjectStore(bucket, REPO).put("objects/aa/one", "one");
  await repositoryObjectStore(bucket, otherRepo).put("objects/bb/two", "two");

  expect(await deleteRepo(bucket, REPO)).toBe(true);
  expect(await readRepoRefsSnapshot(bucket, REPO)).toBeNull();
  expect(
    [...bucket.store.keys()].some((key) =>
      key.startsWith(`git/v3/repos/${REPO}/`),
    ),
  ).toBe(false);
  expect(await readRepoRefsSnapshot(bucket, otherRepo)).not.toBeNull();
  expect(
    [...bucket.store.keys()].some((key) =>
      key.startsWith(`git/v3/repos/${otherRepo}/`),
    ),
  ).toBe(true);
});
