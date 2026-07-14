import { describe, expect, test } from "bun:test";

import { RouteRegistry, type RouterEnv } from "../../router.ts";
import { registerRepoRoutes } from "../repos/routes.ts";
import { registerPullRoutes } from "./routes.ts";
import {
  get,
  interfaceUserInfoFetch,
  jsonRequest,
  makeEnv,
  type TestEnvHandle,
} from "../repos/testkit.ts";
import type { OAuthFetch } from "../../browser-auth.ts";
import { repositoryObjectStore } from "../../git/repo-object-store.ts";
import { readRepoRefs, writeRepoRefs } from "../../git/refs-store.ts";
import { putBlob, putCommit, getCommitData } from "../../git/object-store.ts";
import { buildTreeFromPaths, flattenTree } from "../../git/tree-ops.ts";
import type { GitSignature } from "../../git/git-objects.ts";
import type { ObjectStoreBinding } from "../../git/types.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const tokens = interfaceUserInfoFetch({
  taksrv_alice_w: { scope: "source.git.hosting.write", subject: "sub-alice" },
  taksrv_alice_r: { scope: "source.git.hosting.read", subject: "sub-alice" },
  taksrv_alice_a: { scope: "source.git.hosting.admin", subject: "sub-alice" },
  taksrv_bob_w: { scope: "source.git.hosting.write", subject: "sub-bob" },
  taksrv_bob_r: { scope: "source.git.hosting.read", subject: "sub-bob" },
  taksrv_bob_a: { scope: "source.git.hosting.admin", subject: "sub-bob" },
  taksrv_carol_w: { scope: "source.git.hosting.write", subject: "sub-carol" },
  taksrv_carol_r: { scope: "source.git.hosting.read", subject: "sub-carol" },
});

function router(): RouteRegistry {
  const reg = new RouteRegistry();
  registerRepoRoutes(reg);
  registerPullRoutes(reg);
  return reg;
}

async function dispatch(
  reg: RouteRegistry,
  request: Request,
  env: RouterEnv,
  fetchMock: OAuthFetch = tokens,
): Promise<Response> {
  const res = await reg.handle({ request, env, interfaceUserInfoFetch: fetchMock });
  if (!res) throw new Error(`route was not handled: ${request.method} ${request.url}`);
  return res;
}

const SIG: GitSignature = { name: "Tester", email: "t@example", timestamp: 1_700_000_000, tzOffset: "+0000" };

/** Create a commit that overlays `files` on `parentSha`'s tree; returns its sha. */
async function addCommit(
  objects: ObjectStoreBinding,
  parentSha: string | null,
  files: Array<{ path: string; content: string }>,
  message: string,
): Promise<string> {
  const map = new Map<string, { path: string; sha: string; mode: string }>();
  if (parentSha) {
    const parent = await getCommitData(objects, parentSha);
    if (parent) {
      for (const f of await flattenTree(objects, parent.tree)) {
        map.set(f.path, { path: f.path, sha: f.sha, mode: f.mode });
      }
    }
  }
  for (const file of files) {
    const sha = await putBlob(objects, new TextEncoder().encode(file.content));
    map.set(file.path, { path: file.path, sha, mode: "100644" });
  }
  const tree = await buildTreeFromPaths(objects, [...map.values()]);
  return putCommit(objects, {
    tree,
    parents: parentSha ? [parentSha] : [],
    author: SIG,
    committer: SIG,
    message,
  });
}

async function setBranch(
  bucket: ObjectStoreBinding,
  repo: string,
  name: string,
  sha: string,
  defaultBranch = "main",
): Promise<void> {
  const doc = await readRepoRefs(bucket, repo);
  const refName = `refs/heads/${name}`;
  const refs = doc.refs.filter((r) => r.name !== refName).concat([{ name: refName, sha }]);
  await writeRepoRefs(bucket, repo, { refs, defaultBranch });
}

