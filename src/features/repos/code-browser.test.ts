import { describe, expect, test } from "bun:test";

import { RouteRegistry, type RouterEnv } from "../../router.ts";
import { registerRepoRoutes } from "./routes.ts";
import {
  get,
  interfaceUserInfoFetch,
  makeEnv,
  seedFullRepo,
  seedOwner,
  seedPrincipal,
  type TestEnvHandle,
} from "./testkit.ts";
import { putBlob, putCommit } from "../../git/object-store.ts";
import { buildTreeFromPaths } from "../../git/tree-ops.ts";
import { writeRepoRefs } from "../../git/refs-store.ts";
import { repositoryObjectStore } from "../../git/repo-object-store.ts";
import type { ObjectStoreBinding } from "../../git/types.ts";
import type { OAuthFetch } from "../../browser-auth.ts";

function router(): RouteRegistry {
  const reg = new RouteRegistry();
  registerRepoRoutes(reg);
  return reg;
}

async function dispatch(
  reg: RouteRegistry,
  request: Request,
  env: RouterEnv,
  fetchMock?: OAuthFetch,
): Promise<Response> {
  const res = await reg.handle({
    request,
    env,
    ...(fetchMock ? { interfaceUserInfoFetch: fetchMock } : {}),
  });
  if (!res) throw new Error("route was not handled");
  return res;
}

describe("code browser — anonymous vs private ACL", () => {
  test("anonymous reads a PUBLIC repo across every endpoint", async () => {
    const handle = makeEnv();
    await seedFullRepo(handle, {
      ownerLogin: "acme",
      name: "web",
      visibility: "public",
      file: "README.md",
      content: "# Web\n",
    });
    const reg = router();

    const info = await dispatch(reg, get("/api/v1/repos/acme/web"), handle.env);
    expect(info.status).toBe(200);
    expect(await info.json()).toMatchObject({
      repository: { fullName: "acme/web", visibility: "public", branchCount: 1 },
    });

    const branches = await dispatch(reg, get("/api/v1/repos/acme/web/branches"), handle.env);
    expect(branches.status).toBe(200);
    expect(await branches.json()).toMatchObject({
      branches: [{ name: "main", default: true }],
    });

    const tree = await dispatch(reg, get("/api/v1/repos/acme/web/tree?ref=main"), handle.env);
    expect(tree.status).toBe(200);
    expect(await tree.json()).toMatchObject({
      entries: [{ name: "README.md", kind: "blob" }],
    });

    const blob = await dispatch(
      reg,
      get("/api/v1/repos/acme/web/blob?ref=main&path=README.md"),
      handle.env,
    );
    expect(blob.status).toBe(200);
    expect(await blob.json()).toMatchObject({ content: "# Web\n", encoding: "utf-8" });
  });

  test("anonymous gets 404 (non-disclosure) on a PRIVATE repo", async () => {
    const handle = makeEnv();
    await seedFullRepo(handle, {
      ownerLogin: "acme",
      name: "secret",
      visibility: "private",
    });
    const reg = router();
    for (const path of [
      "/api/v1/repos/acme/secret",
      "/api/v1/repos/acme/secret/branches",
      "/api/v1/repos/acme/secret/tree?ref=main",
      "/api/v1/repos/acme/secret/blob?ref=main&path=README.md",
    ]) {
      const res = await dispatch(reg, get(path), handle.env);
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
    }
  });

  test("an absent repo is 404", async () => {
    const handle = makeEnv();
    const reg = router();
    const res = await dispatch(reg, get("/api/v1/repos/nobody/ghost"), handle.env);
    expect(res.status).toBe(404);
  });

  test("interface hosting.read reads a private repo it OWNS, but not another's", async () => {
    const handle = makeEnv();
    const aliceId = await seedPrincipal(handle.db, "sub-alice", "service_account");
    await seedOwner(handle.db, "alice", "user", aliceId);
    await seedFullRepo(handle, {
      ownerLogin: "alice",
      name: "web",
      visibility: "private",
    });
    const reg = router();
    const fetchMock = interfaceUserInfoFetch({
      taksrv_tok_alice: { scope: "source.git.hosting.read", subject: "sub-alice" },
      taksrv_tok_other: { scope: "source.git.hosting.read", subject: "sub-other" },
    });

    const owned = await dispatch(
      reg,
      get("/api/v1/repos/alice/web", "taksrv_tok_alice"),
      handle.env,
      fetchMock,
    );
    expect(owned.status).toBe(200);

    const stranger = await dispatch(
      reg,
      get("/api/v1/repos/alice/web", "taksrv_tok_other"),
      handle.env,
      fetchMock,
    );
    expect(stranger.status).toBe(404);
  });

  test("metadata plane absent → 503", async () => {
    const handle = makeEnv();
    const env = { ...handle.env, DB: undefined } as RouterEnv;
    const reg = router();
    const res = await dispatch(reg, get("/api/v1/repos/acme/web"), env);
    expect(res.status).toBe(503);
  });
});

