import { describe, expect, test } from "bun:test";

import { get, jsonRequest, makeEnv } from "../repos/testkit.ts";
import { dispatch, router, setupRepo } from "./harness.ts";

describe("repo labels", () => {
  test("maintainer creates labels; writer/reader cannot", async () => {
    const { env } = makeEnv();
    const reg = router();
    await setupRepo(reg, env);

    const create = await dispatch(
      reg,
      jsonRequest("POST", "/api/v1/repos/alice/web/labels", { name: "bug", color: "d73a4a" }, "taksrv_alice_a"),
      env,
    );
    expect(create.status).toBe(201);
    expect(await create.json()).toMatchObject({ label: { name: "bug", color: "d73a4a" } });

    // duplicate → 409
    const dup = await dispatch(
      reg,
      jsonRequest("POST", "/api/v1/repos/alice/web/labels", { name: "Bug" }, "taksrv_alice_a"),
      env,
    );
    expect(dup.status).toBe(409);

    // writer cannot create labels (maintainer floor) → 403 on public repo
    const writer = await dispatch(
      reg,
      jsonRequest("POST", "/api/v1/repos/alice/web/labels", { name: "wontfix" }, "taksrv_bob_a"),
      env,
    );
    expect(writer.status).toBe(403);

    // invalid color
    const badColor = await dispatch(
      reg,
      jsonRequest("POST", "/api/v1/repos/alice/web/labels", { name: "x", color: "zzz" }, "taksrv_alice_a"),
      env,
    );
    expect(badColor.status).toBe(400);
  });

  test("assign / unassign labels to an issue (writer), filter by label", async () => {
    const { env } = makeEnv();
    const reg = router();
    await setupRepo(reg, env);
    await dispatch(reg, jsonRequest("POST", "/api/v1/repos/alice/web/labels", { name: "bug" }, "taksrv_alice_a"), env);
    await dispatch(reg, jsonRequest("POST", "/api/v1/repos/alice/web/labels", { name: "docs" }, "taksrv_alice_a"), env);
    await dispatch(reg, jsonRequest("POST", "/api/v1/repos/alice/web/issues", { title: "A" }, "taksrv_bob_w"), env);
    await dispatch(reg, jsonRequest("POST", "/api/v1/repos/alice/web/issues", { title: "B" }, "taksrv_bob_w"), env);

    // set labels on issue 1
    const set = await dispatch(
      reg,
      jsonRequest("PUT", "/api/v1/repos/alice/web/issues/1/labels", { labels: ["bug", "docs"] }, "taksrv_bob_w"),
      env,
    );
    expect(set.status).toBe(200);
    expect((await set.json()).labels.map((l: { name: string }) => l.name).sort()).toEqual(["bug", "docs"]);

    // unknown label → 400
    const unknown = await dispatch(
      reg,
      jsonRequest("PUT", "/api/v1/repos/alice/web/issues/1/labels", { labels: ["ghost"] }, "taksrv_bob_w"),
      env,
    );
    expect(unknown.status).toBe(400);

    // filter issues by label
    const filtered = await dispatch(reg, get("/api/v1/repos/alice/web/issues?label=bug", "taksrv_bob_r"), env);
    expect((await filtered.json()).issues.map((i: { number: number }) => i.number)).toEqual([1]);

    // remove one label
    const remove = await dispatch(
      reg,
      jsonRequest("DELETE", "/api/v1/repos/alice/web/issues/1/labels/docs", undefined, "taksrv_bob_w"),
      env,
    );
    expect(remove.status).toBe(200);
    expect((await remove.json()).labels.map((l: { name: string }) => l.name)).toEqual(["bug"]);
  });

  test("edit and delete a label (maintainer)", async () => {
    const { env } = makeEnv();
    const reg = router();
    await setupRepo(reg, env);
    await dispatch(reg, jsonRequest("POST", "/api/v1/repos/alice/web/labels", { name: "old" }, "taksrv_alice_a"), env);

    const patched = await dispatch(
      reg,
      jsonRequest("PATCH", "/api/v1/repos/alice/web/labels/old", { name: "new", color: "00ff00" }, "taksrv_alice_a"),
      env,
    );
    expect(await patched.json()).toMatchObject({ label: { name: "new", color: "00ff00" } });

    const del = await dispatch(
      reg,
      jsonRequest("DELETE", "/api/v1/repos/alice/web/labels/new", undefined, "taksrv_alice_a"),
      env,
    );
    expect(del.status).toBe(200);
    const list = await dispatch(reg, get("/api/v1/repos/alice/web/labels", "taksrv_bob_r"), env);
    expect((await list.json()).labels).toHaveLength(0);
  });
});