interface Fixture {
  handle: TestEnvHandle;
  reg: RouteRegistry;
  repo: string;
  c0: string;
}

/**
 * Create a public repo owned by alice with a `main` (C0) branch. Optionally makes
 * bob a writer collaborator. Returns the R2 storage key + base commit.
 */
async function setupRepo(opts?: { visibility?: "public" | "private"; bobWriter?: boolean }): Promise<Fixture> {
  const handle = makeEnv();
  const reg = router();
  const created = await dispatch(
    reg,
    jsonRequest(
      "POST",
      "/api/v1/repos",
      { owner: "alice", name: "web", visibility: opts?.visibility ?? "public" },
      "taksrv_alice_w",
    ),
    handle.env,
  );
  expect(created.status).toBe(201);
  const repo = "alice/web";
  const objects = repositoryObjectStore(handle.env.BUCKET as ObjectStoreBinding, repo);
  const c0 = await addCommit(objects, null, [{ path: "README.md", content: "# base\n" }], "root\n");
  await setBranch(handle.env.BUCKET as ObjectStoreBinding, repo, "main", c0);

  if (opts?.bobWriter) {
    const grant = await dispatch(
      reg,
      jsonRequest("PUT", "/api/v1/repos/alice/web/collaborators/sub-bob", { role: "writer" }, "taksrv_alice_a"),
      handle.env,
    );
    expect(grant.status).toBe(200);
  }
  return { handle, reg, repo, c0 };
}

/** Push a `feature` branch one commit ahead of `main` (fast-forwardable). */
async function pushFeatureAhead(fx: Fixture, file = "feature.txt"): Promise<string> {
  const objects = repositoryObjectStore(fx.handle.env.BUCKET as ObjectStoreBinding, fx.repo);
  const c1 = await addCommit(objects, fx.c0, [{ path: file, content: "hello\n" }], "feat\n");
  await setBranch(fx.handle.env.BUCKET as ObjectStoreBinding, fx.repo, "feature", c1);
  return c1;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pulls: open + read", () => {
  test("open a PR, list it, fetch detail", async () => {
    const fx = await setupRepo();
    await pushFeatureAhead(fx);

    const opened = await dispatch(
      fx.reg,
      jsonRequest("POST", "/api/v1/repos/alice/web/pulls", { title: "My PR", head: "feature", base: "main" }, "taksrv_alice_w"),
      fx.handle.env,
    );
    expect(opened.status).toBe(201);
    const body = (await opened.json()) as { pull_request: { number: number; state: string; head: { ref: string }; commitsCount: number } };
    expect(body.pull_request.number).toBe(1);
    expect(body.pull_request.state).toBe("open");
    expect(body.pull_request.head.ref).toBe("feature");
    expect(body.pull_request.commitsCount).toBe(1);

    const list = await dispatch(fx.reg, get("/api/v1/repos/alice/web/pulls", "taksrv_alice_r"), fx.handle.env);
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { pull_requests: unknown[] };
    expect(listBody.pull_requests).toHaveLength(1);

    const detail = await dispatch(fx.reg, get("/api/v1/repos/alice/web/pulls/1", "taksrv_alice_r"), fx.handle.env);
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as { pull_request: { mergeable: string } };
    expect(detailBody.pull_request.mergeable).toBe("clean");
  });

  test("PR and issue share the number space (first PR is #1)", async () => {
    const fx = await setupRepo();
    await pushFeatureAhead(fx);
    // Pre-consume number 1 via the shared counter (simulating an issue).
    await fx.handle.db.run(
      `INSERT INTO repo_counters (repo_id, scope, next_value) VALUES (
         (SELECT id FROM repositories WHERE storage_key = 'alice/web'), 'issue', 2)`,
    );
    const opened = await dispatch(
      fx.reg,
      jsonRequest("POST", "/api/v1/repos/alice/web/pulls", { title: "Second", head: "feature", base: "main" }, "taksrv_alice_w"),
      fx.handle.env,
    );
    const body = (await opened.json()) as { pull_request: { number: number } };
    expect(body.pull_request.number).toBe(2);
  });

  test("validation: missing title / branch / identical branches", async () => {
    const fx = await setupRepo();
    await pushFeatureAhead(fx);
    const noTitle = await dispatch(
      fx.reg,
      jsonRequest("POST", "/api/v1/repos/alice/web/pulls", { head: "feature", base: "main" }, "taksrv_alice_w"),
      fx.handle.env,
    );
    expect(noTitle.status).toBe(422);
    const missingHead = await dispatch(
      fx.reg,
      jsonRequest("POST", "/api/v1/repos/alice/web/pulls", { title: "x", head: "nope", base: "main" }, "taksrv_alice_w"),
      fx.handle.env,
    );
    expect(missingHead.status).toBe(422);
    const same = await dispatch(
      fx.reg,
      jsonRequest("POST", "/api/v1/repos/alice/web/pulls", { title: "x", head: "main", base: "main" }, "taksrv_alice_w"),
      fx.handle.env,
    );
    expect(same.status).toBe(422);
  });
});

