import { describe, expect, test } from "bun:test";
import { RouteRegistry } from "../../router.ts";
import { registerRepoRoutes } from "../repos/routes.ts";
import { registerPullRoutes } from "./routes.ts";
import { get, interfaceUserInfoFetch, jsonRequest, makeEnv } from "../repos/testkit.ts";
import { seedRepo } from "../../seed.ts";
import { putCommit } from "../../git/object-store.ts";
import { repositoryObjectStore } from "../../git/repo-object-store.ts";
import { readRepoRefs, writeRepoRefs } from "../../git/refs-store.ts";
import { createSingleFileTree } from "../../git/tree-ops.ts";
import type { ObjectStoreBinding } from "../../git/types.ts";

const tokens = interfaceUserInfoFetch({
  taksrv_write: { scope: "source.git.hosting.write", subject: "sub-alice" },
  taksrv_read: { scope: "source.git.hosting.read", subject: "sub-alice" },
  taksrv_other: { scope: "source.git.hosting.write", subject: "sub-other" },
});
const sig = { name: "Fixture", email: "fixture@example.invalid", timestamp: 1700000000, tzOffset: "+0000" };

async function setup(divergent = false) {
  const handle = makeEnv();
  const reg = new RouteRegistry(); registerRepoRoutes(reg); registerPullRoutes(reg);
  async function request(method: string, path: string, body?: unknown, token = method === "GET" ? "taksrv_read" : "taksrv_write") {
    const request = method === "GET" ? get(path, token) : jsonRequest(method, path, body ?? {}, token);
    const response = await reg.handle({ request, env: handle.env, interfaceUserInfoFetch: tokens });
    if (!response) throw new Error("missing route");
    return { status: response.status, body: await response.json() as any };
  }
  expect((await request("POST", "/api/v1/repos", { owner: "alice", name: "metadata", visibility: "private" })).status).toBe(201);
  const repo = "alice/metadata", path = "/api/v1/repos/alice/metadata/pulls/1";
  const initial = await seedRepo(handle.bucket, { repo, content: "base\n" });
  const head = await putCommit(repositoryObjectStore(handle.bucket, repo), {
    tree: divergent ? await createSingleFileTree(repositoryObjectStore(handle.bucket, repo), "README.md", "head\n") : initial.treeSha,
    parents: [initial.commitSha], author: sig, committer: sig, message: "feature\n",
  });
  const base = divergent ? await putCommit(repositoryObjectStore(handle.bucket, repo), {
    tree: initial.treeSha, parents: [initial.commitSha], author: sig, committer: sig, message: "base advanced\n",
  }) : initial.commitSha;
  await writeRepoRefs(handle.bucket, repo, {
    refs: [{ name: "refs/heads/main", sha: base }, { name: "refs/heads/feature", sha: head }], defaultBranch: "main",
  });
  expect((await request("POST", path.replace(/\/1$/, ""), { title: "Projection", head: "feature", base: "main" })).status).toBe(201);
  async function fault(table: "issues" | "pull_requests") {
    await handle.db.binding.exec(`CREATE TRIGGER reject_projection BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'fixture projection fault'); END;`);
  }
  const clear = () => handle.db.binding.exec("DROP TRIGGER reject_projection;");
  const row = () => handle.db.queryOne<{ merged: number; merge_commit_sha: string | null; state: string; merge_method: string }>(
    "SELECT p.merged,p.merge_commit_sha,p.merge_method,i.state FROM pull_requests p JOIN issues i ON i.id=p.issue_id",
  );
  return { ...handle, request, path, repo, initial, head, fault, clear, row };
}

