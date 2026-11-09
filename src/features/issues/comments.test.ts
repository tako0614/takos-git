import { describe, expect, test } from "bun:test";

import { get, jsonRequest, makeEnv } from "../repos/testkit.ts";
import { dispatch, router, setupRepo } from "./harness.ts";
import { createDbClient } from "../../db/client.ts";
import { createComment, deleteComment, getIssueRowByNumber, listComments } from "./store.ts";

async function openIssue(reg: ReturnType<typeof router>, env: Parameters<typeof dispatch>[2]): Promise<void> {
  await dispatch(reg, jsonRequest("POST", "/api/v1/repos/alice/web/issues", { title: "topic" }, "taksrv_bob_w"), env);
}

describe("issue comments", () => {
  const path = "/api/v1/repos/alice/web/issues/1/comments";
  async function fixture(count: number, visibility: "public" | "private" = "public") {
    const { env } = makeEnv();
    const reg = router();
    await setupRepo(reg, env, { visibility });
    await openIssue(reg, env);
    for (let n = 0; n < count; n++) {
      const response = await dispatch(reg, jsonRequest("POST", path, { body: `comment ${n}` }, "taksrv_bob_w"), env);
      expect(response.status).toBe(201);
    }
    const all = await dispatch(reg, get(`${path}?limit=100`, "taksrv_bob_r"), env);
    return { reg, env, all: (await all.json()).comments as { id: string; body: string; createdAt: number }[] };
  }
  async function read(f: Awaited<ReturnType<typeof fixture>>, cursor: string | null = null, limit = 2) {
    const query = new URLSearchParams({ limit: String(limit), ...(cursor ? { cursor } : {}) });
    const response = await dispatch(f.reg, get(`${path}?${query}`, "taksrv_bob_r"), f.env);
    expect(response.status).toBe(200);
    return response.json();
  }

  for (const removed of [[0], [1], [0, 1]]) {
    test(`continuation survives deletion of first-page rows ${removed.join(",")}`, async () => {
      const f = await fixture(3);
      const first = await read(f);
      expect(first.comments).toHaveLength(2);
      expect(first.nextCursor).toBeString();
      for (const index of removed) {
        const response = await dispatch(f.reg, jsonRequest("DELETE", `/api/v1/repos/alice/web/issues/comments/${first.comments[index].id}`, undefined, "taksrv_bob_w"), f.env);
        expect(response.status).toBe(200);
      }
      const next = await read(f, first.nextCursor);
      expect(next.comments.map((c: { id: string }) => c.id)).toEqual([f.all[2].id]);
      expect(next.nextCursor).toBeNull();
    });
  }

  test("deletion followed by an appended comment neither skips nor repeats continuation rows", async () => {
    const f = await fixture(3);
    const first = await read(f);
    await dispatch(f.reg, jsonRequest("DELETE", `/api/v1/repos/alice/web/issues/comments/${first.comments[0].id}`, undefined, "taksrv_bob_w"), f.env);
    // Pin "later" through the store's supported clock: real-time POSTs can
    // share a millisecond, where the contract orders random ULIDs by id.
    const db = createDbClient(f.env.DB!, { now: () => f.all[2].createdAt + 1 });
    const issue = await getIssueRowByNumber(db, (await db.queryOne<{ id: string }>("SELECT id FROM repositories"))!.id, 1);
    const author = await db.queryOne<{ id: string }>("SELECT id FROM principals WHERE subject = ?", ["sub-bob"]);
    const appended = await createComment(db, issue!.id, author!.id, "later");
    const next = await read(f, first.nextCursor);
    expect(next.comments.map((c: { id: string }) => c.id)).toEqual([f.all[2].id, appended.id]);
    expect(next.nextCursor).toBeNull();
  });

  test("previously issued offset cursors remain readable and can continue", async () => {
    const f = await fixture(5);
    const legacy = await read(f, btoa("o:1"));
    expect(legacy.comments.map((c: { id: string }) => c.id)).toEqual(f.all.slice(1, 3).map(c => c.id));
    const next = await read(f, legacy.nextCursor);
    expect(next.comments.map((c: { id: string }) => c.id)).toEqual(f.all.slice(3).map(c => c.id));
    expect(next.nextCursor).toBeNull();
  });

  test("a continuation cursor never bypasses private repository authorization", async () => {
    const f = await fixture(3, "private");
    const first = await read(f);
    const url = `${path}?cursor=${encodeURIComponent(first.nextCursor)}`;
    const anonymous = await dispatch(f.reg, get(url), f.env);
    expect(anonymous.status).toBe(404);
    const writeOnly = await dispatch(f.reg, get(url, "taksrv_dave_w"), f.env);
    // A write-scoped credential fails read credential validation before ACLs.
    expect(writeOnly.status).toBe(401);
  });

  test("same-time row anchors stay within the issue even after the anchor is deleted", async () => {
    const f = await fixture(0);
    const second = await dispatch(f.reg, jsonRequest("POST", "/api/v1/repos/alice/web/issues", { title: "other" }, "taksrv_bob_w"), f.env);
    expect(second.status).toBe(201);
    let id = 0;
    const db = createDbClient(f.env.DB!, { now: () => 123, ulid: () => String(++id).padStart(26, "0") });
    const issues = await db.query<{ id: string }>("SELECT id FROM issues ORDER BY number");
    const author = await db.queryOne<{ id: string }>("SELECT id FROM principals WHERE subject = ?", ["sub-bob"]);
    expect(author).not.toBeNull();
    const a = await createComment(db, issues[0].id, author!.id, "first");
    const foreign = await createComment(db, issues[1].id, author!.id, "other issue");
    const c = await createComment(db, issues[0].id, author!.id, "last");
    const after = { createdAt: a.createdAt, id: a.id };
    const next = await listComments(db, issues[0].id, 1, 0, after);
    expect(next.comments.map(item => item.id)).toEqual([c.id]);
    expect(next.comments.some(item => item.id === foreign.id)).toBe(false);
    expect(next.hasMore).toBe(false);
    await deleteComment(db, a.id, issues[0].id);
    const deletedAnchor = await listComments(db, issues[0].id, 1, 0, after);
    expect(deletedAnchor.comments.map(item => item.id)).toEqual([c.id]);
  });

  test("writer comments; count increments; list returns it", async () => {
    const { env } = makeEnv();
    const reg = router();
    await setupRepo(reg, env);
    await openIssue(reg, env);

    const created = await dispatch(
      reg,
      jsonRequest("POST", "/api/v1/repos/alice/web/issues/1/comments", { body: "first!" }, "taksrv_bob_w"),
      env,
    );
    expect(created.status).toBe(201);
    const commentId = (await created.json()).comment.id as string;

    const issue = await dispatch(reg, get("/api/v1/repos/alice/web/issues/1", "taksrv_bob_r"), env);
    expect((await issue.json()).issue.commentCount).toBe(1);

    const list = await dispatch(reg, get("/api/v1/repos/alice/web/issues/1/comments", "taksrv_bob_r"), env);
    const body = await list.json();
    expect(body.comments).toHaveLength(1);
    expect(body.comments[0]).toMatchObject({ id: commentId, body: "first!", author: { subject: "sub-bob" } });
  });

  test("reader cannot comment on a public repo (403)", async () => {
    const { env } = makeEnv();
    const reg = router();
    await setupRepo(reg, env, { visibility: "public" });
    await openIssue(reg, env);
    const res = await dispatch(
      reg,
      jsonRequest("POST", "/api/v1/repos/alice/web/issues/1/comments", { body: "hi" }, "taksrv_carol_w"),
      env,
    );
    expect(res.status).toBe(403);
  });

  test("only author or maintainer may edit/delete a comment", async () => {
    const { env } = makeEnv();
    const reg = router();
    await setupRepo(reg, env, { grants: { "sub-dave": "writer" } });
    await openIssue(reg, env);
    const created = await dispatch(
      reg,
      jsonRequest("POST", "/api/v1/repos/alice/web/issues/1/comments", { body: "mine" }, "taksrv_bob_w"),
      env,
    );
    const id = (await created.json()).comment.id as string;

    // dave (writer, non-author) cannot edit
    const daveEdit = await dispatch(
      reg,
      jsonRequest("PATCH", `/api/v1/repos/alice/web/issues/comments/${id}`, { body: "hijack" }, "taksrv_dave_w"),
      env,
    );
    expect(daveEdit.status).toBe(403);

    // author edits
    const bobEdit = await dispatch(
      reg,
      jsonRequest("PATCH", `/api/v1/repos/alice/web/issues/comments/${id}`, { body: "edited" }, "taksrv_bob_w"),
      env,
    );
    expect(await bobEdit.json()).toMatchObject({ comment: { body: "edited" } });

    // maintainer/owner deletes; count returns to 0
    const del = await dispatch(
      reg,
      jsonRequest("DELETE", `/api/v1/repos/alice/web/issues/comments/${id}`, undefined, "taksrv_alice_w"),
      env,
    );
    expect(del.status).toBe(200);
    const issue = await dispatch(reg, get("/api/v1/repos/alice/web/issues/1", "taksrv_bob_r"), env);
    expect((await issue.json()).issue.commentCount).toBe(0);
  });

  test("commenting on a private repo without access is 404", async () => {
    const { env } = makeEnv();
    const reg = router();
    await setupRepo(reg, env, { visibility: "private" });
    await openIssue(reg, env);
    // dave has no grant on the private repo → 404 non-disclosure
    const res = await dispatch(
      reg,
      jsonRequest("POST", "/api/v1/repos/alice/web/issues/1/comments", { body: "x" }, "taksrv_dave_w"),
      env,
    );
    expect(res.status).toBe(404);
  });
});