describe("pulls: authorization", () => {
  test("anonymous cannot see a PR in a private repo (404)", async () => {
    const fx = await setupRepo({ visibility: "private" });
    await pushFeatureAhead(fx);
    await dispatch(
      fx.reg,
      jsonRequest("POST", "/api/v1/repos/alice/web/pulls", { title: "secret", head: "feature", base: "main" }, "taksrv_alice_w"),
      fx.handle.env,
    );
    const anon = await dispatch(fx.reg, get("/api/v1/repos/alice/web/pulls/1"), fx.handle.env);
    expect(anon.status).toBe(404);
    // A non-member bearer is likewise 404 (non-disclosure).
    const bob = await dispatch(fx.reg, get("/api/v1/repos/alice/web/pulls/1", "taksrv_bob_r"), fx.handle.env);
    expect(bob.status).toBe(404);
  });

  test("a reader cannot merge (403 on public repo)", async () => {
    const fx = await setupRepo();
    await pushFeatureAhead(fx);
    await dispatch(
      fx.reg,
      jsonRequest("POST", "/api/v1/repos/alice/web/pulls", { title: "PR", head: "feature", base: "main" }, "taksrv_alice_w"),
      fx.handle.env,
    );
    // carol has only the public reader floor.
    const merge = await dispatch(
      fx.reg,
      jsonRequest("POST", "/api/v1/repos/alice/web/pulls/1/merge", { merge_method: "merge" }, "taksrv_carol_w"),
      fx.handle.env,
    );
    expect(merge.status).toBe(403);
  });

  test("anonymous cannot open a PR (401)", async () => {
    const fx = await setupRepo();
    await pushFeatureAhead(fx);
    const res = await dispatch(
      fx.reg,
      jsonRequest("POST", "/api/v1/repos/alice/web/pulls", { title: "x", head: "feature", base: "main" }),
      fx.handle.env,
    );
    expect(res.status).toBe(401);
  });
});

