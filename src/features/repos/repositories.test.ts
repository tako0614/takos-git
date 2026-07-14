import { describe, expect, test } from "bun:test";

import { RouteRegistry, type RouterEnv } from "../../router.ts";
import { registerRepoRoutes } from "./routes.ts";
import {
  get,
  interfaceUserInfoFetch,
  jsonRequest,
  makeEnv,
  seedOwner,
  seedPrincipal,
} from "./testkit.ts";
import { repoExists } from "../../git/refs-store.ts";
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

const tokens = interfaceUserInfoFetch({
  taksrv_alice_w: { scope: "source.git.hosting.write", subject: "sub-alice" },
  taksrv_alice_a: { scope: "source.git.hosting.admin", subject: "sub-alice" },
  taksrv_alice_r: { scope: "source.git.hosting.read", subject: "sub-alice" },
  taksrv_bob_w: { scope: "source.git.hosting.write", subject: "sub-bob" },
  taksrv_bob_a: { scope: "source.git.hosting.admin", subject: "sub-bob" },
});

describe("repository CRUD via router + ACL", () => {
  test("create auto-provisions the personal owner and the R2 refs-doc", async () => {
    const handle = makeEnv();
    const reg = router();
    const res = await dispatch(
      reg,
      jsonRequest("POST", "/api/v1/repos", { owner: "alice", name: "web", visibility: "private" }, "taksrv_alice_w"),
      handle.env,
      tokens,
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      repository: { owner: "alice", name: "web", fullName: "alice/web", visibility: "private" },
    });
    // R2 refs-doc exists, and the owner row is bound to the creating principal.
    expect(await repoExists(handle.bucket, "alice/web")).toBe(true);
    const owner = await handle.db.queryOne<{ type: string; principal_id: string | null }>(
      `SELECT type, principal_id FROM owners WHERE login = 'alice'`,
    );
    expect(owner?.type).toBe("user");
    expect(owner?.principal_id).not.toBeNull();
  });

  test("the owner can read its own new private repo (interface hosting.read)", async () => {
    const handle = makeEnv();
    const reg = router();
    await dispatch(
      reg,
      jsonRequest("POST", "/api/v1/repos", { owner: "alice", name: "web", visibility: "private" }, "taksrv_alice_w"),
      handle.env,
      tokens,
    );
    const read = await dispatch(reg, get("/api/v1/repos/alice/web", "taksrv_alice_r"), handle.env, tokens);
    expect(read.status).toBe(200);
  });

  test("anonymous create is rejected 401", async () => {
    const handle = makeEnv();
    const res = await dispatch(
      router(),
      jsonRequest("POST", "/api/v1/repos", { owner: "alice", name: "web" }, undefined),
      handle.env,
    );
    expect(res.status).toBe(401);
  });

  test("cannot create under another user's existing namespace (403)", async () => {
    const handle = makeEnv();
    const aliceId = await seedPrincipal(handle.db, "sub-alice", "user");
    await seedOwner(handle.db, "alice", "user", aliceId);
    const res = await dispatch(
      router(),
      jsonRequest("POST", "/api/v1/repos", { owner: "alice", name: "x" }, "taksrv_bob_w"),
      handle.env,
      tokens,
    );
    expect(res.status).toBe(403);
  });

  test("duplicate create is 409", async () => {
    const handle = makeEnv();
    const reg = router();
    const body = { owner: "alice", name: "web" };
    await dispatch(reg, jsonRequest("POST", "/api/v1/repos", body, "taksrv_alice_w"), handle.env, tokens);
    const dup = await dispatch(reg, jsonRequest("POST", "/api/v1/repos", body, "taksrv_alice_w"), handle.env, tokens);
    expect(dup.status).toBe(409);
  });

  test("patch updates settings (maintainer+)", async () => {
    const handle = makeEnv();
    const reg = router();
    await dispatch(
      reg,
      jsonRequest("POST", "/api/v1/repos", { owner: "alice", name: "web", visibility: "private" }, "taksrv_alice_w"),
      handle.env,
      tokens,
    );
    const patched = await dispatch(
      reg,
      jsonRequest("PATCH", "/api/v1/repos/alice/web", { description: "hello", visibility: "public" }, "taksrv_alice_a"),
      handle.env,
      tokens,
    );
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({
      repository: { description: "hello", visibility: "public" },
    });
  });

  test("delete removes the D1 row and R2 objects (owner only)", async () => {
    const handle = makeEnv();
    const reg = router();
    await dispatch(
      reg,
      jsonRequest("POST", "/api/v1/repos", { owner: "alice", name: "web" }, "taksrv_alice_w"),
      handle.env,
      tokens,
    );
    const removed = await dispatch(
      reg,
      jsonRequest("DELETE", "/api/v1/repos/alice/web", undefined, "taksrv_alice_a"),
      handle.env,
      tokens,
    );
    expect(removed.status).toBe(200);
    expect(await repoExists(handle.bucket, "alice/web")).toBe(false);
    const gone = await dispatch(reg, get("/api/v1/repos/alice/web", "taksrv_alice_r"), handle.env, tokens);
    expect(gone.status).toBe(404);
  });

  test("a non-owner cannot delete (404 for a private repo they cannot see)", async () => {
    const handle = makeEnv();
    const reg = router();
    await dispatch(
      reg,
      jsonRequest("POST", "/api/v1/repos", { owner: "alice", name: "web", visibility: "private" }, "taksrv_alice_w"),
      handle.env,
      tokens,
    );
    const denied = await dispatch(
      reg,
      jsonRequest("DELETE", "/api/v1/repos/alice/web", undefined, "taksrv_bob_a"),
      handle.env,
      tokens,
    );
    expect(denied.status).toBe(404);
  });
});

describe("org creation + repo under an org", () => {
  test("create an org, then a repo under it as admin", async () => {
    const handle = makeEnv();
    const reg = router();
    const org = await dispatch(
      reg,
      jsonRequest("POST", "/api/v1/orgs", { login: "acme", name: "Acme" }, "taksrv_alice_a"),
      handle.env,
      tokens,
    );
    expect(org.status).toBe(201);
    expect(await org.json()).toMatchObject({ org: { login: "acme", type: "org" } });

    const repo = await dispatch(
      reg,
      jsonRequest("POST", "/api/v1/repos", { owner: "acme", name: "svc" }, "taksrv_alice_w"),
      handle.env,
      tokens,
    );
    expect(repo.status).toBe(201);

    // A non-admin cannot create under the org.
    const denied = await dispatch(
      reg,
      jsonRequest("POST", "/api/v1/repos", { owner: "acme", name: "other" }, "taksrv_bob_w"),
      handle.env,
      tokens,
    );
    expect(denied.status).toBe(403);
  });
});
