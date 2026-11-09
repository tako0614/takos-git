import { describe, expect, test } from "bun:test";
import { createDbClient, type D1Database } from "../../db/client.ts";
import { seedRepo } from "../../seed.ts";
import { makeEnv, jsonRequest, get } from "../repos/testkit.ts";
import { dispatch, router as issueRouter, setupRepo } from "../issues/harness.ts";
import { registerPullRoutes } from "./routes.ts";
import { setRepoEventSink } from "./events.ts";
import { readRepoRefs, writeRepoRefs } from "../../git/refs-store.ts";
import { repositoryObjectStore } from "../../git/repo-object-store.ts";
import { putCommit } from "../../git/object-store.ts";

const repoPath = "/api/v1/repos/alice/web", path = repoPath + "/pulls";
const original = { title: "One original PR", body: "Submitted original body", head: "feature", base: "main", draft: true };
function router() { const reg = issueRouter(); registerPullRoutes(reg); return reg; }
async function seed(handle: ReturnType<typeof makeEnv>, repo: string) {
  const base = await seedRepo(handle.bucket, { repo, content: "base\n" });
  const signature = { name: "Local", email: "local@example.test", timestamp: 1700000001, tzOffset: "+0000" };
  const head = await putCommit(repositoryObjectStore(handle.bucket, repo), { tree: base.treeSha, parents: [base.commitSha], author: signature, committer: signature, message: "feature\n" });
  await writeRepoRefs(handle.bucket, repo, { defaultBranch: "main", refs: [{ name: "refs/heads/main", sha: base.commitSha }, { name: "refs/heads/feature", sha: head }] });
}
async function fixture() {
  const handle = makeEnv(), reg = router();
  await setupRepo(reg, handle.env, { grants: { "sub-carol": "writer" } }); await seed(handle, "alice/web");
  const send = (key: string | null = "same-key", input: Record<string, unknown> = original, token = "taksrv_bob_w", target = reg, targetPath = path) => {
    const request = jsonRequest("POST", targetPath, input, token);
    if (key !== null) request.headers.set("Idempotency-Key", key);
    return dispatch(target, request, handle.env);
  };
  const state = async () => ({ issues: await handle.db.query("SELECT id,number FROM issues ORDER BY number"), pulls: await handle.db.query("SELECT id FROM pull_requests"), counters: await handle.db.query("SELECT next_value FROM repo_counters WHERE scope='issue'") });
  return { ...handle, reg, send, state };
}