describe("pulls: reviews + inline comments", () => {
  test("submit + list a review; reader may review", async () => {
    const fx = await setupRepo();
    await pushFeatureAhead(fx);
    await dispatch(
      fx.reg,
      jsonRequest("POST", "/api/v1/repos/alice/web/pulls", { title: "PR", head: "feature", base: "main" }, "taksrv_alice_w"),
      fx.handle.env,
    );
    const review = await dispatch(
      fx.reg,
      jsonRequest("POST", "/api/v1/repos/alice/web/pulls/1/reviews", { state: "approved", body: "LGTM" }, "taksrv_carol_w"),
      fx.handle.env,
    );
    expect(review.status).toBe(201);
    const list = await dispatch(fx.reg, get("/api/v1/repos/alice/web/pulls/1/reviews", "taksrv_alice_r"), fx.handle.env);
    const body = (await list.json()) as { reviews: Array<{ state: string }> };
    expect(body.reviews).toHaveLength(1);
    expect(body.reviews[0].state).toBe("approved");
  });

  test("inline comment create / list / edit / delete", async () => {
    const fx = await setupRepo();
    await pushFeatureAhead(fx);
    await dispatch(
      fx.reg,
      jsonRequest("POST", "/api/v1/repos/alice/web/pulls", { title: "PR", head: "feature", base: "main" }, "taksrv_alice_w"),
      fx.handle.env,
    );
    const created = await dispatch(
      fx.reg,
      jsonRequest(
        "POST",
        "/api/v1/repos/alice/web/pulls/1/comments",
        { body: "nit", file_path: "feature.txt", line: 1, side: "RIGHT" },
        "taksrv_alice_w",
      ),
      fx.handle.env,
    );
    expect(created.status).toBe(201);
    const commentId = ((await created.json()) as { comment: { id: string } }).comment.id;

    const list = await dispatch(fx.reg, get("/api/v1/repos/alice/web/pulls/1/comments", "taksrv_alice_r"), fx.handle.env);
    expect(((await list.json()) as { comments: unknown[] }).comments).toHaveLength(1);

    const edit = await dispatch(
      fx.reg,
      jsonRequest("PATCH", `/api/v1/repos/alice/web/pulls/comments/${commentId}`, { body: "updated" }, "taksrv_alice_w"),
      fx.handle.env,
    );
    expect(edit.status).toBe(200);
    expect(((await edit.json()) as { comment: { body: string } }).comment.body).toBe("updated");

    // carol (reader, not author) cannot delete alice's comment.
    const forbidden = await dispatch(
      fx.reg,
      jsonRequest("DELETE", `/api/v1/repos/alice/web/pulls/comments/${commentId}`, undefined, "taksrv_carol_w"),
      fx.handle.env,
    );
    expect(forbidden.status).toBe(403);

    const del = await dispatch(
      fx.reg,
      jsonRequest("DELETE", `/api/v1/repos/alice/web/pulls/comments/${commentId}`, undefined, "taksrv_alice_w"),
      fx.handle.env,
    );
    expect(del.status).toBe(200);
  });
});

