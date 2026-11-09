import { describe, expect, test } from "bun:test";
import { RouteRegistry } from "../../router.ts";
import type { D1Binding, D1PreparedStatement } from "../../db/client.ts";
import type { ObjectStoreBinding } from "../../git/types.ts";
import { registerRepoRoutes } from "../repos/routes.ts";
import { registerPullRoutes } from "./routes.ts";
import { interfaceUserInfoFetch, jsonRequest, makeEnv } from "../repos/testkit.ts";
import { seedRepo } from "../../seed.ts";
import { putCommit } from "../../git/object-store.ts";
import { repositoryObjectStore } from "../../git/repo-object-store.ts";
import { createSingleFileTree } from "../../git/tree-ops.ts";
import { readRepoRefs, writeRepoRefs } from "../../git/refs-store.ts";
import { setRepoEventSink } from "./events.ts";

type Method = "merge" | "squash" | "rebase" | "resolve";
type Window = "protection result" | "merge read" | "CAS snapshot";
const userinfo = interfaceUserInfoFetch({ taksrv_write: { scope: "source.git.hosting.write", subject: "sub-alice" } });
const sig = { name: "Fixture", email: "fixture@example.invalid", timestamp: 1700000000, tzOffset: "+0000" };

async function setup(method: Method) {
  const handle = makeEnv(), reg = new RouteRegistry();
  registerRepoRoutes(reg); registerPullRoutes(reg);
  const repo = "alice/guard", path = "/api/v1/repos/alice/guard/pulls/1";
  async function request(url: string, body: unknown) {
    const response = await reg.handle({ env: handle.env, interfaceUserInfoFetch: userinfo, request: jsonRequest("POST", url, body, "taksrv_write") });
    if (!response) throw new Error("missing route");
    return { status: response.status, body: await response.json() as any };
  }
  expect((await request("/api/v1/repos", { owner: "alice", name: "guard", visibility: "private" })).status).toBe(201);
  const root = await seedRepo(handle.bucket, { repo, content: "root\n" }), objects = repositoryObjectStore(handle.bucket, repo);
  async function commit(parent: string, content: string, message: string) {
    return putCommit(objects, { tree: await createSingleFileTree(objects, "README.md", new TextEncoder().encode(content)), parents: [parent], author: sig, committer: sig, message });
  }
  const base = await commit(root.commitSha, method === "resolve" ? "base\n" : "root\n", "base\n");
  const head = await commit(root.commitSha, "head\n", "checked\n");
  const laterHead = await commit(head, "later head\n", "unchecked\n");
  const laterBase = await commit(base, method === "resolve" ? "later base\n" : "root\n", "later base\n");
  await writeRepoRefs(handle.bucket, repo, { defaultBranch: "main", refs: [{ name: "refs/heads/main", sha: base }, { name: "refs/heads/feature", sha: head }] });
  expect((await request(path.replace(/\/1$/, ""), { title: "Protected PR", head: "feature", base: "main" })).status).toBe(201);
  const repoId = (await handle.db.queryOne<{ id: string }>("SELECT id FROM repositories WHERE storage_key=?", [repo]))!.id;
  const now = handle.db.now();
  await handle.db.run("INSERT INTO branch_protection_rules(id,repo_id,pattern,required_status_checks,enforce_admins,created_at,updated_at) VALUES(?,?,'main',?,1,?,?)", [handle.db.id(), repoId, JSON.stringify(["ci/build"]), now, now]);
  async function success(sha: string) {
    await handle.db.run("INSERT INTO commit_statuses(id,repo_id,sha,context,state,created_at) VALUES(?,?,?,'ci/build','success',?)", [handle.db.id(), repoId, sha, handle.db.now()]);
  }
  await success(head);
  const merge = () => request(`${path}/${method === "resolve" ? "resolve" : "merge"}`, method === "resolve" ? { resolutions: [{ path: "README.md", content: "resolved\n" }] } : { method });
  const row = () => handle.db.queryOne("SELECT p.merged,p.merge_commit_sha,i.state FROM pull_requests p JOIN issues i ON i.id=p.issue_id");
  const advance = async (branch: "head" | "base" | "tag") => {
    const refs = await readRepoRefs(handle.bucket, repo);
    const name = branch === "head" ? "refs/heads/feature" : "refs/heads/main";
    await writeRepoRefs(handle.bucket, repo, { ...refs, refs: branch === "tag"
      ? [...refs.refs, { name: "refs/tags/kept", sha: root.commitSha }]
      : refs.refs.map(r => r.name === name ? { ...r, sha: branch === "head" ? laterHead : laterBase } : r) });
  };
  return { ...handle, repo, path, head, laterHead, base, merge, row, advance, success };
}

