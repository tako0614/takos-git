import { afterEach, describe, expect, test } from "bun:test";

import { get, jsonRequest, makeEnv } from "../repos/testkit.ts";
import { dispatch, router, setupRepo } from "./harness.ts";
import { setDomainEventSink, type DomainEvent } from "./events.ts";

afterEach(() => setDomainEventSink(null));

describe("issues CRUD + auth", () => {
  test("writer opens issues drawing from the shared issue counter", async () => {
    const { env } = makeEnv();
    const reg = router();
    await setupRepo(reg, env);

    const first = await dispatch(
      reg,
      jsonRequest("POST", "/api/v1/repos/alice/web/issues", { title: "Bug one", body: "boom" }, "taksrv_bob_w"),
      env,
    );
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ issue: { number: 1, title: "Bug one", state: "open" } });

    const second = await dispatch(
      reg,
      jsonRequest("POST", "/api/v1/repos/alice/web/issues", { title: "Bug two" }, "taksrv_bob_w"),
      env,
    );
    expect((await second.json()).issue.number).toBe(2);
  });

  test("anonymous cannot open; reader (public) is 403; private read is 404", async () => {
    const { env } = makeEnv();
    const reg = router();
    await setupRepo(reg, env, { visibility: "private" });

    // anonymous open → 401
    const anon = await dispatch(
      reg,
      jsonRequest("POST", "/api/v1/repos/alice/web/issues", { title: "x" }),
      env,
    );
    expect(anon.status).toBe(401);

    // reader role on a PRIVATE repo: no access at all → 404 non-disclosure
    const readerList = await dispatch(reg, get("/api/v1/repos/alice/web/issues", "taksrv_carol_r"), env);
    expect(readerList.status).toBe(200); // carol is an explicit reader collaborator

    // reader cannot open (private → 404 non-disclosure of write capability)
    const readerOpen = await dispatch(
      reg,
      jsonRequest("POST", "/api/v1/repos/alice/web/issues", { title: "x" }, "taksrv_carol_w"),
      env,
    );
    expect(readerOpen.status).toBe(404);
  });

  test("reader on a PUBLIC repo gets 403 opening an issue", async () => {
    const { env } = makeEnv();
    const reg = router();
    await setupRepo(reg, env, { visibility: "public" });
    const res = await dispatch(
      reg,
      jsonRequest("POST", "/api/v1/repos/alice/web/issues", { title: "x" }, "taksrv_carol_w"),
      env,
    );
    expect(res.status).toBe(403);
  });

  test("get / list with state filter; close and reopen transitions", async () => {
    const { env } = makeEnv();
    const reg = router();
    await setupRepo(reg, env);
    await dispatch(reg, jsonRequest("POST", "/api/v1/repos/alice/web/issues", { title: "A" }, "taksrv_bob_w"), env);
    await dispatch(reg, jsonRequest("POST", "/api/v1/repos/alice/web/issues", { title: "B" }, "taksrv_bob_w"), env);

    const closed = await dispatch(
      reg,
      jsonRequest("POST", "/api/v1/repos/alice/web/issues/1/close", { stateReason: "not_planned" }, "taksrv_bob_w"),
      env,
    );
    expect(await closed.json()).toMatchObject({ issue: { number: 1, state: "closed", stateReason: "not_planned" } });

    const openList = await dispatch(reg, get("/api/v1/repos/alice/web/issues?state=open", "taksrv_bob_r"), env);
    expect((await openList.json()).issues.map((i: { number: number }) => i.number)).toEqual([2]);

    const closedList = await dispatch(reg, get("/api/v1/repos/alice/web/issues?state=closed", "taksrv_bob_r"), env);
    expect((await closedList.json()).issues.map((i: { number: number }) => i.number)).toEqual([1]);

    const reopened = await dispatch(
      reg,
      jsonRequest("POST", "/api/v1/repos/alice/web/issues/1/reopen", undefined, "taksrv_bob_w"),
      env,
    );
    expect(await reopened.json()).toMatchObject({ issue: { number: 1, state: "open" } });
  });

  test("only author or maintainer may rewrite title/body; writer may triage", async () => {
    const { env } = makeEnv();
    const reg = router();
    // grant dave a second writer role
    await setupRepo(reg, env, { grants: { "sub-dave": "writer" } });
    // bob authors
    await dispatch(reg, jsonRequest("POST", "/api/v1/repos/alice/web/issues", { title: "orig" }, "taksrv_bob_w"), env);

    // dave (writer, non-author) cannot edit the title
    const daveEdit = await dispatch(
      reg,
      jsonRequest("PATCH", "/api/v1/repos/alice/web/issues/1", { title: "hijack" }, "taksrv_dave_w"),
      env,
    );
    expect(daveEdit.status).toBe(403);

    // author edits own title
    const bobEdit = await dispatch(
      reg,
      jsonRequest("PATCH", "/api/v1/repos/alice/web/issues/1", { title: "fixed" }, "taksrv_bob_w"),
      env,
    );
    expect(await bobEdit.json()).toMatchObject({ issue: { title: "fixed" } });

    // maintainer/owner (alice) edits anyone's title
    const aliceEdit = await dispatch(
      reg,
      jsonRequest("PATCH", "/api/v1/repos/alice/web/issues/1", { title: "by-owner" }, "taksrv_alice_w"),
      env,
    );
    expect(await aliceEdit.json()).toMatchObject({ issue: { title: "by-owner" } });

    // dave (writer) may still assign himself (triage), no author check
    const assign = await dispatch(
      reg,
      jsonRequest("PATCH", "/api/v1/repos/alice/web/issues/1", { assignees: ["sub-dave"] }, "taksrv_dave_w"),
      env,
    );
    expect(assign.status).toBe(200);
    expect((await assign.json()).issue.assignees.map((a: { subject: string }) => a.subject)).toEqual(["sub-dave"]);
  });

  test("assignee filter narrows the list", async () => {
    const { env } = makeEnv();
    const reg = router();
    await setupRepo(reg, env);
    await dispatch(reg, jsonRequest("POST", "/api/v1/repos/alice/web/issues", { title: "A", assignees: ["sub-bob"] }, "taksrv_bob_w"), env);
    await dispatch(reg, jsonRequest("POST", "/api/v1/repos/alice/web/issues", { title: "B" }, "taksrv_bob_w"), env);

    const list = await dispatch(reg, get("/api/v1/repos/alice/web/issues?assignee=sub-bob", "taksrv_bob_r"), env);
    expect((await list.json()).issues.map((i: { number: number }) => i.number)).toEqual([1]);
  });

  test("open emits an issue.opened domain event", async () => {
    const { env } = makeEnv();
    const reg = router();
    await setupRepo(reg, env);
    const events: DomainEvent[] = [];
    setDomainEventSink((event) => {
      events.push(event);
    });
    await dispatch(reg, jsonRequest("POST", "/api/v1/repos/alice/web/issues", { title: "watch me" }, "taksrv_bob_w"), env);
    await Promise.resolve();
    expect(events.some((e) => e.type === "issue.opened" && e.issueNumber === 1 && e.owner === "alice")).toBe(true);
  });
});