describe("pulls: merge", () => {
  test("fast-forward merge advances the base ref and closes the PR", async () => {
    const fx = await setupRepo();
    const c1 = await pushFeatureAhead(fx);
    await dispatch(
      fx.reg,
      jsonRequest("POST", "/api/v1/repos/alice/web/pulls", { title: "PR", head: "feature", base: "main" }, "taksrv_alice_w"),
      fx.handle.env,
    );
    const merge = await dispatch(
      fx.reg,
      jsonRequest("POST", "/api/v1/repos/alice/web/pulls/1/merge", { merge_method: "merge" }, "taksrv_alice_w"),
      fx.handle.env,
    );
    expect(merge.status).toBe(200);
    const body = (await merge.json()) as { pull_request: { merged: boolean; state: string }; merge_commit: string };
    expect(body.pull_request.merged).toBe(true);
    expect(body.pull_request.state).toBe("closed");
    // Fast-forward: base ref now points at the feature tip.
    expect(body.merge_commit).toBe(c1);
    const refs = await readRepoRefs(fx.handle.env.BUCKET as ObjectStoreBinding, fx.repo);
    expect(refs.refs.find((r) => r.name === "refs/heads/main")?.sha).toBe(c1);

    // Re-merging is rejected.
    const again = await dispatch(
      fx.reg,
      jsonRequest("POST", "/api/v1/repos/alice/web/pulls/1/merge", { merge_method: "merge" }, "taksrv_alice_w"),
      fx.handle.env,
    );
    expect(again.status).toBe(409);
  });

  test("divergent branches produce a real merge commit with two parents", async () => {
    const fx = await setupRepo();
    const objects = repositoryObjectStore(fx.handle.env.BUCKET as ObjectStoreBinding, fx.repo);
    // main advances with its own commit; feature diverges from c0.
    const mainAdvance = await addCommit(objects, fx.c0, [{ path: "main.txt", content: "m\n" }], "main work\n");
    await setBranch(fx.handle.env.BUCKET as ObjectStoreBinding, fx.repo, "main", mainAdvance);
    const feat = await addCommit(objects, fx.c0, [{ path: "feature.txt", content: "f\n" }], "feature work\n");
    await setBranch(fx.handle.env.BUCKET as ObjectStoreBinding, fx.repo, "feature", feat);

    await dispatch(
      fx.reg,
      jsonRequest("POST", "/api/v1/repos/alice/web/pulls", { title: "PR", head: "feature", base: "main" }, "taksrv_alice_w"),
      fx.handle.env,
    );
    const merge = await dispatch(
      fx.reg,
      jsonRequest("POST", "/api/v1/repos/alice/web/pulls/1/merge", { merge_method: "merge" }, "taksrv_alice_w"),
      fx.handle.env,
    );
    expect(merge.status).toBe(200);
    const mergeCommitSha = ((await merge.json()) as { merge_commit: string }).merge_commit;
    const mergeCommit = await getCommitData(objects, mergeCommitSha);
    expect(mergeCommit?.parents).toEqual([mainAdvance, feat]);
    const refs = await readRepoRefs(fx.handle.env.BUCKET as ObjectStoreBinding, fx.repo);
    expect(refs.refs.find((r) => r.name === "refs/heads/main")?.sha).toBe(mergeCommitSha);
  });

  test("conflicting change is reported, then resolved via /resolve", async () => {
    const fx = await setupRepo();
    const objects = repositoryObjectStore(fx.handle.env.BUCKET as ObjectStoreBinding, fx.repo);
    const mainAdvance = await addCommit(objects, fx.c0, [{ path: "README.md", content: "# main side\n" }], "main edit\n");
    await setBranch(fx.handle.env.BUCKET as ObjectStoreBinding, fx.repo, "main", mainAdvance);
    const feat = await addCommit(objects, fx.c0, [{ path: "README.md", content: "# feature side\n" }], "feature edit\n");
    await setBranch(fx.handle.env.BUCKET as ObjectStoreBinding, fx.repo, "feature", feat);

    await dispatch(
      fx.reg,
      jsonRequest("POST", "/api/v1/repos/alice/web/pulls", { title: "PR", head: "feature", base: "main" }, "taksrv_alice_w"),
      fx.handle.env,
    );
    const conflicts = await dispatch(fx.reg, get("/api/v1/repos/alice/web/pulls/1/conflicts", "taksrv_alice_r"), fx.handle.env);
    expect(conflicts.status).toBe(409);
    const conflictBody = (await conflicts.json()) as { conflicts: Array<{ path: string }> };
    expect(conflictBody.conflicts.map((c) => c.path)).toContain("README.md");

    // Auto-merge refuses.
    const autoMerge = await dispatch(
      fx.reg,
      jsonRequest("POST", "/api/v1/repos/alice/web/pulls/1/merge", { merge_method: "merge" }, "taksrv_alice_w"),
      fx.handle.env,
    );
    expect(autoMerge.status).toBe(409);
    expect(((await autoMerge.json()) as { error: { code: string } }).error.code).toBe("merge_conflict");

    // Resolve with an explicit blob, then it merges.
    const resolve = await dispatch(
      fx.reg,
      jsonRequest(
        "POST",
        "/api/v1/repos/alice/web/pulls/1/resolve",
        { resolutions: [{ path: "README.md", content: "# merged\n" }] },
        "taksrv_alice_w",
      ),
      fx.handle.env,
    );
    expect(resolve.status).toBe(200);
    expect(((await resolve.json()) as { pull_request: { merged: boolean } }).pull_request.merged).toBe(true);
  });
});

