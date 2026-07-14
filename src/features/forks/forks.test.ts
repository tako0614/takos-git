/**
 * Forks feature tests: fork mechanics, network reads, and fast-forward-only
 * upstream sync — happy path, auth (anon / private 404 / not-a-fork), and the
 * key state transitions (up-to-date, fast-forward, diverged).
 */

import { describe, expect, it } from "bun:test";

import { SCOPES } from "../../contract/v1.ts";
import { getCommitData, putCommit } from "../../git/object-store.ts";
import { readRepoRefs, writeRepoRefs } from "../../git/refs-store.ts";
import { repositoryObjectStore } from "../../git/repo-object-store.ts";
import { createSingleFileTree } from "../../git/tree-ops.ts";
import { RouteRegistry } from "../../router.ts";
import type { RouterEnv } from "../../router.ts";
import type { OAuthFetch } from "../../browser-auth.ts";
import type { DbClient } from "../../db/index.ts";
import {
  interfaceUserInfoFetch,
  jsonRequest,
  makeEnv,
  seedFullRepo,
  seedOwner,
  seedPrincipal,
  type TestEnvHandle,
} from "../repos/testkit.ts";
import { resolveOwner } from "../repos/index.ts";
import { forkRepository, getRepoByOwnerName, syncFork } from "./service.ts";
import { registerForkRoutes } from "./routes.ts";

const TOKENS = {
  taksrv_dev_read: { subject: "svc-dev", scope: SCOPES.hostingRead },
  taksrv_dev_write: { subject: "svc-dev", scope: SCOPES.smartHttpWrite },
  taksrv_outsider: { subject: "svc-outsider", scope: SCOPES.hostingRead },
} as const;

function fetcher(): OAuthFetch {
  return interfaceUserInfoFetch(TOKENS);
}

function harness(): { registry: RouteRegistry; env: RouterEnv; handle: TestEnvHandle } {
  const handle = makeEnv();
  const registry = new RouteRegistry();
  registerForkRoutes(registry);
  return { registry, env: handle.env, handle };
}

function dispatch(
  registry: RouteRegistry,
  env: RouterEnv,
  request: Request,
): Promise<Response | null> {
  return registry.handle({ request, env, interfaceUserInfoFetch: fetcher() });
}

/** Add a commit on top of `parentSha` and move `branch` to it (test fixture). */
async function advanceBranch(
  env: RouterEnv,
  storageKey: string,
  branch: string,
  parentSha: string,
  file: string,
  content: string,
): Promise<string> {
  const store = repositoryObjectStore(env.BUCKET, storageKey);
  const treeSha = await createSingleFileTree(
    store,
    file,
    new TextEncoder().encode(content),
  );
  const sig = {
    name: "T",
    email: "t@takos.test",
    timestamp: 1_700_000_100,
    tzOffset: "+0000",
  };
  const sha = await putCommit(store, {
    tree: treeSha,
    parents: [parentSha],
    author: sig,
    committer: sig,
    message: `advance ${content}\n`,
  });
  const doc = await readRepoRefs(env.BUCKET, storageKey);
  const others = doc.refs.filter((r) => r.name !== `refs/heads/${branch}`);
  await writeRepoRefs(env.BUCKET, storageKey, {
    refs: [...others, { name: `refs/heads/${branch}`, sha }],
    defaultBranch: doc.defaultBranch,
  });
  return sha;
}

async function forkWebInto(
  registry: RouteRegistry,
  env: RouterEnv,
  ownerLogin = "acme",
  repoName = "web",
): Promise<Response> {
  const req = jsonRequest(
    "POST",
    `/api/v1/repos/${ownerLogin}/${repoName}/forks`,
    { owner: "devuser" },
    "taksrv_dev_read",
  );
  return (await dispatch(registry, env, req)) as Response;
}