describe("repo list is filtered by readability", () => {
  test("anonymous sees only public repos; owner sees its private too", async () => {
    const handle = makeEnv();
    const aliceId = await seedPrincipal(handle.db, "sub-alice", "service_account");
    await seedOwner(handle.db, "alice", "user", aliceId);
    await seedFullRepo(handle, { ownerLogin: "acme", name: "pub", visibility: "public" });
    await seedFullRepo(handle, { ownerLogin: "alice", name: "priv", visibility: "private" });
    const reg = router();

    const anon = await dispatch(reg, get("/api/v1/repos"), handle.env);
    const anonBody = (await anon.json()) as { repositories: Array<{ fullName: string }> };
    expect(anonBody.repositories.map((r) => r.fullName)).toEqual(["acme/pub"]);

    const fetchMock = interfaceUserInfoFetch({
      taksrv_tok_alice: { scope: "source.git.hosting.read", subject: "sub-alice" },
    });
    const owner = await dispatch(reg, get("/api/v1/repos", "taksrv_tok_alice"), handle.env, fetchMock);
    const ownerBody = (await owner.json()) as { repositories: Array<{ fullName: string }> };
    expect(ownerBody.repositories.map((r) => r.fullName).sort()).toEqual([
      "acme/pub",
      "alice/priv",
    ]);
  });
});

// --- rich commit graph (commit-detail / compare / blame / history) ---------

const SIG = {
  name: "Takos Git",
  email: "git@takos.test",
  timestamp: 1_700_000_000,
  tzOffset: "+0000",
};

async function makeCommit(
  store: ObjectStoreBinding,
  files: Record<string, string>,
  parents: string[],
): Promise<string> {
  const entries: Array<{ path: string; sha: string }> = [];
  for (const [path, content] of Object.entries(files)) {
    const sha = await putBlob(store, new TextEncoder().encode(content));
    entries.push({ path, sha });
  }
  const tree = await buildTreeFromPaths(store, entries);
  return putCommit(store, { tree, parents, author: SIG, committer: SIG, message: "c\n" });
}

async function richSetup(): Promise<{ handle: TestEnvHandle; c1: string; c2: string; c3: string }> {
  const handle = makeEnv();
  await seedOwner(handle.db, "acme", "org", null);
  const storageKey = "acme/proj";
  const now = handle.db.now();
  await handle.db.run(
    `INSERT INTO repositories (id, owner_id, name, storage_key, visibility, default_branch, created_at, updated_at)
     VALUES (?, (SELECT id FROM owners WHERE login='acme'), 'proj', ?, 'public', 'main', ?, ?)`,
    [handle.db.id(), storageKey, now, now],
  );
  const store = repositoryObjectStore(handle.bucket, storageKey);
  const c1 = await makeCommit(store, { "README.md": "v1\ncommon", "docs/guide.md": "g" }, []);
  const c2 = await makeCommit(store, { "README.md": "v1-changed\ncommon", "docs/guide.md": "g" }, [c1]);
  const c3 = await makeCommit(
    store,
    { "README.md": "v1\ncommon", "docs/guide.md": "g", "feature.txt": "feat" },
    [c1],
  );
  await writeRepoRefs(handle.bucket, storageKey, {
    refs: [
      { name: "refs/heads/main", sha: c2 },
      { name: "refs/heads/feature", sha: c3 },
    ],
    defaultBranch: "main",
  });
  return { handle, c1, c2, c3 };
}