describe("pulls: branch protection at merge", () => {
  test("required approvals block, then allow, the merge", async () => {
    const fx = await setupRepo();
    const c1 = await pushFeatureAhead(fx);
    const repoId = (await fx.handle.db.queryOne<{ id: string }>(
      `SELECT id FROM repositories WHERE storage_key = 'alice/web'`,
    ))!.id;
    const now = fx.handle.db.now();
    await fx.handle.db.run(
      `INSERT INTO branch_protection_rules (id, repo_id, pattern, required_reviews, enforce_admins, created_at, updated_at)
       VALUES (?, ?, 'main', 1, 1, ?, ?)`,
      [fx.handle.db.id(), repoId, now, now],
    );
    await dispatch(
      fx.reg,
      jsonRequest("POST", "/api/v1/repos/alice/web/pulls", { title: "PR", head: "feature", base: "main" }, "taksrv_alice_w"),
      fx.handle.env,
    );

    const blocked = await dispatch(
      fx.reg,
      jsonRequest("POST", "/api/v1/repos/alice/web/pulls/1/merge", { merge_method: "merge" }, "taksrv_alice_w"),
      fx.handle.env,
    );
    expect(blocked.status).toBe(403);
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe("review_required");

    // carol approves; now alice (owner => maintainer+) may merge.
    await dispatch(
      fx.reg,
      jsonRequest("POST", "/api/v1/repos/alice/web/pulls/1/reviews", { state: "approved" }, "taksrv_carol_w"),
      fx.handle.env,
    );
    const ok = await dispatch(
      fx.reg,
      jsonRequest("POST", "/api/v1/repos/alice/web/pulls/1/merge", { merge_method: "merge" }, "taksrv_alice_w"),
      fx.handle.env,
    );
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { merge_commit: string }).merge_commit).toBe(c1);
  });

  test("a changes_requested review blocks the merge", async () => {
    const fx = await setupRepo();
    await pushFeatureAhead(fx);
    const repoId = (await fx.handle.db.queryOne<{ id: string }>(
      `SELECT id FROM repositories WHERE storage_key = 'alice/web'`,
    ))!.id;
    const now = fx.handle.db.now();
    await fx.handle.db.run(
      `INSERT INTO branch_protection_rules (id, repo_id, pattern, required_reviews, enforce_admins, created_at, updated_at)
       VALUES (?, ?, 'main', 1, 1, ?, ?)`,
      [fx.handle.db.id(), repoId, now, now],
    );
    await dispatch(
      fx.reg,
      jsonRequest("POST", "/api/v1/repos/alice/web/pulls", { title: "PR", head: "feature", base: "main" }, "taksrv_alice_w"),
      fx.handle.env,
    );
    await dispatch(
      fx.reg,
      jsonRequest("POST", "/api/v1/repos/alice/web/pulls/1/reviews", { state: "approved" }, "taksrv_carol_w"),
      fx.handle.env,
    );
    await dispatch(
      fx.reg,
      jsonRequest("POST", "/api/v1/repos/alice/web/pulls/1/reviews", { state: "changes_requested", body: "no" }, "taksrv_bob_w"),
      fx.handle.env,
    );
    const blocked = await dispatch(
      fx.reg,
      jsonRequest("POST", "/api/v1/repos/alice/web/pulls/1/merge", { merge_method: "merge" }, "taksrv_alice_w"),
      fx.handle.env,
    );
    expect(blocked.status).toBe(403);
  });

  test("required status check must succeed before merge", async () => {
    const fx = await setupRepo();
    const c1 = await pushFeatureAhead(fx);
    const repoId = (await fx.handle.db.queryOne<{ id: string }>(
      `SELECT id FROM repositories WHERE storage_key = 'alice/web'`,
    ))!.id;
    const now = fx.handle.db.now();
    await fx.handle.db.run(
      `INSERT INTO branch_protection_rules (id, repo_id, pattern, required_status_checks, enforce_admins, created_at, updated_at)
       VALUES (?, ?, 'main', ?, 1, ?, ?)`,
      [fx.handle.db.id(), repoId, JSON.stringify(["ci/build"]), now, now],
    );
    await dispatch(
      fx.reg,
      jsonRequest("POST", "/api/v1/repos/alice/web/pulls", { title: "PR", head: "feature", base: "main" }, "taksrv_alice_w"),
      fx.handle.env,
    );
    const blocked = await dispatch(
      fx.reg,
      jsonRequest("POST", "/api/v1/repos/alice/web/pulls/1/merge", { merge_method: "merge" }, "taksrv_alice_w"),
      fx.handle.env,
    );
    expect(blocked.status).toBe(403);
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe("required_checks_failing");

    // A failing status still blocks; a success unblocks (latest-per-context wins).
    await fx.handle.db.run(
      `INSERT INTO commit_statuses (id, repo_id, sha, context, state, created_at) VALUES (?, ?, ?, 'ci/build', 'failure', ?)`,
      [fx.handle.db.id(), repoId, c1, now],
    );
    await fx.handle.db.run(
      `INSERT INTO commit_statuses (id, repo_id, sha, context, state, created_at) VALUES (?, ?, ?, 'ci/build', 'success', ?)`,
      [fx.handle.db.id(), repoId, c1, now + 1],
    );
    const ok = await dispatch(
      fx.reg,
      jsonRequest("POST", "/api/v1/repos/alice/web/pulls/1/merge", { merge_method: "merge" }, "taksrv_alice_w"),
      fx.handle.env,
    );
    expect(ok.status).toBe(200);
  });
});

