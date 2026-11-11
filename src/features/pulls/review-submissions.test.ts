import { describe, expect, test } from "bun:test";
import { makeEnv, jsonRequest } from "../repos/testkit.ts";
import { router, setupRepo, dispatch } from "../issues/harness.ts";
import { registerPullRoutes } from "./routes.ts";
import { repositoryObjectStore } from "../../git/repo-object-store.ts";
import { putBlob, putCommit } from "../../git/object-store.ts";
import { buildTreeFromPaths } from "../../git/tree-ops.ts";
import { writeRepoRefs } from "../../git/refs-store.ts";
import { setRepoEventSink } from "./events.ts";
import type { D1Database } from "../../db/client.ts";

const root = "/api/v1/repos/alice/web/pulls";
async function fixture(visibility: "public" | "private" = "public") {
  const f = makeEnv(), reg = router(); registerPullRoutes(reg);
  await setupRepo(reg, f.env, { visibility, grants: { "sub-carol": "writer" } });
  const objects = repositoryObjectStore(f.env.BUCKET, "alice/web");
  const signature = { name: "Fixture", email: "fixture@example.test", timestamp: 1700000000, tzOffset: "+0000" };
  const blob = await putBlob(objects, new TextEncoder().encode("base"));
  const tree = await buildTreeFromPaths(objects, [{ path: "file.txt", sha: blob, mode: "100644" }]);
  const base = await putCommit(objects, { tree, parents: [], author: signature, committer: signature, message: "base" });
  const head = await putCommit(objects, { tree, parents: [base], author: signature, committer: signature, message: "head" });
  await writeRepoRefs(f.env.BUCKET, "alice/web", { defaultBranch: "main", refs: [
    { name: "refs/heads/main", sha: base }, { name: "refs/heads/topic", sha: head }, { name: "refs/heads/other", sha: head },
  ] });
  for (const branch of ["topic", "other"]) {
    expect((await dispatch(reg, jsonRequest("POST", root, { title: branch, head: branch, base: "main" }, "taksrv_alice_w"), f.env)).status).toBe(201);
  }
  async function send(options: { key?: string | null; state?: string; body?: string; number?: number; token?: string; legacy?: boolean; context?: Record<string, unknown>; freshRouter?: boolean } = {}) {
    const { key = "original-key", state = "commented", body = "original review", number = 1, token = "taksrv_bob_w", legacy = false, context, freshRouter } = options;
    const request = jsonRequest("POST", `${root}/${number}/reviews${legacy ? "" : "/submissions"}`, { state, body, ...context }, token);
    if (key !== null) request.headers.set("Idempotency-Key", key);
    const target = freshRouter ? router() : reg; if (freshRouter) registerPullRoutes(target);
    return dispatch(target, request, f.env);
  }
  const rows = () => f.db.query("SELECT * FROM pr_reviews ORDER BY id");
  return { ...f, reg, send, rows, base, head };
}