describe("fork create", () => {
  it("forks a readable repo into the caller's namespace", async () => {
    const { registry, env, handle } = harness();
    const source = await seedFullRepo(handle, {
      ownerLogin: "acme",
      name: "web",
      visibility: "public",
      file: "README.md",
      content: "# web\n",
    });

    const res = await forkWebInto(registry, env);
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      repository: { fullName: string; forkOf: string | null; defaultBranch: string };
      forkedFrom: { fullName: string };
      objectsCopied: number;
    };
    expect(body.repository.fullName).toBe("devuser/web");
    expect(body.repository.forkOf).toBe("acme/web");
    expect(body.forkedFrom.fullName).toBe("acme/web");
    expect(body.objectsCopied).toBeGreaterThan(0);

    const db = handle.db;
    // fork_of_id points at the source
    const forkRow = await db.queryOne<{ id: string; fork_of_id: string | null }>(
      `SELECT r.id, r.fork_of_id FROM repositories r JOIN owners o ON o.id = r.owner_id
        WHERE o.login = 'devuser' AND r.name = 'web'`,
      [],
    );
    expect(forkRow?.fork_of_id).toBe(source.repoId);
    // repo_forks network edge recorded
    const edge = await db.queryOne<{ upstream_repo_id: string }>(
      `SELECT upstream_repo_id FROM repo_forks WHERE fork_repo_id = ?`,
      [forkRow!.id],
    );
    expect(edge?.upstream_repo_id).toBe(source.repoId);

    // fork refs mirror the source tip; the commit object was copied
    const forkRefs = await readRepoRefs(env.BUCKET, "devuser/web");
    const main = forkRefs.refs.find((r) => r.name === "refs/heads/main");
    expect(main?.sha).toBe(source.commitSha);
    const forkStore = repositoryObjectStore(env.BUCKET, "devuser/web");
    expect(await getCommitData(forkStore, source.commitSha)).not.toBeNull();

    // ref_index projection for the fork
    const idx = await db.queryOne<{ target_sha: string; is_default: number }>(
      `SELECT target_sha, is_default FROM ref_index WHERE repo_id = ? AND name = 'refs/heads/main'`,
      [forkRow!.id],
    );
    expect(idx?.target_sha).toBe(source.commitSha);
    expect(idx?.is_default).toBe(1);
  });

  it("rejects anonymous forks with 401", async () => {
    const { registry, env, handle } = harness();
    await seedFullRepo(handle, { ownerLogin: "acme", name: "web", visibility: "public" });
    const req = jsonRequest("POST", "/api/v1/repos/acme/web/forks", { owner: "devuser" });
    const res = (await dispatch(registry, env, req)) as Response;
    expect(res.status).toBe(401);
  });

  it("hides a private source behind 404 for a non-member", async () => {
    const { registry, env, handle } = harness();
    await seedFullRepo(handle, {
      ownerLogin: "secretorg",
      name: "vault",
      visibility: "private",
    });
    const req = jsonRequest(
      "POST",
      "/api/v1/repos/secretorg/vault/forks",
      { owner: "outsider" },
      "taksrv_outsider",
    );
    const res = (await dispatch(registry, env, req)) as Response;
    expect(res.status).toBe(404);
  });

  it("rejects forking a repo onto itself (service)", async () => {
    const { handle } = harness();
    const principalId = await seedPrincipal(handle.db, "svc-owner");
    await seedOwner(handle.db, "devuser", "user", principalId);
    const ownerRow = await resolveOwner(handle.db, "devuser");
    await seedFullRepo(handle, {
      ownerLogin: "devuser",
      ownerType: "user",
      ownerPrincipalId: principalId,
      name: "self",
      visibility: "public",
    });
    const source = await getRepoByOwnerName(handle.db, "devuser", "self");
    const outcome = await forkRepository(
      handle.env.BUCKET,
      handle.db,
      source!,
      ownerRow!,
      "self",
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("self_fork");
  });
});

describe("fork list + network", () => {
  it("lists direct fork children and the fork network", async () => {
    const { registry, env, handle } = harness();
    const source = await seedFullRepo(handle, {
      ownerLogin: "acme",
      name: "web",
      visibility: "public",
    });
    expect((await forkWebInto(registry, env)).status).toBe(201);

    const listReq = jsonRequest("GET", "/api/v1/repos/acme/web/forks", undefined, "taksrv_dev_read");
    const listRes = (await dispatch(registry, env, listReq)) as Response;
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { forks: Array<{ fullName: string }> };
    expect(list.forks.map((f) => f.fullName)).toContain("devuser/web");

    const netReq = jsonRequest("GET", "/api/v1/repos/devuser/web/network", undefined, "taksrv_dev_read");
    const netRes = (await dispatch(registry, env, netReq)) as Response;
    expect(netRes.status).toBe(200);
    const net = (await netRes.json()) as {
      root: { fullName: string } | null;
      repositories: Array<{ fullName: string }>;
    };
    expect(net.root?.fullName).toBe("acme/web");
    const names = net.repositories.map((r) => r.fullName);
    expect(names).toContain("acme/web");
    expect(names).toContain("devuser/web");
    expect(source.repoId).toBeDefined();
  });
});