/** Forward every call to the real binding. The observer changes only the
 * authoritative branch after a real old-head status result, never its verdict. */
function observe(fx: Awaited<ReturnType<typeof setup>>, window: Window, advance: () => Promise<void>) {
  const raw = fx.env.DB!, originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  let checkedHead = false, armed = false, reads = 0, fired = false;
  async function interleave() { fired = true; armed = false; await advance(); }
  function wrap(stmt: D1PreparedStatement, sql: string, params: unknown[] = []): D1PreparedStatement {
    const out: D1PreparedStatement = {
      bind: (...args) => wrap(stmt.bind(...args), sql, args),
      first: ((...args: any[]) => (stmt.first as any)(...args)) as D1PreparedStatement["first"],
      run: () => stmt.run(), raw: () => stmt.raw(),
      async all<T>() {
        const result = await stmt.all<T>();
        if (!fired && sql.includes("FROM commit_statuses s")) {
          checkedHead = params[1] === fx.head;
          if (window === "protection result") await interleave(); else armed = true;
        }
        return result;
      },
    };
    originals.set(out, stmt); return out;
  }
  const binding: D1Binding = { prepare: sql => wrap(raw.prepare(sql), sql), batch: stmts => raw.batch(stmts.map(s => originals.get(s) ?? s)), exec: sql => raw.exec(sql) };
  const bucket = fx.bucket;
  const observed: ObjectStoreBinding = { head: k => bucket.head(k), put: (k, v, o) => bucket.put(k, v, o), delete: k => bucket.delete(k), list: o => bucket.list(o),
    async get(k) {
      const result = await bucket.get(k);
      if (armed && k === `git/v2/refs/${fx.repo}.json` && ++reads === (window === "merge read" ? 1 : 2)) await interleave();
      return result;
    },
  };
  fx.env.DB = binding; fx.env.BUCKET = observed;
  return () => ({ checkedHead, fired });
}

describe("protected merge uses the checked refs through its CAS", () => {
  for (const method of ["merge", "squash", "rebase", "resolve"] as const) {
    test(`${method}: stable checked commit still merges; stable unchecked head is refused`, async () => {
      const fx = await setup(method);
      try {
        await fx.advance("head");
        const refused = await fx.merge();
        expect(refused.status).toBe(403);
        expect(refused.body.error.code).toBe("required_checks_failing");
        expect(await fx.row()).toMatchObject({ merged: 0, state: "open" });
        await fx.success(fx.laterHead);
        expect((await fx.merge()).status).toBe(200);
        expect(await fx.row()).toMatchObject({ merged: 1, state: "closed" });
      } finally { fx.fake.db.close(); }
    });
    for (const branch of ["head", "base"] as const) {
      for (const window of ["protection result", "merge read", "CAS snapshot"] as const) {
        test(`${method}: ${branch} changes after ${window}; refuse without refs/metadata/events effects`, async () => {
          const fx = await setup(method);
          try {
            let expectedRefs: unknown;
            const observed = observe(fx, window, async () => { await fx.advance(branch); expectedRefs = (await readRepoRefs(fx.bucket, fx.repo)).refs; });
            let events = 0; setRepoEventSink(() => { events++; });
            const result = await fx.merge(); setRepoEventSink(null);
            expect(observed()).toEqual({ checkedHead: true, fired: true });
            expect(result.status).toBe(409);
            expect(result.body.error.code).toBe("ref_conflict");
            const after = await readRepoRefs(fx.bucket, fx.repo);
            expect(after.refs).toEqual(expectedRefs);
            expect(Object.keys(after.pendingMerges ?? {})).toHaveLength(0);
            expect(await fx.row()).toMatchObject({ merged: 0, state: "open", merge_commit_sha: null });
            expect(events).toBe(0);
            // A new explicit request evaluates the new snapshot; no automatic
            // replay, stale receipt or stuck PR blocks legitimate recovery.
            if (branch === "head") {
              expect((await fx.merge()).status).toBe(403);
              await fx.success(fx.laterHead);
            }
            expect((await fx.merge()).status).toBe(200);
            expect(await fx.row()).toMatchObject({ merged: 1, state: "closed" });
          } finally { setRepoEventSink(null); fx.fake.db.close(); }
        });
      }
    }
    test(`${method}: unrelated tag change before CAS is retained and does not invalidate checked refs`, async () => {
      const fx = await setup(method);
      try {
        const observed = observe(fx, "merge read", () => fx.advance("tag"));
        expect((await fx.merge()).status).toBe(200);
        expect(observed()).toEqual({ checkedHead: true, fired: true });
        expect((await readRepoRefs(fx.bucket, fx.repo)).refs.some(r => r.name === "refs/tags/kept")).toBe(true);
      } finally { fx.fake.db.close(); }
    });
  }
});
