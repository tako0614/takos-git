import { describe, expect, test } from "bun:test";
import { createDbClient, type D1Database } from "../../db/client.ts";
import { makeEnv, jsonRequest, get } from "../repos/testkit.ts";
import { dispatch, router, setupRepo } from "./harness.ts";
import { setDomainEventSink } from "./events.ts";

const root = "/api/v1/repos/alice/web/issues";
async function fixture() {
  const handle = makeEnv(), reg = router();
  await setupRepo(reg, handle.env, { grants: { "sub-carol": "writer" } });
  for (const title of ["first", "second"]) {
    expect((await dispatch(reg, jsonRequest("POST", root, { title }, "taksrv_bob_w"), handle.env)).status).toBe(201);
  }
  async function send(key: string | null = "same-key", body = "original", number = 1, token = "taksrv_bob_w", target = reg) {
    const request = jsonRequest("POST", `${root}/${number}/comments`, { body }, token);
    if (key !== null) request.headers.set("Idempotency-Key", key);
    return dispatch(target, request, handle.env);
  }
  async function state() {
    const db = createDbClient(handle.fake);
    return {
      comments: await db.query<{ id: string; body: string }>("SELECT id, body FROM issue_comments ORDER BY id"),
      counts: await db.query<{ comment_count: number }>("SELECT comment_count FROM issues ORDER BY number"),
    };
  }
  return { ...handle, reg, send, state };
}

