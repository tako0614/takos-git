import { describe, expect, test } from "bun:test";

import { handleReceivePack } from "./smart-http.ts";
import { MemoryBucket } from "./test-bucket.ts";
import { seedRepo } from "./seed.ts";
import { concatBytes } from "./git/sha1.ts";
import { PKT_FLUSH, pktLineString } from "./git/pack-common.ts";
import { readRepoRefsSnapshot, writeRepoRefs } from "./git/refs-store.ts";

const REPO = "acme/delete-refs";
const ZERO = "0".repeat(40);
const TOPIC = "refs/heads/topic";
const TAG = "refs/tags/v1.0.0";

async function setup() {
  const bucket = new MemoryBucket();
  const { commitSha } = await seedRepo(bucket, { repo: REPO, content: "keep main\n" });
  const initial = (await readRepoRefsSnapshot(bucket, REPO))!;
  expect(await writeRepoRefs(bucket, REPO, {
    ...initial.doc,
    refs: [...initial.doc.refs, { name: TOPIC, sha: commitSha }, { name: TAG, sha: commitSha }],
  }, initial.etag)).not.toBeNull();
  return { bucket, commitSha };
}

function deletion(sha: string, capabilities = "report-status atomic") {
  // delete-refs is a server advertisement, not a client-selected capability.
  return concatBytes(
    pktLineString(`${sha} ${ZERO} ${TOPIC}\0${capabilities}\n`),
    pktLineString(`${sha} ${ZERO} ${TAG}\n`),
    PKT_FLUSH,
  );
}

function stored(bucket: MemoryBucket) {
  return [...bucket.store].map(([key, bytes]) => [key, [...bytes], bucket.etags.get(key)]);
}

describe("receive-pack deletes without echoing the server's delete-refs advertisement", () => {
  test("deletes a branch and tag atomically while preserving main and objects", async () => {
    const { bucket, commitSha } = await setup();
    const before = (await readRepoRefsSnapshot(bucket, REPO))!;
    const objectBytes = [...bucket.store].filter(([key]) => !key.startsWith("git/v2/refs/"));
    const authorized: string[] = [];
    let applied = 0;
    const response = await handleReceivePack(bucket, REPO, deletion(commitSha), {
      authorizeRef: (command) => { authorized.push(command.name); return true; },
      onApplied: (commands) => {
        expect(commands.map(command => [command.name, command.newSha])).toEqual([[TOPIC, ZERO], [TAG, ZERO]]);
        applied++;
      },
    });
    const status = await response.text();
    expect(status).toContain(`ok ${TOPIC}\n`);
    expect(status).toContain(`ok ${TAG}\n`);
    expect(status).not.toContain("ng ");
    expect(authorized).toEqual([TOPIC, TAG]);
    expect(applied).toBe(1);
    const after = (await readRepoRefsSnapshot(bucket, REPO))!;
    expect(after.doc.refs).toEqual([{ name: "refs/heads/main", sha: commitSha }]);
    expect(after.doc.defaultBranch).toBe("main");
    expect(after.etag).not.toBe(before.etag);
    expect([...bucket.store].filter(([key]) => !key.startsWith("git/v2/refs/"))).toEqual(objectBytes);
  });

  test("one protected ref rejects the entire deletion without effects", async () => {
    const { bucket, commitSha } = await setup();
    const before = stored(bucket);
    const authorized: string[] = [];
    let applied = 0;
    const response = await handleReceivePack(bucket, REPO, deletion(commitSha), {
      authorizeRef: command => { authorized.push(command.name); return command.name !== TAG; },
      onApplied: () => { applied++; },
    });
    expect(await response.text()).toContain(`protected ref: ${TAG}`);
    expect(authorized).toEqual([TOPIC, TAG]);
    expect(applied).toBe(0);
    expect(stored(bucket)).toEqual(before);
  });

  test("a stale old SHA still rejects deletion before authorization or writes", async () => {
    const { bucket } = await setup();
    const before = stored(bucket);
    let authorized = 0, applied = 0;
    const response = await handleReceivePack(bucket, REPO, deletion("f".repeat(40)), {
      authorizeRef: () => { authorized++; return true; },
      onApplied: () => { applied++; },
    });
    expect(await response.text()).toContain("stale ref value");
    expect(authorized).toBe(0);
    expect(applied).toBe(0);
    expect(stored(bucket)).toEqual(before);
  });

  test("a concurrent writer wins the refs CAS and neither requested ref is deleted", async () => {
    const { bucket, commitSha } = await setup();
    let concurrent: ReturnType<typeof stored> | undefined;
    let applied = 0;
    const response = await handleReceivePack(bucket, REPO, deletion(commitSha), {
      authorizeRef: async (command) => {
        if (command.name === TAG) {
          const current = (await readRepoRefsSnapshot(bucket, REPO))!;
          expect(await writeRepoRefs(bucket, REPO, {
            ...current.doc,
            refs: [...current.doc.refs, { name: "refs/heads/other", sha: commitSha }],
          }, current.etag)).not.toBeNull();
          concurrent = stored(bucket);
        }
        return true;
      },
      onApplied: () => { applied++; },
    });
    expect(await response.text()).toContain("concurrent ref update");
    expect(concurrent).toBeDefined();
    expect(stored(bucket)).toEqual(concurrent!);
    expect(applied).toBe(0);
    expect((await readRepoRefsSnapshot(bucket, REPO))!.doc.refs.map(ref => ref.name)).toContain(TOPIC);
    expect((await readRepoRefsSnapshot(bucket, REPO))!.doc.refs.map(ref => ref.name)).toContain(TAG);
  });

  test("report-status remains required before any deletion effect", async () => {
    const { bucket, commitSha } = await setup();
    const before = stored(bucket);
    let authorized = 0, applied = 0;
    const response = await handleReceivePack(bucket, REPO, deletion(commitSha, "atomic"), {
      authorizeRef: () => { authorized++; return true; },
      onApplied: () => { applied++; },
    });
    expect(await response.text()).toContain("report-status capability required");
    expect(authorized).toBe(0);
    expect(applied).toBe(0);
    expect(stored(bucket)).toEqual(before);
  });
});
