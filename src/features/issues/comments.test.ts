import { describe, expect, test } from "bun:test";

import { get, jsonRequest, makeEnv } from "../repos/testkit.ts";
import { dispatch, router, setupRepo } from "./harness.ts";

async function openIssue(reg: ReturnType<typeof router>, env: Parameters<typeof dispatch>[2]): Promise<void> {
  await dispatch(reg, jsonRequest("POST", "/api/v1/repos/alice/web/issues", { title: "topic" }, "taksrv_bob_w"), env);
}

describe("issue comments", () => {
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
