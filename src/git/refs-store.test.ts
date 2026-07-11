import { expect, test } from "bun:test";

import { MemoryBucket } from "../test-bucket.ts";
import {
  createRepo,
  readRepoRefs,
  readRepoRefsSnapshot,
  writeRepoRefs,
} from "./refs-store.ts";

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
  await bucket.put(`git/v2/refs/${REPO}.json`, "{\"refs\":\"broken\"}");
  expect(readRepoRefs(bucket, REPO)).rejects.toThrow("invalid refs document");
});
