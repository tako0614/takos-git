import { describe, expect, test } from "bun:test";

import { MemoryBucket } from "../test-bucket.ts";
import { seedRepo } from "../seed.ts";
import {
  readRepoRefsSnapshot,
  writeRepoRefs,
  type RefsDoc,
} from "./refs-store.ts";
import { revalidateRefPointer, writeRefsWithMetadata } from "./two-phase.ts";

const REPO = "acme/web";
const FORCED_SHA = "b".repeat(40);

function mainDoc(sha: string): RefsDoc {
  return { refs: [{ name: "refs/heads/main", sha }], defaultBranch: "main" };
}

describe("two-phase — R2 is authoritative, D1 pointers are advisory", () => {
  test("a D1 ref pointer that disagrees with R2 is detected, not trusted", async () => {
    const bucket = new MemoryBucket();
    const seeded = await seedRepo(bucket, { repo: REPO, content: "a\n" });

    // Fresh: the D1 projection still agrees with R2.
    const fresh = await revalidateRefPointer(
      bucket,
      REPO,
      "refs/heads/main",
      seeded.commitSha,
    );
    expect(fresh.fresh).toBe(true);
    expect(fresh.r2Sha).toBe(seeded.commitSha);

    // Force-push moves the authoritative tip in R2; the old D1 pointer is now stale.
    await writeRepoRefs(bucket, REPO, mainDoc(FORCED_SHA));
    const stale = await revalidateRefPointer(
      bucket,
      REPO,
      "refs/heads/main",
      seeded.commitSha,
    );
    expect(stale.fresh).toBe(false); // detected, not trusted
    expect(stale.r2Sha).toBe(FORCED_SHA); // R2 wins
  });
});

describe("two-phase — ETag CAS commit point", () => {
  test("commits the R2 ref then projects D1 metadata", async () => {
    const bucket = new MemoryBucket();
    await seedRepo(bucket, { repo: REPO, content: "a\n" });

    let projected: RefsDoc | null = null;
    const result = await writeRefsWithMetadata(bucket, {
      repo: REPO,
      mutateRefs: () => mainDoc(FORCED_SHA),
      projectMetadata: async (committed) => {
        projected = committed.refs;
      },
    });

    expect(result.status).toBe("committed");
    expect(projected).not.toBeNull();
    const after = await readRepoRefsSnapshot(bucket, REPO);
    expect(after?.doc.refs[0]?.sha).toBe(FORCED_SHA);
  });

  test("a concurrent writer racing the same ref loses the CAS (409-style conflict)", async () => {
    const bucket = new MemoryBucket();
    const seeded = await seedRepo(bucket, { repo: REPO, content: "a\n" });

    const result = await writeRefsWithMetadata(bucket, {
      repo: REPO,
      mutateRefs: async () => {
        // A concurrent push lands FIRST, consuming the current ETag.
        const snapshot = await readRepoRefsSnapshot(bucket, REPO);
        await writeRepoRefs(bucket, REPO, mainDoc(FORCED_SHA), snapshot!.etag);
        // Our update, derived from the now-stale snapshot, must lose the CAS.
        return mainDoc("c".repeat(40));
      },
    });

    expect(result.status).toBe("conflict");
    if (result.status === "conflict") {
      expect(result.current.refs[0]?.sha).toBe(FORCED_SHA);
    }
    // The authoritative tip is the concurrent writer's, not ours.
    const after = await readRepoRefsSnapshot(bucket, REPO);
    expect(after?.doc.refs[0]?.sha).toBe(FORCED_SHA);
    expect(seeded.commitSha).not.toBe(FORCED_SHA);
  });

  test("a D1 projection failure never rolls back the committed R2 ref", async () => {
    const bucket = new MemoryBucket();
    await seedRepo(bucket, { repo: REPO, content: "a\n" });

    const result = await writeRefsWithMetadata(bucket, {
      repo: REPO,
      mutateRefs: () => mainDoc(FORCED_SHA),
      projectMetadata: async () => {
        throw new Error("D1 unavailable");
      },
    });

    expect(result.status).toBe("committed");
    if (result.status === "committed") {
      expect(result.metadataDeferred).toBeInstanceOf(Error);
    }
    const after = await readRepoRefsSnapshot(bucket, REPO);
    expect(after?.doc.refs[0]?.sha).toBe(FORCED_SHA); // R2 stayed committed
  });

  test("advancing a repo with no refs doc reports absent", async () => {
    const bucket = new MemoryBucket();
    const result = await writeRefsWithMetadata(bucket, {
      repo: "ghost/repo",
      mutateRefs: () => mainDoc(FORCED_SHA),
    });
    expect(result.status).toBe("absent");
  });
});