describe("rich read endpoints on the router", () => {
  test("commit detail returns the commit and diff vs first parent", async () => {
    const { handle, c1, c2 } = await richSetup();
    const res = await dispatch(router(), get(`/api/v1/repos/acme/proj/commits/${c2}`), handle.env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      commit: { sha: string };
      diff: { base: string; files: Array<{ path: string; status: string }> };
    };
    expect(body.commit.sha).toBe(c2);
    expect(body.diff.base).toBe(c1);
    expect(body.diff.files.find((f) => f.path === "README.md")).toMatchObject({
      status: "modified",
    });
  });

  test("commit detail rejects a malformed object id (new envelope)", async () => {
    const { handle } = await richSetup();
    const res = await dispatch(router(), get("/api/v1/repos/acme/proj/commits/nothex"), handle.env);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "invalid_object_id" } });
  });

  test("commit detail 404s an unreachable SHA", async () => {
    const { handle } = await richSetup();
    const res = await dispatch(
      router(),
      get(`/api/v1/repos/acme/proj/commits/${"a".repeat(40)}`),
      handle.env,
    );
    expect(res.status).toBe(404);
  });

  test("compare reports ahead/behind and merge-base diff", async () => {
    const { handle, c1 } = await richSetup();
    const res = await dispatch(
      router(),
      get("/api/v1/repos/acme/proj/compare/main...feature"),
      handle.env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      mergeBaseSha: string;
      aheadBy: number;
      behindBy: number;
      status: string;
      files: Array<{ path: string; status: string }>;
    };
    expect(body.mergeBaseSha).toBe(c1);
    expect(body.aheadBy).toBe(1);
    expect(body.behindBy).toBe(1);
    expect(body.status).toBe("diverged");
    expect(body.files.find((f) => f.path === "feature.txt")).toMatchObject({ status: "added" });
  });

  test("blame attributes lines by branch name", async () => {
    const { handle, c1, c2 } = await richSetup();
    const res = await dispatch(
      router(),
      get("/api/v1/repos/acme/proj/blame?ref=main&path=README.md"),
      handle.env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lines: Array<{ content: string; commitSha: string }> };
    expect(body.lines.map((l) => [l.content, l.commitSha])).toEqual([
      ["v1-changed", c2],
      ["common", c1],
    ]);
  });

  test("commit history filters by path", async () => {
    const { handle, c1, c2 } = await richSetup();
    const res = await dispatch(
      router(),
      get("/api/v1/repos/acme/proj/commits?ref=main&path=README.md"),
      handle.env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { commits: Array<{ sha: string; pathStatus: string }> };
    expect(body.commits.map((c) => c.sha)).toEqual([c2, c1]);
    expect(body.commits[0]?.pathStatus).toBe("modified");
  });
});

describe("blob size guard", () => {
  test("bounds blob decompression → 413 with the standard envelope", async () => {
    const handle = makeEnv();
    await seedFullRepo(handle, {
      ownerLogin: "acme",
      name: "large",
      visibility: "public",
      file: "large.txt",
      content: "a".repeat(1024 * 1024 + 1),
    });
    const res = await dispatch(
      router(),
      get("/api/v1/repos/acme/large/blob?ref=main&path=large.txt"),
      handle.env,
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({
      error: { code: "blob_too_large", details: { maxBytes: 1024 * 1024 } },
    });
  });
});