describe("committed PR merge metadata recovery", () => {
  for (const method of ["merge", "squash", "rebase"] as const) {
    for (const table of ["issues", "pull_requests"] as const) {
      test(`${method}: ${table} failure keeps atomic metadata and recovers original commit after another push`, async () => {
        const fx = await setup(true);
        try {
          await fx.fault(table);
          const merged = await fx.request("POST", `${fx.path}/merge`, { method });
          expect(merged.status).toBe(202);
          expect(merged.body.metadata_pending).toBe(true);
          const committed = merged.body.merge_commit;
          expect(committed).toMatch(/^[a-f0-9]{40}$/);
          expect(await fx.row()).toMatchObject({ merged: 0, merge_commit_sha: null, state: "open" });
          expect((await fx.request("GET", fx.path)).body.pull_request.mergePending).toMatchObject({ commitSha: committed, method });
          expect((await fx.request("POST", `${fx.path}/close`)).status).toBe(409);
          expect((await fx.request("PATCH", fx.path, { base: "feature" })).status).toBe(409);
          const snapshot = await readRepoRefs(fx.bucket, fx.repo);
          // A later writer changes the tip. Recovery must not confuse it with this merge.
          await writeRepoRefs(fx.bucket, fx.repo, { ...snapshot, refs: snapshot.refs.map(r => r.name === "refs/heads/main" ? { ...r, sha: fx.initial.commitSha } : r) });
          await fx.clear();
          const before = await readRepoRefs(fx.bucket, fx.repo);
          const beforeKeys = (await fx.bucket.list({ prefix: "git/v3/" })).objects.map(o => o.key);
          const recovered = await fx.request("POST", `${fx.path}/reconcile`);
          expect(recovered.status).toBe(200);
          expect(recovered.body.metadata_pending).toBeUndefined();
          expect(recovered.body.merge_commit).toBe(committed);
          expect(await fx.row()).toMatchObject({ merged: 1, state: "closed", merge_commit_sha: committed, merge_method: method });
          expect((await readRepoRefs(fx.bucket, fx.repo)).refs).toEqual(before.refs);
          expect((await fx.bucket.list({ prefix: "git/v3/" })).objects.map(o => o.key)).toEqual(beforeKeys);
          expect((await fx.request("GET", fx.path)).body.pull_request).toMatchObject({ merged: true, state: "closed", mergeCommitSha: committed });
          expect((await fx.request("POST", `${fx.path}/reconcile`)).status).toBe(200);
        } finally { fx.fake.db.close(); }
      });
    }
  }

  test("reconcile is metadata-only, current-authorized, and never starts a merge", async () => {
    const fx = await setup();
    try {
      const refs = await readRepoRefs(fx.bucket, fx.repo);
      expect((await fx.request("POST", `${fx.path}/reconcile`)).status).toBe(409);
      expect(await readRepoRefs(fx.bucket, fx.repo)).toEqual(refs);
      await fx.fault("issues");
      expect((await fx.request("POST", `${fx.path}/merge`, { method: "squash" })).status).toBe(202);
      const pending = await readRepoRefs(fx.bucket, fx.repo);
      expect((await fx.request("POST", `${fx.path}/reconcile`, {}, "taksrv_read")).status).toBe(401);
      expect((await fx.request("POST", `${fx.path}/reconcile`, {}, "taksrv_other")).status).toBe(404);
      expect(await readRepoRefs(fx.bucket, fx.repo)).toEqual(pending);
      expect((await fx.request("POST", `${fx.path}/merge`, { method: "rebase" })).status).toBe(202);
      expect(await readRepoRefs(fx.bucket, fx.repo)).toEqual(pending);
    } finally { fx.fake.db.close(); }
  });

  test("a lost ref-write ACK is recoverable from a fresh read without replaying squash", async () => {
    const fx = await setup();
    try {
      let landed = false;
      const real = fx.bucket;
      const observed: ObjectStoreBinding = {
        get: k => real.get(k), head: k => real.head(k), list: o => real.list(o), delete: k => real.delete(k),
        async put(k, value, opts) {
          const result = await real.put(k, value, opts);
          if (k.startsWith("git/v2/refs/") && result && !landed) { landed = true; throw new Error("fixture lost ACK"); }
          return result;
        },
      };
      fx.env.BUCKET = observed;
      let uncertain = false;
      try { uncertain = (await fx.request("POST", `${fx.path}/merge`, { method: "squash" })).status >= 500; }
      catch { uncertain = true; }
      expect(uncertain && landed).toBe(true);
      expect(await fx.row()).toMatchObject({ merged: 0, state: "open" });
      const fresh = await fx.request("GET", fx.path);
      const committed = fresh.body.pull_request.mergePending.commitSha;
      expect(committed).toMatch(/^[a-f0-9]{40}$/);
      const refs = (await readRepoRefs(real, fx.repo)).refs;
      expect((await fx.request("POST", `${fx.path}/reconcile`)).body.merge_commit).toBe(committed);
      expect((await readRepoRefs(real, fx.repo)).refs).toEqual(refs);
    } finally { fx.fake.db.close(); }
  });

  test("receipt cleanup failure preserves acknowledged success and can be retried", async () => {
    const fx = await setup();
    try {
      let writes = 0;
      const real = fx.bucket;
      fx.env.BUCKET = {
        get: k => real.get(k), head: k => real.head(k), list: o => real.list(o), delete: k => real.delete(k),
        put(k, value, opts) {
          if (k.startsWith("git/v2/refs/") && ++writes === 2) throw new Error("fixture cleanup unavailable");
          return real.put(k, value, opts);
        },
      };
      const merged = await fx.request("POST", `${fx.path}/merge`, { method: "squash" });
      expect(merged.status).toBe(200);
      expect(merged.body.pull_request.merged).toBe(true);
      expect(merged.body.pull_request.mergePending).toBeUndefined();
      expect(Object.keys((await readRepoRefs(real, fx.repo)).pendingMerges ?? {})).toHaveLength(1);
      const refs = (await readRepoRefs(real, fx.repo)).refs;
      expect((await fx.request("POST", `${fx.path}/reconcile`)).status).toBe(200);
      expect(Object.keys((await readRepoRefs(real, fx.repo)).pendingMerges ?? {})).toHaveLength(0);
      expect((await readRepoRefs(real, fx.repo)).refs).toEqual(refs);
    } finally { fx.fake.db.close(); }
  });

  test("conflict resolution retains its actual commit and is reconciled without resolutions replay", async () => {
    const fx = await setup(true);
    try {
      const objects = repositoryObjectStore(fx.bucket, fx.repo);
      const base = await putCommit(objects, { tree: await createSingleFileTree(objects, "README.md", "base conflict\n"),
        parents: [fx.initial.commitSha], author: sig, committer: sig, message: "base conflict\n" });
      const doc = await readRepoRefs(fx.bucket, fx.repo);
      await writeRepoRefs(fx.bucket, fx.repo, { ...doc, refs: doc.refs.map(r => r.name === "refs/heads/main" ? { ...r, sha: base } : r) });
      await fx.fault("issues");
      const result = await fx.request("POST", `${fx.path}/resolve`, { resolutions: [{ path: "README.md", content: "resolved\n" }] });
      expect(result.status).toBe(202);
      expect(result.body.metadata_pending).toBe(true);
      expect(await fx.row()).toMatchObject({ merged: 0, state: "open" });
      await fx.clear();
      const refs = (await readRepoRefs(fx.bucket, fx.repo)).refs;
      expect((await fx.request("POST", `${fx.path}/reconcile`)).body.merge_commit).toBe(result.body.merge_commit);
      expect((await readRepoRefs(fx.bucket, fx.repo)).refs).toEqual(refs);
      expect(await fx.row()).toMatchObject({ merged: 1, state: "closed", merge_commit_sha: result.body.merge_commit });
    } finally { fx.fake.db.close(); }
  });
});
