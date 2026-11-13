import { describe, expect, spyOn, test } from "bun:test";

import { RouteRegistry } from "../../router.ts";
import { putBlob, putCommit } from "../../git/object-store.ts";
import { repositoryObjectStore } from "../../git/repo-object-store.ts";
import { writeRepoRefs } from "../../git/refs-store.ts";
import { buildTreeFromPaths } from "../../git/tree-ops.ts";
import * as textDiff from "../../git/text-diff.ts";
import { registerPullRoutes } from "../pulls/routes.ts";
import { registerRepoRoutes } from "./routes.ts";
import { get, interfaceUserInfoFetch, jsonRequest, makeEnv, seedFullRepo, seedPrincipal } from "./testkit.ts";

const ROOT = "/api/v1/repos/alice/web";
const userInfo = interfaceUserInfoFetch({
  taksrv_budget_writer: { scope: "source.git.hosting.write", subject: "budget-owner" },
  taksrv_budget_outsider: { scope: "source.git.hosting.read", subject: "budget-outsider" },
});
const signature = { name: "Fixture", email: "fixture@example.test", timestamp: 1_700_000_000, tzOffset: "+0000" };

async function fixture(visibility: "public" | "private" = "public") {
  const handle = makeEnv(), registry = new RouteRegistry();
  registerRepoRoutes(registry); registerPullRoutes(registry);
  const owner = await seedPrincipal(handle.db, "budget-owner", "service_account");
  await seedFullRepo(handle, { ownerLogin: "alice", ownerType: "user", ownerPrincipalId: owner, name: "web", visibility });
  const objects = repositoryObjectStore(handle.bucket, "alice/web");
  const commit = async (content: string, parents: string[]) => {
    const sha = await putBlob(objects, new TextEncoder().encode(content));
    const tree = await buildTreeFromPaths(objects, [{ path: "f.txt", sha }]);
    return putCommit(objects, { tree, parents, author: signature, committer: signature, message: "fixture" });
  };
  const base = await commit("a\nb", []), head = await commit("a\nx", [base]);
  await writeRepoRefs(handle.bucket, "alice/web", {
    refs: [{ name: "refs/heads/main", sha: base }, { name: "refs/heads/feature", sha: head }], defaultBranch: "main",
  });
  const dispatch = async (request: Request) => {
    const result = await registry.handle({ request, env: handle.env, interfaceUserInfoFetch: userInfo });
    if (!result) throw Error("missing diff route");
    return result;
  };
  const created = await dispatch(jsonRequest("POST", `${ROOT}/pulls`, { title: "small change", head: "feature", base: "main" }, "taksrv_budget_writer"));
  expect(created.status).toBe(201);
  const paths = [
    `${ROOT}/commits/${head}`, `${ROOT}/compare/main...feature`,
    `${ROOT}/pulls/1/diff`, `${ROOT}/pulls/1/files`, `${ROOT}/blame?ref=feature&path=f.txt`,
  ];
  return { handle, base, head, dispatch, paths };
}

describe("diff computation budgets on actual read routes", () => {
  test("tiny tightened budgets map to413 without changing public read authorization", async () => {
    const f = await fixture();
    // This only tightens the operational budget for a two-line fixture. The
    // real budget, aligner, store, authorization and route consumers still run.
    const factory = spyOn(textDiff, "createDiffLcsBudget")
      .mockImplementation(() => new textDiff.DiffLcsBudget({ maxCells: 8 }));
    try {
      for (const path of f.paths) {
        const response = await f.dispatch(get(path));
        expect(response.status).toBe(413);
        expect((await response.json()).error.code).toBe(path.includes("/blame?") ? "blame_too_large" : "diff_too_large");
      }
      expect(factory).toHaveBeenCalledTimes(5);
    } finally { factory.mockRestore(); }
  });

  test("normal public reads retain exact summary/full counts and blame attribution", async () => {
    const f = await fixture();
    const detail = await f.dispatch(get(f.paths[0]));
    expect(detail.status).toBe(200);
    expect((await detail.json()).diff.stats).toEqual({ filesChanged: 1, additions: 1, deletions: 1 });
    const compare = await f.dispatch(get(f.paths[1]));
    expect(compare.status).toBe(200);
    expect((await compare.json()).stats).toEqual({ filesChanged: 1, additions: 1, deletions: 1 });
    const full = await f.dispatch(get(f.paths[2])), summary = await f.dispatch(get(f.paths[3]));
    expect([full.status, summary.status]).toEqual([200, 200]);
    const a = await full.json(), b = await summary.json();
    expect(b.stats).toEqual(a.stats);
    expect(a.files[0].hunks).toBeDefined();
    expect(b.files[0].hunks).toBeUndefined();
    const blame = await f.dispatch(get(f.paths[4]));
    expect(blame.status).toBe(200);
    const result = await blame.json();
    expect(result.resolvedCommitSha).toBe(f.head);
    expect(result.lines.map((line: { content: string; commitSha: string }) => [line.content, line.commitSha]))
      .toEqual([["a", f.base], ["x", f.head]]);
  });

  test("private anonymous and unrelated authenticated readers are rejected before any diff budget", async () => {
    const f = await fixture("private");
    const factory = spyOn(textDiff, "createDiffLcsBudget");
    try {
      for (const path of f.paths) {
        expect((await f.dispatch(get(path))).status).toBe(404);
        expect((await f.dispatch(get(path, "taksrv_budget_outsider"))).status).toBe(404);
      }
      expect(factory).not.toHaveBeenCalled();
    } finally { factory.mockRestore(); }
  });
});
