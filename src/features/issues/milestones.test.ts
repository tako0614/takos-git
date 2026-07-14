import { describe, expect, test } from "bun:test";

import { get, jsonRequest, makeEnv } from "../repos/testkit.ts";
import { dispatch, router, setupRepo } from "./harness.ts";

describe("milestones", () => {
  test("maintainer creates milestones on their own number sequence; reader lists", async () => {
    const { env } = makeEnv();
    const reg = router();
    await setupRepo(reg, env);

    const m1 = await dispatch(
      reg,
      jsonRequest("POST", "/api/v1/repos/alice/web/milestones", { title: "v1", dueOn: 1_800_000_000_000 }, "taksrv_alice_a"),
      env,
    );
    expect(m1.status).toBe(201);
    expect(await m1.json()).toMatchObject({ milestone: { number: 1, title: "v1", state: "open" } });

    const m2 = await dispatch(
      reg,
      jsonRequest("POST", "/api/v1/repos/alice/web/milestones", { title: "v2" }, "taksrv_alice_a"),
      env,
    );
    expect((await m2.json()).milestone.number).toBe(2);

    // writer cannot create (maintainer floor) → 403
    const writer = await dispatch(
      reg,
      jsonRequest("POST", "/api/v1/repos/alice/web/milestones", { title: "v3" }, "taksrv_bob_a"),
      env,
    );
    expect(writer.status).toBe(403);

    const list = await dispatch(reg, get("/api/v1/repos/alice/web/milestones?state=open", "taksrv_bob_r"), env);
    expect((await list.json()).milestones.map((m: { number: number }) => m.number)).toEqual([2, 1]);
  });

  test("assign milestone to an issue; milestone tracks open/closed counts", async () => {
    const { env } = makeEnv();
    const reg = router();
    await setupRepo(reg, env);
    await dispatch(reg, jsonRequest("POST", "/api/v1/repos/alice/web/milestones", { title: "v1" }, "taksrv_alice_a"), env);
    await dispatch(reg, jsonRequest("POST", "/api/v1/repos/alice/web/issues", { title: "A", milestone: 1 }, "taksrv_bob_w"), env);

    const detail = await dispatch(reg, get("/api/v1/repos/alice/web/issues/1", "taksrv_bob_r"), env);
    expect((await detail.json()).issue.milestone).toMatchObject({ number: 1, title: "v1" });

    const ms = await dispatch(reg, get("/api/v1/repos/alice/web/milestones/1", "taksrv_bob_r"), env);
    expect(await ms.json()).toMatchObject({ milestone: { number: 1, openIssues: 1, closedIssues: 0 } });

    // filter issues by milestone number
    const filtered = await dispatch(reg, get("/api/v1/repos/alice/web/issues?milestone=1", "taksrv_bob_r"), env);
    expect((await filtered.json()).issues.map((i: { number: number }) => i.number)).toEqual([1]);
  });

  test("close via PATCH then delete a milestone", async () => {
    const { env } = makeEnv();
    const reg = router();
    await setupRepo(reg, env);
    await dispatch(reg, jsonRequest("POST", "/api/v1/repos/alice/web/milestones", { title: "v1" }, "taksrv_alice_a"), env);

    const closed = await dispatch(
      reg,
      jsonRequest("PATCH", "/api/v1/repos/alice/web/milestones/1", { state: "closed" }, "taksrv_alice_a"),
      env,
    );
    expect(await closed.json()).toMatchObject({ milestone: { number: 1, state: "closed" } });

    const del = await dispatch(
      reg,
      jsonRequest("DELETE", "/api/v1/repos/alice/web/milestones/1", undefined, "taksrv_alice_a"),
      env,
    );
    expect(del.status).toBe(200);
    const missing = await dispatch(reg, get("/api/v1/repos/alice/web/milestones/1", "taksrv_bob_r"), env);
    expect(missing.status).toBe(404);
  });

  test("unknown milestone on issue open is 404", async () => {
    const { env } = makeEnv();
    const reg = router();
    await setupRepo(reg, env);
    const res = await dispatch(
      reg,
      jsonRequest("POST", "/api/v1/repos/alice/web/issues", { title: "A", milestone: 99 }, "taksrv_bob_w"),
      env,
    );
    expect(res.status).toBe(404);
  });
});
