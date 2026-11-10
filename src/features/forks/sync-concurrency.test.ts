import { afterEach, describe, expect, test } from "bun:test";

import { SCOPES } from "../../contract/v1.ts";
import { putCommit } from "../../git/object-store.ts";
import { repositoryObjectStore } from "../../git/repo-object-store.ts";
import { readRepoRefs, readRepoRefsSnapshot, writeRepoRefs, type RefsDoc } from "../../git/refs-store.ts";
import { createSingleFileTree } from "../../git/tree-ops.ts";
import type { ObjectStoreBinding } from "../../git/types.ts";
import { RouteRegistry } from "../../router.ts";
import { interfaceUserInfoFetch, jsonRequest, makeEnv, seedFullRepo } from "../repos/testkit.ts";
import { setForkEventSink, type ForkEvent } from "./events.ts";
import { registerForkRoutes } from "./routes.ts";

const FORK = "devuser/web";
const FORK_REFS = `git/v2/refs/${FORK}.json`;
const userInfo = interfaceUserInfoFetch({
  taksrv_fork_read: { subject: "fork-writer", scope: SCOPES.hostingRead },
  taksrv_fork_write: { subject: "fork-writer", scope: SCOPES.smartHttpWrite },
});

afterEach(() => setForkEventSink(null));

async function fixture() {
  const handle = makeEnv();
  const registry = new RouteRegistry();
  registerForkRoutes(registry);
  const request = async (method: string, path: string, body: unknown, token: string) => {
    const response = await registry.handle({
      request: jsonRequest(method, path, body, token), env: handle.env,
      interfaceUserInfoFetch: userInfo,
    });
    if (!response) throw Error("missing fork route");
    return response;
  };
  const source = await seedFullRepo(handle, { ownerLogin: "upstream", name: "web", visibility: "public" });
  expect((await request("POST", "/api/v1/repos/upstream/web/forks", { owner: "devuser" }, "taksrv_fork_read")).status).toBe(201);

  const commit = async (repo: string, body: string) => {
    const store = repositoryObjectStore(handle.bucket, repo);
    const tree = await createSingleFileTree(store, "README.md", new TextEncoder().encode(body));
    const signature = { name: "Writer", email: "writer@example.test", timestamp: 1_700_000_100, tzOffset: "+0000" };
    return putCommit(store, { tree, parents: [source.commitSha], author: signature, committer: signature, message: body });
  };
  const upstreamTip = await commit(source.storageKey, "upstream change\n");
  const concurrentTip = await commit(FORK, "independent fork change\n");
  await writeRepoRefs(handle.bucket, source.storageKey, {
    refs: [{ name: "refs/heads/main", sha: upstreamTip }], defaultBranch: "main",
  });
  const projection = () => handle.db.query(
    `SELECT i.name, i.target_sha, i.is_default, f.last_synced_at FROM ref_index i
       JOIN repo_forks f ON f.fork_repo_id = i.repo_id ORDER BY i.name`, [],
  );
  const beforeProjection = await projection();
  const events: ForkEvent[] = [];
  setForkEventSink(event => { events.push(event); });
  const sync = () => request("POST", `/api/v1/repos/${FORK}/sync`, { branch: "main" }, "taksrv_fork_write");

  // Interleave a real refs writer at the store boundary, not a replacement sync model.
  // Explicit branch keeps these reads to initial FF input and the helper's CAS snapshot.
  function interleave(change: (current: RefsDoc) => RefsDoc, phase: "read" | "put" = "read") {
    let reads = 0, injected = 0;
    let expected: Awaited<ReturnType<typeof readRepoRefsSnapshot>> = null;
    const inject = async () => {
      injected++;
      await writeRepoRefs(handle.bucket, FORK, change(await readRepoRefs(handle.bucket, FORK)));
      expected = await readRepoRefsSnapshot(handle.bucket, FORK);
    };
    const bucket: ObjectStoreBinding = {
      get: async key => {
        if (key === FORK_REFS && ++reads === 2 && phase === "read") await inject();
        return handle.bucket.get(key);
      },
      head: key => handle.bucket.head(key),
      put: async (key, value, options) => {
        if (key === FORK_REFS && phase === "put" && injected === 0) await inject();
        return handle.bucket.put(key, value, options);
      },
      delete: key => handle.bucket.delete(key),
      list: options => handle.bucket.list(options),
    };
    handle.env.BUCKET = bucket;
    return { count: () => injected, expected: () => expected };
  }
  return { handle, source, upstreamTip, concurrentTip, beforeProjection, projection, events, sync, interleave };
}

describe("fork sync protects the checked branch until commit", () => {
  for (const kind of ["advance", "delete", "create"] as const) {
    test(`rejects a concurrent selected-branch ${kind} before the CAS snapshot`, async () => {
      const f = await fixture();
      if (kind === "create") await writeRepoRefs(f.handle.bucket, FORK, { refs: [], defaultBranch: null });
      const race = f.interleave(current => ({
        ...current,
        refs: kind === "delete" ? [] : [{ name: "refs/heads/main", sha: f.concurrentTip }],
        defaultBranch: kind === "delete" ? null : "main",
      }));
      const response = await f.sync();
      const body = await response.json();
      const final = await readRepoRefsSnapshot(f.handle.bucket, FORK);
      expect(race.count()).toBe(1);
      expect({
        status: response.status, body,
        selectedWriterReceiptPreserved: JSON.stringify(final) === JSON.stringify(race.expected()),
        projectionPreserved: JSON.stringify(await f.projection()) === JSON.stringify(f.beforeProjection),
        syncEvents: f.events.length,
      }).toMatchObject({
        status: 409, body: { error: { code: "conflict" } },
        selectedWriterReceiptPreserved: true, projectionPreserved: true, syncEvents: 0,
      });
      if (kind === "advance") {
        const retry = await f.sync();
        expect(retry.status).toBe(409);
        expect(await retry.json()).toMatchObject({ error: { code: "diverged" } });
        expect(await readRepoRefsSnapshot(f.handle.bucket, FORK)).toEqual(race.expected());
        expect(await f.projection()).toEqual(f.beforeProjection);
        expect(f.events).toEqual([]);
      }
    });
  }

  test("preserves unrelated branch and default changes while syncing the checked branch", async () => {
    const f = await fixture();
    const race = f.interleave(current => ({
      ...current,
      refs: [...current.refs, { name: "refs/heads/topic", sha: f.concurrentTip }], defaultBranch: "topic",
    }));
    const response = await f.sync();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ previousHead: f.source.commitSha, newHead: f.upstreamTip });
    expect(race.count()).toBe(1);
    expect(await readRepoRefs(f.handle.bucket, FORK)).toEqual({
      refs: [{ name: "refs/heads/topic", sha: f.concurrentTip }, { name: "refs/heads/main", sha: f.upstreamTip }], defaultBranch: "topic",
    });
    expect(f.events).toHaveLength(1);
    expect(f.events[0]?.payload).toMatchObject({ before: f.source.commitSha, after: f.upstreamTip });
  });

  test("keeps the original ETag conflict when a writer wins after the CAS snapshot", async () => {
    const f = await fixture();
    const race = f.interleave(current => ({ ...current, refs: [{ name: "refs/heads/main", sha: f.concurrentTip }] }), "put");
    const response = await f.sync();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "conflict" } });
    expect(race.count()).toBe(1);
    expect(await readRepoRefsSnapshot(f.handle.bucket, FORK)).toEqual(race.expected());
    expect(await f.projection()).toEqual(f.beforeProjection);
    expect(f.events).toEqual([]);
  });
});