describe("pulls: two-phase CAS boundary", () => {
  test("a concurrent refs-doc write during merge yields a 409 ref_conflict", async () => {
    const fx = await setupRepo();
    await pushFeatureAhead(fx);
    await dispatch(
      fx.reg,
      jsonRequest("POST", "/api/v1/repos/alice/web/pulls", { title: "PR", head: "feature", base: "main" }, "taksrv_alice_w"),
      fx.handle.env,
    );

    // Wrap the bucket so the FIRST conditional refs-doc CAS is preceded by an
    // out-of-band write that bumps the ETag — simulating a concurrent push that
    // lands between the merge's read and its CAS. The CAS must then lose (409).
    const bucket = fx.handle.env.BUCKET as ObjectStoreBinding & {
      put: ObjectStoreBinding["put"];
    };
    const realPut = bucket.put.bind(bucket);
    let injected = false;
    const refsKey = `git/v2/refs/${fx.repo}.json`;
    (bucket as { put: ObjectStoreBinding["put"] }).put = async (key, body, options) => {
      if (!injected && key === refsKey && options?.onlyIf) {
        injected = true;
        const current = await realPut(refsKey, new TextEncoder().encode(
          JSON.stringify(await readRepoRefs(bucket, fx.repo)),
        ));
        void current;
      }
      return realPut(key, body, options);
    };

    const merge = await dispatch(
      fx.reg,
      jsonRequest("POST", "/api/v1/repos/alice/web/pulls/1/merge", { merge_method: "merge" }, "taksrv_alice_w"),
      fx.handle.env,
    );
    expect(merge.status).toBe(409);
    expect(((await merge.json()) as { error: { code: string } }).error.code).toBe("ref_conflict");

    // Restore + prove the PR did NOT get marked merged (R2 never committed).
    (bucket as { put: ObjectStoreBinding["put"] }).put = realPut;
    const detail = await dispatch(fx.reg, get("/api/v1/repos/alice/web/pulls/1", "taksrv_alice_r"), fx.handle.env);
    expect(((await detail.json()) as { pull_request: { merged: boolean } }).pull_request.merged).toBe(false);
  });
});
