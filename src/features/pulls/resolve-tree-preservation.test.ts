import { describe, expect, test } from "bun:test";
import { RouteRegistry } from "../../router.ts";
import { registerRepoRoutes } from "../repos/routes.ts";
import { registerPullRoutes } from "./routes.ts";
import { interfaceUserInfoFetch, jsonRequest, makeEnv } from "../repos/testkit.ts";
import { putBlob, putCommit, getCommitData, getBlob } from "../../git/object-store.ts";
import { repositoryObjectStore } from "../../git/repo-object-store.ts";
import { buildTreeFromPaths, flattenTree } from "../../git/tree-ops.ts";
import { readRepoRefs, writeRepoRefs } from "../../git/refs-store.ts";

const userinfo = interfaceUserInfoFetch({ taksrv_write: { subject: "sub-alice", scope: "source.git.hosting.write" } });
const sig = { name: "Fixture", email: "fixture@example.invalid", timestamp: 1700000000, tzOffset: "+0000" };
interface Change { path: string; content: string | null; mode?: string }
const baseFiles = ["README.md", "stable.txt", "local-delete.txt", "incoming-delete.txt", "mode.sh"];
const fixtures: { name: string; local: Change[]; incoming: Change[]; expected: string[]; executable?: string }[] = [
  { name: "local-only executable addition", local: [{ path: "local.sh", content: "echo local\n", mode: "100755" }], incoming: [],
    expected: [...baseFiles, "local.sh"], executable: "local.sh" },
  { name: "incoming-only addition", local: [], incoming: [{ path: "incoming.txt", content: "incoming addition\n" }],
    expected: [...baseFiles, "incoming.txt"] },
  { name: "both additions with independent deletions and mode change",
    local: [{ path: "local.txt", content: "local addition\n" }, { path: "shared.txt", content: "same addition\n" },
      { path: "local-delete.txt", content: null }, { path: "mode.sh", content: "echo mode\n", mode: "100755" }],
    incoming: [{ path: "incoming.txt", content: "incoming addition\n" }, { path: "shared.txt", content: "same addition\n" }, { path: "incoming-delete.txt", content: null }],
    expected: ["README.md", "stable.txt", "mode.sh", "local.txt", "incoming.txt", "shared.txt"], executable: "mode.sh" },
  { name: "existing one-sided deletions and incoming mode change",
    local: [{ path: "local-delete.txt", content: null }],
    incoming: [{ path: "incoming-delete.txt", content: null }, { path: "mode.sh", content: "echo mode\n", mode: "100755" }],
    expected: ["README.md", "stable.txt", "mode.sh"], executable: "mode.sh" },
];

describe("conflict resolution preserves every non-conflicting tree entry", () => {
  for (const fixture of fixtures) test(fixture.name, async () => {
    const handle = makeEnv(), reg = new RouteRegistry(); registerRepoRoutes(reg); registerPullRoutes(reg);
    async function request(path: string, body: unknown) {
      const response = await reg.handle({ env: handle.env, interfaceUserInfoFetch: userinfo, request: jsonRequest("POST", path, body, "taksrv_write") });
      if (!response) throw new Error("missing route");
      return { status: response.status, body: await response.json() as any };
    }
    try {
      expect((await request("/api/v1/repos", { owner: "alice", name: "resolve", visibility: "private" })).status).toBe(201);
      const repo = "alice/resolve", objects = repositoryObjectStore(handle.bucket, repo);
      async function commit(parent: string | null, changes: Change[], message: string) {
        const files = new Map<string, { path: string; sha: string; mode: string }>();
        if (parent) {
          const original = await getCommitData(objects, parent);
          if (!original) throw new Error("missing fixture parent");
          for (const file of await flattenTree(objects, original.tree)) files.set(file.path, file);
        }
        for (const change of changes) {
          if (change.content === null) files.delete(change.path);
          else files.set(change.path, { path: change.path, sha: await putBlob(objects, new TextEncoder().encode(change.content)), mode: change.mode ?? "100644" });
        }
        return putCommit(objects, { tree: await buildTreeFromPaths(objects, [...files.values()]), parents: parent ? [parent] : [], author: sig, committer: sig, message });
      }
      const root = await commit(null, [
        { path: "README.md", content: "base\n" }, { path: "stable.txt", content: "unchanged\n" },
        { path: "local-delete.txt", content: "delete locally\n" }, { path: "incoming-delete.txt", content: "delete remotely\n" },
        { path: "mode.sh", content: "echo mode\n" },
      ], "root");
      const base = await commit(root, [{ path: "README.md", content: "local conflict\n" }, ...fixture.local], "local");
      const head = await commit(root, [{ path: "README.md", content: "incoming conflict\n" }, ...fixture.incoming], "incoming");
      await writeRepoRefs(handle.bucket, repo, { defaultBranch: "main", refs: [{ name: "refs/heads/main", sha: base }, { name: "refs/heads/feature", sha: head }] });
      const path = "/api/v1/repos/alice/resolve/pulls/1";
      expect((await request(path.replace(/\/1$/, ""), { title: "Resolve README only", head: "feature", base: "main" })).status).toBe(201);
      const before = await readRepoRefs(handle.bucket, repo);
      expect((await request(`${path}/resolve`, { resolutions: [] })).status).toBe(400);
      expect(await readRepoRefs(handle.bucket, repo)).toEqual(before);
      const result = await request(`${path}/resolve`, { resolutions: [{ path: "README.md", content: "resolved\n" }] });
      expect(result.status).toBe(200);
      expect(result.body.pull_request).toMatchObject({ merged: true, state: "closed" });
      const C = result.body.merge_commit, merged = await getCommitData(objects, C);
      expect(merged?.parents).toEqual([base, head]);
      const actual = await flattenTree(objects, merged!.tree);
      expect(actual.map(f => f.path).sort()).toEqual([...fixture.expected].sort());
      const expectedContents = new Map([...(await flattenTree(objects, (await getCommitData(objects, base))!.tree)),
        ...(await flattenTree(objects, (await getCommitData(objects, head))!.tree))].map(f => [f.path, f.sha]));
      for (const file of actual) {
        if (file.path === "README.md") expect(new TextDecoder().decode((await getBlob(objects, file.sha))!)).toBe("resolved\n");
        else expect(file.sha).toBe(expectedContents.get(file.path));
      }
      if (fixture.executable) expect(actual.find(f => f.path === fixture.executable)?.mode).toBe("100755");
      expect((await readRepoRefs(handle.bucket, repo)).refs.find(r => r.name === "refs/heads/main")?.sha).toBe(C);
    } finally { handle.fake.db.close(); }
  });
});
