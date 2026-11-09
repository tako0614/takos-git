import { describe, expect, test } from "bun:test";
import { createDbClient, type D1Database } from "../../db/client.ts";
import { makeEnv, jsonRequest, get } from "../repos/testkit.ts";
import { dispatch, router, setupRepo } from "./harness.ts";
import { setDomainEventSink } from "./events.ts";

const repoPath = "/api/v1/repos/alice/web", path = repoPath + "/issues";
const original = { title: "One logical Issue", body: "original submitted body" };
async function fixture() {
  const handle = makeEnv(), reg = router();
  await setupRepo(reg, handle.env, { grants: { "sub-carol": "writer" } });
  const send = async (key: string | null = "same-key", input: Record<string, unknown> = original, token = "taksrv_bob_w", target = reg, targetPath = path) => {
    const request = jsonRequest("POST", targetPath, input, token);
    if (key !== null) request.headers.set("Idempotency-Key", key);
    return dispatch(target, request, handle.env);
  };
  const state = async () => ({
    issues: await handle.db.query<{ id: string; number: number }>("SELECT id, number FROM issues ORDER BY number"),
    counters: await handle.db.query<{ next_value: number }>("SELECT next_value FROM repo_counters WHERE scope = 'issue'"),
    labels: await handle.db.query("SELECT * FROM issue_labels"),
    assignees: await handle.db.query("SELECT * FROM issue_assignees"),
  });
  const triage = async () => {
    for (const name of ["bug", "docs"]) expect((await dispatch(reg, jsonRequest("POST", repoPath + "/labels", { name, color: "aabbcc" }, "taksrv_alice_a"), handle.env)).status).toBe(201);
    expect((await dispatch(reg, jsonRequest("POST", repoPath + "/milestones", { title: "first" }, "taksrv_alice_a"), handle.env)).status).toBe(201);
    return { ...original, labels: ["bug", "docs"], assignees: ["sub-bob"], milestone: 1 };
  };
  return { ...handle, reg, send, state, triage };
}