describe("durable PR creation through the real router", () => {
  test("captured repository and browser identity context are checked before receipt replay", async () => {
    const f = await fixture();
    try {
      const repo = await f.db.queryOne<{ id: string }>("SELECT id FROM repositories WHERE name='web'");
      expect((await f.send("same-key", { ...original, repository_id: repo!.id })).status).toBe(201);
      for (const patch of [{ repository_id: "different-repository" }, { recovery_scope: "different-browser-context" }]) {
        const response = await f.send("same-key", { ...original, ...patch });
        expect(response.status).toBe(409);
        expect((await response.json()).error.code).toBe("submission_context_changed");
      }
      const state = await f.state(); expect(state.issues).toHaveLength(1); expect(state.pulls).toHaveLength(1); expect(state.counters).toEqual([{ next_value: 2 }]);
    } finally { f.fake.db.close(); }
  });

  test("same retained key and a fresh router return one PR and one event", async () => {
    const f = await fixture(); let opened = 0; setRepoEventSink(e => { if (e.type === "pull_request.opened") opened++; });
    try {
      const a = await f.send(), b = await f.send("same-key", original, "taksrv_bob_w", router());
      expect(a.status).toBe(201); expect(b.status).toBe(201); expect((await b.json()).pull_request).toEqual((await a.json()).pull_request);
      expect(b.headers.get("Idempotency-Replayed")).toBe("true");
      const s = await f.state(); expect(s.issues).toHaveLength(1); expect(s.pulls).toHaveLength(1); expect(s.counters).toEqual([{ next_value: 2 }]); expect(opened).toBe(1);
    } finally { setRepoEventSink(null); f.fake.db.close(); }
  });
  test("changed intent is409 without another number; branch aliases normalize", async () => {
    const f = await fixture();
    try {
      const first = (await (await f.send()).json()).pull_request;
      for (const patch of [{ title: "different" }, { body: "different" }, { draft: false }, { base: "feature", head: "main" }]) {
        const r = await f.send("same-key", { ...original, ...patch }); expect(r.status).toBe(409); expect((await r.json()).error.code).toBe("idempotency_conflict");
      }
      const repeated = await f.send("same-key", { ...original, title: ` ${original.title} `, head: "refs/heads/feature", base: "refs/heads/main" });
      expect(repeated.status).toBe(201); expect((await repeated.json()).pull_request).toEqual(first); expect((await f.state()).counters).toEqual([{ next_value: 2 }]);
    } finally { f.fake.db.close(); }
  });
  test("write-only recovery returns the initial projection after edits, branch deletion and profile changes", async () => {
    const f = await fixture();
    try {
      const first = (await (await f.send()).json()).pull_request;
      expect((await dispatch(f.reg, jsonRequest("PATCH", path + "/1", { title: "owner future title", body: "owner future body" }, "taksrv_alice_w"), f.env)).status).toBe(200);
      await f.db.run("UPDATE principals SET display_name='future profile' WHERE subject='sub-bob'");
      await writeRepoRefs(f.bucket, "alice/web", { defaultBranch: "main", refs: [] });
      const repeated = await f.send(); expect(repeated.status).toBe(201); expect((await repeated.json()).pull_request).toEqual(first);
      expect((await dispatch(f.reg, get(path + "/1", "taksrv_bob_w"), f.env)).status).toBe(401);
      const read = await dispatch(f.reg, get(path + "/1", "taksrv_bob_r"), f.env); expect(read.status).toBe(200); expect((await read.json()).pull_request.title).toBe("owner future title");
    } finally { f.fake.db.close(); }
  });
  test("an omitted base retains the original default through a later default change", async () => {
    const f = await fixture();
    try {
      const input = { ...original, base: undefined }, first = (await (await f.send("same-key", input)).json()).pull_request;
      await f.db.run("UPDATE repositories SET default_branch='feature'");
      const r = await f.send("same-key", input); expect(r.status).toBe(201); expect((await r.json()).pull_request).toEqual(first);
    } finally { f.fake.db.close(); }
  });
  test("deleted PR is410 with no resurrection or allocation", async () => {
    const f = await fixture();
    try {
      await f.send(); await f.db.run("DELETE FROM issues"); const r = await f.send(); expect(r.status).toBe(410); expect((await r.json()).error.code).toBe("submission_deleted");
      const s = await f.state(); expect(s.issues).toEqual([]); expect(s.pulls).toEqual([]); expect(s.counters).toEqual([{ next_value: 2 }]);
    } finally { f.fake.db.close(); }
  });
  test("Repo/principal scope and the legacy shared Issue allocator remain independent", async () => {
    const f = await fixture();
    try {
      expect((await dispatch(f.reg, jsonRequest("POST", "/api/v1/repos", { owner: "alice", name: "other" }, "taksrv_alice_w"), f.env)).status).toBe(201); await seed(f, "alice/other");
      expect((await dispatch(f.reg, jsonRequest("PUT", "/api/v1/repos/alice/other/collaborators/sub-bob", { role: "writer", bindingId: "binding_sub-bob" }, "taksrv_alice_a"), f.env)).status).toBe(200);
      expect((await (await f.send()).json()).pull_request.number).toBe(1);
      expect((await (await f.send("same-key", original, "taksrv_carol_w")).json()).pull_request.number).toBe(2);
      expect((await (await dispatch(f.reg, jsonRequest("POST", repoPath + "/issues", { title: "legacy Issue" }, "taksrv_bob_w"), f.env)).json()).issue.number).toBe(3);
      expect((await (await f.send("same-key", original, "taksrv_bob_w", f.reg, "/api/v1/repos/alice/other/pulls")).json()).pull_request.number).toBe(1);
      expect((await f.state()).pulls).toHaveLength(3);
    } finally { f.fake.db.close(); }
  });
  test("invalid key and current authorization are checked before recovering", async () => {
    const f = await fixture();
    try {
      await f.db.run("UPDATE repositories SET visibility='private'");
      for (const key of ["", "a b", "x".repeat(256)]) expect((await f.send(key)).status).toBe(400);
      expect((await f.state()).pulls).toEqual([]); await f.send();
      await f.db.run("DELETE FROM repo_collaborators WHERE principal_id=(SELECT id FROM principals WHERE subject='sub-bob')");
      expect((await f.send()).status).toBe(404); expect((await f.state()).pulls).toHaveLength(1);
      expect((await dispatch(f.reg, jsonRequest("PUT", repoPath + "/collaborators/sub-bob", { role: "writer", bindingId: "binding_sub-bob" }, "taksrv_alice_a"), f.env)).status).toBe(200);
      expect((await f.send()).headers.get("Idempotency-Replayed")).toBe("true");
    } finally { f.fake.db.close(); }
  });
  test("unkeyed creation remains independent; a late PR insert failure rolls back the Issue and counter", async () => {
    const f = await fixture();
    try {
      await f.db.run("CREATE TRIGGER reject_pr BEFORE INSERT ON pull_requests BEGIN SELECT RAISE(ABORT, 'late PR failure'); END");
      await expect(f.send()).rejects.toThrow("late PR failure"); const empty = await f.state(); expect(empty.issues).toEqual([]); expect(empty.pulls).toEqual([]); expect(empty.counters).toEqual([]);
      await f.db.run("DROP TRIGGER reject_pr");
      expect((await (await f.send(null)).json()).pull_request.number).toBe(1); expect((await (await f.send(null)).json()).pull_request.number).toBe(2);
    } finally { f.fake.db.close(); }
  });
  test("a lost committed batch reply recovers without another create", async () => {
    const f = await fixture(); let lose = true;
    f.env.DB = { prepare: q => f.fake.prepare(q), exec: q => f.fake.exec(q), async batch(statements) { const r = await f.fake.batch(statements); if (lose) { lose = false; throw new Error("lost committed reply"); } return r; } } satisfies D1Database;
    try {
      await expect(f.send()).rejects.toThrow("lost committed reply"); f.env.DB = f.fake;
      const recovered = await f.send(); expect(recovered.status).toBe(201); expect(recovered.headers.get("Idempotency-Replayed")).toBe("true"); expect((await recovered.json()).pull_request.number).toBe(1);
      expect((await f.state()).pulls).toHaveLength(1); expect((await f.state()).counters).toEqual([{ next_value: 2 }]);
      const receipt = await createDbClient(f.fake).queryOne<Record<string, string>>("SELECT key_hash,request_hash,creation_metadata FROM pull_request_submissions");
      expect(receipt?.key_hash).toHaveLength(64); expect(receipt?.request_hash).toHaveLength(64); expect(JSON.stringify(receipt)).not.toContain(original.body); expect(JSON.stringify(receipt)).not.toContain("same-key");
    } finally { f.fake.db.close(); }
  });
});
