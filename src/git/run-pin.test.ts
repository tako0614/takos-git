import { describe, expect, test } from "bun:test";

import { MemoryBucket } from "../test-bucket.ts";
import {
  isRunPinRefName,
  pinRunCommit,
  readRunPin,
  runPinRefName,
  unpinRun,
} from "./refs-store.ts";

const REPO = "acme/web";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

describe("run-pin CAS store", () => {
  test("ref name helpers", () => {
    expect(runPinRefName("run123")).toBe("refs/takos-actions/run123");
    expect(isRunPinRefName("refs/takos-actions/run123")).toBe(true);
    expect(isRunPinRefName("refs/heads/main")).toBe(false);
  });

  test("pin then read returns the pinned commit; unpinned is null", async () => {
    const bucket = new MemoryBucket();
    expect(await readRunPin(bucket, REPO, "run1")).toBe(null);
    await pinRunCommit(bucket, REPO, "run1", SHA_A);
    expect(await readRunPin(bucket, REPO, "run1")).toBe(SHA_A);
  });

  test("pinning is idempotent and multiple runs coexist in one doc", async () => {
    const bucket = new MemoryBucket();
    await pinRunCommit(bucket, REPO, "run1", SHA_A);
    await pinRunCommit(bucket, REPO, "run1", SHA_A); // idempotent no-op
    await pinRunCommit(bucket, REPO, "run2", SHA_B);
    expect(await readRunPin(bucket, REPO, "run1")).toBe(SHA_A);
    expect(await readRunPin(bucket, REPO, "run2")).toBe(SHA_B);
  });

  test("unpin removes only the target run's pin", async () => {
    const bucket = new MemoryBucket();
    await pinRunCommit(bucket, REPO, "run1", SHA_A);
    await pinRunCommit(bucket, REPO, "run2", SHA_B);
    await unpinRun(bucket, REPO, "run1");
    expect(await readRunPin(bucket, REPO, "run1")).toBe(null);
    expect(await readRunPin(bucket, REPO, "run2")).toBe(SHA_B);
  });

  test("pins live OFF the git refs doc (separate document key)", async () => {
    const bucket = new MemoryBucket();
    await pinRunCommit(bucket, REPO, "run1", SHA_A);
    // The git-visible refs doc is never written by pinning.
    expect(bucket.store.has(`git/v2/refs/${REPO}.json`)).toBe(false);
    expect(bucket.store.has(`git/v2/actions-pins/${REPO}.json`)).toBe(true);
  });

  test("rejects a malformed commit sha", async () => {
    const bucket = new MemoryBucket();
    await expect(pinRunCommit(bucket, REPO, "run1", "not-a-sha")).rejects.toThrow();
  });
});