describe("durable comment submissions through the real router", () => {
  test("same scoped key survives a new router and emits the comment event once", async () => {
    const f = await fixture(); let events = 0;
    setDomainEventSink(e => { if (e.type === "issue.commented") events++; });
    try {
      const first = await f.send(), repeated = await f.send("same-key", "original", 1, "taksrv_bob_w", router());
      expect(first.status).toBe(201); expect(repeated.status).toBe(201);
      expect((await first.json()).comment.id).toBe((await repeated.json()).comment.id);
      expect(repeated.headers.get("Idempotency-Replayed")).toBe("true");
      const state = await f.state(); expect(state.comments).toHaveLength(1);
      expect(state.counts.map(r => r.comment_count)).toEqual([1, 0]); expect(events).toBe(1);
    } finally { setDomainEventSink(null); f.fake.db.close(); }
  });

  test("a reused key with different content is409 without another effect", async () => {
    const f = await fixture();
    try {
      await f.send(); const conflict = await f.send("same-key", "different");
      expect(conflict.status).toBe(409);
      expect((await conflict.json()).error.code).toBe("idempotency_conflict");
      expect((await f.state()).comments.map(r => r.body)).toEqual(["original"]);
    } finally { f.fake.db.close(); }
  });

  test("write-only replay cannot read a later edit; an authorized read still sees it", async () => {
    const f = await fixture();
    try {
      const id = (await (await f.send()).json()).comment.id;
      const edit = await dispatch(f.reg, jsonRequest("PATCH", `${root}/comments/${id}`, { body: "edited" }, "taksrv_bob_w"), f.env);
      expect(edit.status).toBe(200);
      const replay = await f.send(); expect(replay.status).toBe(201);
      const returned = (await replay.json()).comment;
      expect(returned).toMatchObject({ id, body: "original" });
      expect(returned.updatedAt).toBe(returned.createdAt);
      expect((await dispatch(f.reg, get(`${root}/1/comments`, "taksrv_bob_w"), f.env)).status).toBe(401);
      const read = await dispatch(f.reg, get(`${root}/1/comments`, "taksrv_bob_r"), f.env);
      expect(read.status).toBe(200);
      expect((await read.json()).comments[0]).toMatchObject({ id, body: "edited" });
      expect((await f.state()).comments).toHaveLength(1);
    } finally { f.fake.db.close(); }
  });

  test("a deleted submission stays gone on replay instead of being resurrected", async () => {
    const f = await fixture();
    try {
      const id = (await (await f.send()).json()).comment.id;
      expect((await dispatch(f.reg, jsonRequest("DELETE", `${root}/comments/${id}`, undefined, "taksrv_bob_w"), f.env)).status).toBe(200);
      const replay = await f.send(); expect(replay.status).toBe(410);
      expect((await replay.json()).error.code).toBe("submission_deleted");
      expect((await f.send("same-key", "different")).status).toBe(409);
      const state = await f.state(); expect(state.comments).toHaveLength(0);
      expect(state.counts.map(r => r.comment_count)).toEqual([0, 0]);
      expect(await f.db.query("SELECT comment_id FROM issue_comment_submissions")).toEqual([{ comment_id: id }]);
    } finally { f.fake.db.close(); }
  });

  test("the key is scoped to both the original principal and issue", async () => {
    const f = await fixture();
    try {
      const first = (await (await f.send()).json()).comment;
      const otherPrincipal = (await (await f.send("same-key", "original", 1, "taksrv_carol_w")).json()).comment;
      const otherIssue = (await (await f.send("same-key", "original", 2)).json()).comment;
      expect(new Set([first.id, otherPrincipal.id, otherIssue.id]).size).toBe(3);
      expect((await f.state()).counts.map(r => r.comment_count)).toEqual([2, 1]);
    } finally { f.fake.db.close(); }
  });

  test("unkeyed legacy calls remain distinct intentional comments", async () => {
    const f = await fixture();
    try {
      const a = await f.send(null), b = await f.send(null);
      expect(a.status).toBe(201); expect(b.status).toBe(201);
      expect((await a.json()).comment.id).not.toBe((await b.json()).comment.id);
      expect((await f.state()).counts.map(r => r.comment_count)).toEqual([2, 0]);
    } finally { f.fake.db.close(); }
  });

  test("invalid provided keys are refused before any comment effect", async () => {
    const f = await fixture();
    try {
      for (const key of ["", "a b", "x".repeat(256)]) expect((await f.send(key)).status).toBe(400);
      expect((await f.state()).comments).toHaveLength(0);
    } finally { f.fake.db.close(); }
  });

  test("a receipt never bypasses a revoked repository role", async () => {
    const f = await fixture();
    try {
      await f.send();
      await f.db.run("DELETE FROM repo_collaborators WHERE principal_id = (SELECT id FROM principals WHERE subject = ?)", ["sub-bob"]);
      expect((await f.send()).status).toBe(403);
      expect((await f.state()).comments).toHaveLength(1);
    } finally { f.fake.db.close(); }
  });

  test("a lost committed batch response replays the original persisted receipt", async () => {
    const f = await fixture(); let firstBatch = true;
    const lost: D1Database = {
      prepare: q => f.fake.prepare(q), exec: q => f.fake.exec(q),
      async batch(statements) { const result = await f.fake.batch(statements); if (firstBatch) { firstBatch = false; throw new Error("lost committed batch reply"); } return result; },
    };
    f.env.DB = lost;
    try {
      await expect(f.send()).rejects.toThrow("lost committed batch reply");
      f.env.DB = f.fake;
      const response = await f.send(); expect(response.status).toBe(201);
      expect(response.headers.get("Idempotency-Replayed")).toBe("true");
      const state = await f.state(); expect(state.comments).toHaveLength(1);
      expect(state.counts.map(r => r.comment_count)).toEqual([1, 0]);
    } finally { f.fake.db.close(); }
  });

  test("a late real SQL failure rolls back comment, count and receipt together", async () => {
    const f = await fixture();
    f.env.DB = {
      prepare: q => f.fake.prepare(q), exec: q => f.fake.exec(q),
      batch: statements => f.fake.batch([...statements, f.fake.prepare("INSERT INTO issue_comments (id, issue_id, body, created_at, updated_at) VALUES ('late-failure','missing-issue','bad',1,1)")]),
    };
    try {
      await expect(f.send()).rejects.toThrow();
      const state = await f.state(); expect(state.comments).toHaveLength(0);
      expect(state.counts.map(r => r.comment_count)).toEqual([0, 0]);
      expect(await f.db.query("SELECT * FROM issue_comment_submissions")).toEqual([]);
    } finally { f.fake.db.close(); }
  });
});