describe("durable Issue creation through the real router", () => {
  test("same key/new router keeps one Issue, number and event", async () => {
    const f = await fixture(); let opened = 0;
    setDomainEventSink(e => { if (e.type === "issue.opened") opened++; });
    try {
      const a = await f.send(), b = await f.send("same-key", original, "taksrv_bob_w", router());
      expect(a.status).toBe(201); expect(b.status).toBe(201);
      expect((await a.json()).issue).toEqual((await b.json()).issue);
      expect(b.headers.get("Idempotency-Replayed")).toBe("true");
      expect((await f.state()).issues).toHaveLength(1);
      expect((await f.state()).counters).toEqual([{ next_value: 2 }]); expect(opened).toBe(1);
    } finally { setDomainEventSink(null); f.fake.db.close(); }
  });

  test("changed intent under the key is409 without consuming another number", async () => {
    const f = await fixture();
    try {
      await f.send(); const response = await f.send("same-key", { ...original, title: "different" });
      expect(response.status).toBe(409); expect((await response.json()).error.code).toBe("idempotency_conflict");
      const state = await f.state(); expect(state.issues).toHaveLength(1); expect(state.counters).toEqual([{ next_value: 2 }]);
    } finally { f.fake.db.close(); }
  });

  test("label/assignee sets are equivalent regardless of order or repetition", async () => {
    const f = await fixture();
    try {
      const input = await f.triage();
      const first = (await (await f.send("same-key", { ...input, labels: ["bug", "docs", "bug"] })).json()).issue;
      const repeat = await f.send("same-key", { ...input, labels: ["docs", "bug"], assignees: ["sub-bob", "sub-bob"] });
      expect(repeat.status).toBe(201); expect((await repeat.json()).issue).toEqual(first);
      const state = await f.state(); expect(state.issues).toHaveLength(1); expect(state.labels).toHaveLength(2); expect(state.assignees).toHaveLength(1);
      expect((await f.send("same-key", { ...input, labels: ["bug"] })).status).toBe(409);
    } finally { f.fake.db.close(); }
  });

  test("replay does not depend on references that disappeared after the original commit", async () => {
    const f = await fixture();
    try {
      const input = await f.triage(), first = (await (await f.send("same-key", input)).json()).issue;
      await f.db.run("DELETE FROM labels"); await f.db.run("DELETE FROM milestones");
      await f.db.run("UPDATE principals SET display_name = 'later profile' WHERE subject = 'sub-bob'");
      const repeat = await f.send("same-key", input); expect(repeat.status).toBe(201);
      expect((await repeat.json()).issue).toEqual(first);
      const state = await f.state(); expect(state.issues).toHaveLength(1); expect(state.counters).toEqual([{ next_value: 2 }]);
    } finally { f.fake.db.close(); }
  });

  test("a write-only replay never reads later owner edits or activity", async () => {
    const f = await fixture();
    try {
      const first = (await (await f.send()).json()).issue;
      expect((await dispatch(f.reg, jsonRequest("PATCH", path + "/1", { title: "owner later title", body: "owner later body", state: "closed" }, "taksrv_alice_w"), f.env)).status).toBe(200);
      const repeated = await f.send(); expect(repeated.status).toBe(201); expect((await repeated.json()).issue).toEqual(first);
      expect((await dispatch(f.reg, get(path + "/1", "taksrv_bob_w"), f.env)).status).toBe(401);
      const read = await dispatch(f.reg, get(path + "/1", "taksrv_bob_r"), f.env);
      expect(read.status).toBe(200); expect((await read.json()).issue).toMatchObject({ title: "owner later title", body: "owner later body", state: "closed" });
    } finally { f.fake.db.close(); }
  });

  test("a removed Issue is410 on replay, with no new allocation or resurrection", async () => {
    const f = await fixture();
    try {
      await f.send(); await f.db.run("DELETE FROM issues");
      const repeated = await f.send(); expect(repeated.status).toBe(410); expect((await repeated.json()).error.code).toBe("submission_deleted");
      expect((await f.state()).issues).toEqual([]); expect((await f.state()).counters).toEqual([{ next_value: 2 }]);
    } finally { f.fake.db.close(); }
  });

  test("scope includes both Repo and principal", async () => {
    const f = await fixture();
    try {
      expect((await dispatch(f.reg, jsonRequest("POST", "/api/v1/repos", { owner: "alice", name: "other" }, "taksrv_alice_w"), f.env)).status).toBe(201);
      expect((await dispatch(f.reg, jsonRequest("PUT", "/api/v1/repos/alice/other/collaborators/sub-bob", { role: "writer", bindingId: "binding_sub-bob" }, "taksrv_alice_a"), f.env)).status).toBe(200);
      expect((await (await f.send()).json()).issue.number).toBe(1);
      expect((await (await f.send("same-key", original, "taksrv_bob_w", f.reg, "/api/v1/repos/alice/other/issues")).json()).issue.number).toBe(1);
      expect((await (await f.send("same-key", original, "taksrv_carol_w")).json()).issue.number).toBe(2);
      expect((await f.state()).issues).toHaveLength(3);
    } finally { f.fake.db.close(); }
  });

  test("invalid key, invalid references and revoked roles have no create effect", async () => {
    const f = await fixture();
    try {
      for (const key of ["", "a b", "x".repeat(256)]) expect((await f.send(key)).status).toBe(400);
      expect((await f.send("fresh", { ...original, labels: ["missing"] })).status).toBe(400);
      expect((await f.state()).issues).toEqual([]); expect((await f.state()).counters).toEqual([]);
      await f.send(); await f.db.run("DELETE FROM repo_collaborators WHERE principal_id = (SELECT id FROM principals WHERE subject='sub-bob')");
      expect((await f.send()).status).toBe(403); expect((await f.state()).issues).toHaveLength(1);
    } finally { f.fake.db.close(); }
  });

  test("unkeyed requests remain independent creates", async () => {
    const f = await fixture();
    try { expect((await (await f.send(null)).json()).issue.number).toBe(1); expect((await (await f.send(null)).json()).issue.number).toBe(2); }
    finally { f.fake.db.close(); }
  });

  test("lost committed batch reply resumes the original number and associations", async () => {
    const f = await fixture(); const input = await f.triage(); let first = true;
    f.env.DB = {
      prepare: q => f.fake.prepare(q), exec: q => f.fake.exec(q),
      async batch(statements) { const result = await f.fake.batch(statements); if (first) { first = false; throw new Error("lost committed batch reply"); } return result; },
    } satisfies D1Database;
    try {
      await expect(f.send("same-key", input)).rejects.toThrow("lost committed batch reply"); f.env.DB = f.fake;
      const repeat = await f.send("same-key", input); expect(repeat.status).toBe(201); expect(repeat.headers.get("Idempotency-Replayed")).toBe("true");
      const state = await f.state(); expect(state.issues).toHaveLength(1); expect(state.counters).toEqual([{ next_value: 2 }]); expect(state.labels).toHaveLength(2); expect(state.assignees).toHaveLength(1);
    } finally { f.fake.db.close(); }
  });

  test("late FK failure rolls back number, Issue, relationships and receipt", async () => {
    const f = await fixture(), input = await f.triage();
    f.env.DB = {
      prepare: q => f.fake.prepare(q), exec: q => f.fake.exec(q),
      batch: statements => f.fake.batch([...statements, f.fake.prepare("INSERT INTO issue_labels (issue_id,label_id) VALUES ('missing','missing')")]),
    } satisfies D1Database;
    try {
      await expect(f.send("same-key", input)).rejects.toThrow(); f.env.DB = f.fake;
      const state = await f.state(); expect(state.issues).toEqual([]); expect(state.counters).toEqual([]); expect(state.labels).toEqual([]); expect(state.assignees).toEqual([]);
      expect(await createDbClient(f.fake).query("SELECT * FROM issue_submissions")).toEqual([]);
      expect((await (await f.send("same-key", input)).json()).issue.number).toBe(1);
    } finally { f.fake.db.close(); }
  });
});