describe("original review submission recovery through the real router", () => {
  test("discarded original ACK then a fresh router replays one review and emits once", async () => {
    const f = await fixture(); let events = 0; setRepoEventSink(e => { if (e.type === "pull_request.review.submitted") events++; });
    try {
      const first = await f.send(), replay = await f.send({ freshRouter: true });
      expect(first.status).toBe(201); expect(replay.status).toBe(201);
      expect((await replay.json()).review).toEqual((await first.json()).review);
      expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
      expect(await f.rows()).toHaveLength(1); expect(events).toBe(1);
    } finally { setRepoEventSink(null); f.fake.db.close(); }
  });
  test("reusing a key for another body or verdict refuses without effects", async () => {
    const f = await fixture();
    try {
      await f.send(); const before = await f.rows();
      for (const input of [{ body: "different" }, { state: "approved" }]) {
        const r = await f.send(input); expect(r.status).toBe(409); expect((await r.json()).error.code).toBe("idempotency_conflict");
        expect(await f.rows()).toEqual(before);
      }
    } finally { f.fake.db.close(); }
  });
  test("replay retains the original verdict/body/head after review edits, branch removal and PR close", async () => {
    const f = await fixture();
    try {
      const original = (await (await f.send()).json()).review;
      await f.db.run("UPDATE pr_reviews SET state='dismissed',body='later edit' WHERE id=?", [original.id]);
      await writeRepoRefs(f.env.BUCKET, "alice/web", { defaultBranch: "main", refs: [{ name: "refs/heads/main", sha: f.base }] });
      expect((await dispatch(f.reg, jsonRequest("POST", `${root}/1/close`, undefined, "taksrv_alice_w"), f.env)).status).toBe(200);
      const replay = await f.send(); expect(replay.status).toBe(201); expect((await replay.json()).review).toEqual(original);
      expect((await f.send({ key: "new-key" })).status).toBe(409); expect(await f.rows()).toHaveLength(1);
    } finally { f.fake.db.close(); }
  });
  test("a deleted review is a tombstone, not a new review on replay", async () => {
    const f = await fixture();
    try {
      const id = (await (await f.send()).json()).review.id;
      await f.db.run("DELETE FROM pr_reviews WHERE id=?", [id]);
      const r = await f.send(); expect(r.status).toBe(410); expect((await r.json()).error.code).toBe("submission_deleted");
      expect(await f.rows()).toEqual([]); expect(await f.db.query("SELECT review_id FROM pull_review_submissions")).toEqual([{ review_id: id }]);
    } finally { f.fake.db.close(); }
  });
  test("same keys are distinct across principals and backing PR Issues", async () => {
    const f = await fixture();
    try {
      const responses = [await f.send(), await f.send({ token: "taksrv_carol_w" }), await f.send({ number: 2 })];
      const ids = await Promise.all(responses.map(async r => { expect(r.status).toBe(201); return (await r.json()).review.id; }));
      expect(new Set(ids).size).toBe(3); expect(await f.rows()).toHaveLength(3);
    } finally { f.fake.db.close(); }
  });
  test("replacing a PR under the same backing Issue cannot reuse its old receipt", async () => {
    const f = await fixture();
    try {
      await f.send();
      const receipt = await f.db.queryOne<{ pr_id: string }>("SELECT pr_id FROM pull_review_submissions");
      // Select by the actual committed receipt, never an assumed/random PR id.
      const row = await f.db.queryOne<{ issue_id: string; repo_id: string }>("SELECT issue_id,repo_id FROM pull_requests WHERE id=?", [receipt!.pr_id]);
      await f.db.run("DELETE FROM pull_requests WHERE id=?", [receipt!.pr_id]);
      await f.db.run(`INSERT INTO pull_requests (id,issue_id,repo_id,head_repo_id,head_ref,head_sha,base_repo_id,base_ref,base_sha,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,1,1)`, [f.db.id(), row!.issue_id, row!.repo_id, row!.repo_id, "topic", f.head, row!.repo_id, "main", f.base]);
      const r = await f.send(); expect(r.status).toBe(410); expect((await r.json()).error.code).toBe("submission_deleted");
      expect(await f.rows()).toEqual([]); expect(await f.db.query("SELECT pr_id FROM pull_review_submissions")).toEqual([receipt]);
    } finally { f.fake.db.close(); }
  });
  test("the legacy unkeyed endpoint remains distinct; recoverable requests require a valid key", async () => {
    const f = await fixture();
    try {
      for (const key of [null, "", "has space", "x".repeat(256)]) expect((await f.send({ key })).status).toBe(400);
      expect(await f.rows()).toEqual([]);
      const a = await f.send({ legacy: true, key: null }), b = await f.send({ legacy: true, key: null });
      expect(a.status).toBe(201); expect(b.status).toBe(201); expect((await a.json()).review.id).not.toBe((await b.json()).review.id);
      expect(await f.db.query("SELECT * FROM pull_review_submissions")).toEqual([]);
    } finally { f.fake.db.close(); }
  });
  test("a receipt cannot bypass revoked ACL, original context or self-review checks", async () => {
    const f = await fixture("private");
    try {
      await f.send(); const before = await f.rows();
      for (const context of [{ repository_id: "different" }, { issue_id: "different" }, { recovery_scope: "unqualified" }]) {
        const r = await f.send({ context }); expect(r.status).toBe(409); expect((await r.json()).error.code).toBe("submission_context_changed");
      }
      expect((await f.send({ token: "taksrv_alice_w", state: "approved" })).status).toBe(422);
      await f.db.run("DELETE FROM repo_collaborators WHERE principal_id=(SELECT id FROM principals WHERE subject='sub-bob')");
      expect((await f.send()).status).toBe(404);
      expect((await f.send({ legacy: true, key: null })).status).toBe(404); expect(await f.rows()).toEqual(before);
    } finally { f.fake.db.close(); }
  });
  test("a signed-in public reader retains the existing right to review", async () => {
    const f = await fixture();
    try {
      await f.db.run("DELETE FROM repo_collaborators WHERE principal_id=(SELECT id FROM principals WHERE subject='sub-bob')");
      expect((await f.send()).status).toBe(201); expect(await f.rows()).toHaveLength(1);
    } finally { f.fake.db.close(); }
  });
  test("a committed batch with a lost return value recovers without another review", async () => {
    const f = await fixture(); let lost = true;
    const binding: D1Database = { prepare: q => f.fake.prepare(q), exec: q => f.fake.exec(q), async batch(statements) {
      const result = await f.fake.batch(statements); if (lost) { lost = false; throw new Error("lost review batch ACK"); } return result;
    } };
    f.env.DB = binding;
    try {
      await expect(f.send()).rejects.toThrow("lost review batch ACK"); f.env.DB = f.fake;
      const r = await f.send(); expect(r.status).toBe(201); expect(r.headers.get("Idempotency-Replayed")).toBe("true");
      expect(await f.rows()).toHaveLength(1); expect(await f.db.query("SELECT * FROM pull_review_submissions")).toHaveLength(1);
    } finally { f.fake.db.close(); }
  });
  test("a late SQL FK failure rolls back review and receipt together", async () => {
    const f = await fixture();
    f.env.DB = { prepare: q => f.fake.prepare(q), exec: q => f.fake.exec(q), batch: statements => f.fake.batch([
      ...statements, f.fake.prepare("INSERT INTO pr_reviews (id,pr_id,state,created_at) VALUES ('late-failure','missing','commented',1)"),
    ]) };
    try {
      await expect(f.send()).rejects.toThrow(); expect(await f.rows()).toEqual([]);
      expect(await f.db.query("SELECT * FROM pull_review_submissions")).toEqual([]);
    } finally { f.fake.db.close(); }
  });
});