describe("sync with upstream (fast-forward only)", () => {
  async function seededFork(): Promise<{
    registry: RouteRegistry;
    env: RouterEnv;
    db: DbClient;
    baseSha: string;
  }> {
    const { registry, env, handle } = harness();
    const source = await seedFullRepo(handle, {
      ownerLogin: "acme",
      name: "web",
      visibility: "public",
    });
    expect((await forkWebInto(registry, env)).status).toBe(201);
    return { registry, env, db: handle.db, baseSha: source.commitSha };
  }

  it("reports already-up-to-date when nothing changed upstream", async () => {
    const { registry, env } = await seededFork();
    const req = jsonRequest("POST", "/api/v1/repos/devuser/web/sync", {}, "taksrv_dev_write");
    const res = (await dispatch(registry, env, req)) as Response;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { synced: boolean; alreadyUpToDate: boolean; commitsSynced: number };
    expect(body.synced).toBe(true);
    expect(body.alreadyUpToDate).toBe(true);
    expect(body.commitsSynced).toBe(0);
  });

  it("fast-forwards the fork to the upstream tip", async () => {
    const { registry, env, db, baseSha } = await seededFork();
    const upstreamTip = await advanceBranch(env, "acme/web", "main", baseSha, "README.md", "v2");

    const req = jsonRequest("POST", "/api/v1/repos/devuser/web/sync", { branch: "main" }, "taksrv_dev_write");
    const res = (await dispatch(registry, env, req)) as Response;
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      synced: boolean;
      newHead: string;
      previousHead: string | null;
      commitsSynced: number;
    };
    expect(body.synced).toBe(true);
    expect(body.newHead).toBe(upstreamTip);
    expect(body.previousHead).toBe(baseSha);
    expect(body.commitsSynced).toBe(1);

    const forkRefs = await readRepoRefs(env.BUCKET, "devuser/web");
    expect(forkRefs.refs.find((r) => r.name === "refs/heads/main")?.sha).toBe(upstreamTip);
    const forkStore = repositoryObjectStore(env.BUCKET, "devuser/web");
    expect(await getCommitData(forkStore, upstreamTip)).not.toBeNull();

    // ref_index + last_synced_at projected
    const forkRow = await db.queryOne<{ id: string }>(
      `SELECT r.id FROM repositories r JOIN owners o ON o.id = r.owner_id WHERE o.login='devuser' AND r.name='web'`,
      [],
    );
    const synced = await db.queryOne<{ last_synced_at: number | null }>(
      `SELECT last_synced_at FROM repo_forks WHERE fork_repo_id = ?`,
      [forkRow!.id],
    );
    expect(synced?.last_synced_at).not.toBeNull();
  });

  it("refuses a non-fast-forward (diverged) sync", async () => {
    const { registry, env, baseSha } = await seededFork();
    // upstream advances one way, fork advances another from the same base
    await advanceBranch(env, "acme/web", "main", baseSha, "README.md", "upstream-change");
    await advanceBranch(env, "devuser/web", "main", baseSha, "README.md", "local-change");

    const req = jsonRequest("POST", "/api/v1/repos/devuser/web/sync", { branch: "main" }, "taksrv_dev_write");
    const res = (await dispatch(registry, env, req)) as Response;
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("diverged");
  });

  it("rejects sync on a repo that is not a fork (service)", async () => {
    const { handle } = harness();
    await seedFullRepo(handle, { ownerLogin: "solo", name: "app", visibility: "public" });
    const row = await getRepoByOwnerName(handle.db, "solo", "app");
    const outcome = await syncFork(handle.env.BUCKET, handle.db, row!, "main");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("not_a_fork");
  });

  it("rejects anonymous sync with 401", async () => {
    const { registry, env } = await seededFork();
    const req = jsonRequest("POST", "/api/v1/repos/devuser/web/sync", {});
    const res = (await dispatch(registry, env, req)) as Response;
    expect(res.status).toBe(401);
  });
});
