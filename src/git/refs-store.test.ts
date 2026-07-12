import { expect, test } from "bun:test";

import { MemoryBucket } from "../test-bucket.ts";
import {
  createRepo,
  deleteRepo,
  readRepoRefs,
  readRepoRefsSnapshot,
  writeRepoRefs,
} from "./refs-store.ts";
import { repositoryObjectStore } from "./repo-object-store.ts";

const REPO = "space_test/project";

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
