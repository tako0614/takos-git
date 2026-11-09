import { describe, expect, test } from "bun:test";

import { MemoryBucket } from "../test-bucket.ts";
import { seedRepo } from "../seed.ts";
import {
  readRepoRefsSnapshot,
  writeRepoRefs,
  type RefsDoc,
} from "./refs-store.ts";
import { revalidateRefPointer, writeRefsWithMetadata } from "./two-phase.ts";
import type { ObjectStoreObjectHead } from "./types.ts";

const REPO = "acme/web";
const FORCED_SHA = "b".repeat(40);

function mainDoc(sha: string): RefsDoc {
  return { refs: [{ name: "refs/heads/main", sha }], defaultBranch: "main" };
}

class ObservedBucket extends MemoryBucket {
  afterPut?: (receipt: ObjectStoreObjectHead) => void | Promise<void>;
  failReads = false;

  override async put(...args: Parameters<MemoryBucket["put"]>) {
    const receipt = await super.put(...args);
    if (receipt && this.afterPut) {
      const observe = this.afterPut;
      this.afterPut = undefined;
      await observe(receipt);
    }
    return receipt;
  }

  override async get(key: string) {
    if (this.failReads) throw new Error("post-commit read unavailable");
    return super.get(key);
  }
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
  test("binds the result and projection to its own write before a later writer", async () => {
    const bucket = new ObservedBucket();
    await seedRepo(bucket, { repo: REPO, content: "initial\n" });
    const first = mainDoc("a".repeat(40));
    const later = mainDoc("b".repeat(40));
    let actualReceipt: ObjectStoreObjectHead | undefined;
    let projected: unknown;
    bucket.afterPut = async (receipt) => {
      actualReceipt = receipt;
      const concurrent = await writeRefsWithMetadata(bucket, {
        repo: REPO,
        mutateRefs: () => later,
      });
      expect(concurrent.status).toBe("committed");
    };

    const result = await writeRefsWithMetadata(bucket, {
      repo: REPO,
      mutateRefs: () => first,
      projectMetadata: async (committed) => {
        projected = committed;
      },
    });

    expect(result.status).toBe("committed");
    if (result.status !== "committed") throw new Error("write did not commit");
    expect(result.refs).toEqual(first);
    expect(result.etag).toBe(actualReceipt!.etag);
    expect(projected).toEqual({ refs: first, etag: actualReceipt!.etag });
    expect((await readRepoRefsSnapshot(bucket, REPO))?.doc).toEqual(later);
  });

  test("a post-commit GET failure cannot hide an acknowledged write", async () => {
    const bucket = new ObservedBucket();
    await seedRepo(bucket, { repo: REPO, content: "initial\n" });
    const next = mainDoc(FORCED_SHA);
    let actualReceipt: ObjectStoreObjectHead | undefined;
    let projected = 0;
    bucket.afterPut = (receipt) => {
      actualReceipt = receipt;
      bucket.failReads = true;
    };

    const result = await writeRefsWithMetadata(bucket, {
      repo: REPO,
      mutateRefs: () => next,
      projectMetadata: async () => {
        projected++;
      },
    });

    expect(result.status).toBe("committed");
    if (result.status !== "committed") throw new Error("write did not commit");
    expect(result.refs).toEqual(next);
    expect(result.etag).toBe(actualReceipt!.etag);
    expect(projected).toBe(1);
    bucket.failReads = false;
    expect((await readRepoRefsSnapshot(bucket, REPO))?.doc).toEqual(next);
  });

  test("retains the serialized write when the caller changes its draft in flight", async () => {
    const bucket = new ObservedBucket();
    await seedRepo(bucket, { repo: REPO, content: "initial\n" });
    const draft = {
      refs: [{ name: "refs/heads/main", sha: FORCED_SHA }],
      defaultBranch: "main",
    };
    const written = structuredClone(draft);
    bucket.afterPut = () => {
      draft.refs[0].sha = "c".repeat(40);
    };

    const result = await writeRefsWithMetadata(bucket, {
      repo: REPO,
      mutateRefs: () => draft,
    });

    expect(result.status).toBe("committed");
    if (result.status !== "committed") throw new Error("write did not commit");
    expect(result.refs).toEqual(written);
    expect((await readRepoRefsSnapshot(bucket, REPO))?.doc).toEqual(written);
    expect(draft).not.toEqual(written);
  });

  test("a lost put acknowledgement remains unknown and does not project metadata", async () => {
    const bucket = new ObservedBucket();
    await seedRepo(bucket, { repo: REPO, content: "initial\n" });
    const error = new Error("put acknowledgement lost");
    let projected = 0;
    bucket.afterPut = () => {
      throw error;
    };

    await expect(writeRefsWithMetadata(bucket, {
      repo: REPO,
      mutateRefs: () => mainDoc(FORCED_SHA),
      projectMetadata: async () => {
        projected++;
      },
    })).rejects.toBe(error);

    expect(projected).toBe(0);
    expect((await readRepoRefsSnapshot(bucket, REPO))?.doc).toEqual(
      mainDoc(FORCED_SHA),
    );
  });

  test("an aborted mutation performs no write or metadata projection", async () => {
    const bucket = new ObservedBucket();
    await seedRepo(bucket, { repo: REPO, content: "initial\n" });
    const before = await readRepoRefsSnapshot(bucket, REPO);
    let puts = 0;
    let projected = 0;
    bucket.afterPut = () => {
      puts++;
    };

    const result = await writeRefsWithMetadata(bucket, {
      repo: REPO,
      mutateRefs: () => null,
      projectMetadata: async () => {
        projected++;
      },
    });

    expect(result.status).toBe("aborted");
    expect(puts).toBe(0);
    expect(projected).toBe(0);
    expect(await readRepoRefsSnapshot(bucket, REPO)).toEqual(before);
  });

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
