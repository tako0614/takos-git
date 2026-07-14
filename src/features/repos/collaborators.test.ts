import { describe, expect, test } from "bun:test";

import { RouteRegistry, type RouterEnv } from "../../router.ts";
import { registerRepoRoutes } from "./routes.ts";
import {
  get,
  interfaceUserInfoFetch,
  jsonRequest,
  makeEnv,
  type TestEnvHandle,
} from "./testkit.ts";
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
  fetchMock: OAuthFetch,
): Promise<Response> {
  const res = await reg.handle({ request, env, interfaceUserInfoFetch: fetchMock });
  if (!res) throw new Error("route was not handled");
  return res;
}

const tokens = interfaceUserInfoFetch({
  taksrv_alice_w: { scope: "source.git.hosting.write", subject: "sub-alice" },
  taksrv_alice_a: { scope: "source.git.hosting.admin", subject: "sub-alice" },
  taksrv_alice_r: { scope: "source.git.hosting.read", subject: "sub-alice" },
  taksrv_bob_r: { scope: "source.git.hosting.read", subject: "sub-bob" },
  taksrv_bob_a: { scope: "source.git.hosting.admin", subject: "sub-bob" },
});

async function createPrivateRepo(handle: TestEnvHandle, reg: RouteRegistry): Promise<void> {
  await dispatch(
    reg,
    jsonRequest("POST", "/api/v1/repos", { owner: "alice", name: "web", visibility: "private" }, "taksrv_alice_w"),
    handle.env,
    tokens,
  );
}

describe("repo collaborators", () => {
  test("owner adds a writer collaborator, who can then read the private repo", async () => {
    const handle = makeEnv();
    const reg = router();
    await createPrivateRepo(handle, reg);

    // bob has no access yet.
    const before = await dispatch(reg, get("/api/v1/repos/alice/web", "taksrv_bob_r"), handle.env, tokens);
    expect(before.status).toBe(404);

    const grant = await dispatch(
      reg,
      jsonRequest("PUT", "/api/v1/repos/alice/web/collaborators/sub-bob", { role: "writer" }, "taksrv_alice_a"),
      handle.env,
      tokens,
    );
    expect(grant.status).toBe(200);
    expect(await grant.json()).toMatchObject({ principal: "sub-bob", role: "writer" });

    const after = await dispatch(reg, get("/api/v1/repos/alice/web", "taksrv_bob_r"), handle.env, tokens);
    expect(after.status).toBe(200);

    const list = await dispatch(reg, get("/api/v1/repos/alice/web/collaborators", "taksrv_alice_r"), handle.env, tokens);
    expect(await list.json()).toMatchObject({
      collaborators: [{ subject: "sub-bob", role: "writer" }],
    });

    const remove = await dispatch(
      reg,
      jsonRequest("DELETE", "/api/v1/repos/alice/web/collaborators/sub-bob", undefined, "taksrv_alice_a"),
      handle.env,
      tokens,
    );
    expect(remove.status).toBe(200);
    const revoked = await dispatch(reg, get("/api/v1/repos/alice/web", "taksrv_bob_r"), handle.env, tokens);
    expect(revoked.status).toBe(404);
  });

  test("a non-owner cannot add a collaborator", async () => {
    const handle = makeEnv();
    const reg = router();
    await createPrivateRepo(handle, reg);
    // bob (admin scope) is not a member of the private repo → 404 non-disclosure.
    const denied = await dispatch(
      reg,
      jsonRequest("PUT", "/api/v1/repos/alice/web/collaborators/sub-carol", { role: "reader" }, "taksrv_bob_a"),
      handle.env,
      tokens,
    );
    expect(denied.status).toBe(404);
  });

  test("an invalid role is rejected", async () => {
    const handle = makeEnv();
    const reg = router();
    await createPrivateRepo(handle, reg);
    const res = await dispatch(
      reg,
      jsonRequest("PUT", "/api/v1/repos/alice/web/collaborators/sub-bob", { role: "superuser" }, "taksrv_alice_a"),
      handle.env,
      tokens,
    );
    expect(res.status).toBe(400);
  });
});

describe("org teams + team repo access", () => {
  test("team members gain access to an org repo via team grant", async () => {
    const handle = makeEnv();
    const reg = router();

    // alice creates org acme (admin), then a private repo under it.
    await dispatch(reg, jsonRequest("POST", "/api/v1/orgs", { login: "acme" }, "taksrv_alice_a"), handle.env, tokens);
    await dispatch(
      reg,
      jsonRequest("POST", "/api/v1/repos", { owner: "acme", name: "svc", visibility: "private" }, "taksrv_alice_w"),
      handle.env,
      tokens,
    );

    // create a team, add bob, grant the team writer on the repo.
    const team = await dispatch(
      reg,
      jsonRequest("POST", "/api/v1/orgs/acme/teams", { slug: "core", name: "Core" }, "taksrv_alice_a"),
      handle.env,
      tokens,
    );
    expect(team.status).toBe(201);

    await dispatch(
      reg,
      jsonRequest("PUT", "/api/v1/orgs/acme/teams/core/members/sub-bob", { role: "member" }, "taksrv_alice_a"),
      handle.env,
      tokens,
    );

    // before the repo grant, team membership alone gives no access.
    const before = await dispatch(reg, get("/api/v1/repos/acme/svc", "taksrv_bob_r"), handle.env, tokens);
    expect(before.status).toBe(404);

    const grant = await dispatch(
      reg,
      jsonRequest("PUT", "/api/v1/repos/acme/svc/teams/core", { role: "writer" }, "taksrv_alice_a"),
      handle.env,
      tokens,
    );
    expect(grant.status).toBe(200);

    const after = await dispatch(reg, get("/api/v1/repos/acme/svc", "taksrv_bob_r"), handle.env, tokens);
    expect(after.status).toBe(200);

    // listing teams requires org membership; bob (not a member) is 404.
    const bobList = await dispatch(reg, get("/api/v1/orgs/acme/teams", "taksrv_bob_r"), handle.env, tokens);
    expect(bobList.status).toBe(404);
    const aliceList = await dispatch(reg, get("/api/v1/orgs/acme/teams", "taksrv_alice_r"), handle.env, tokens);
    expect(await aliceList.json()).toMatchObject({ teams: [{ slug: "core" }] });
  });

  test("granting a team on a non-org (user) repo is rejected", async () => {
    const handle = makeEnv();
    const reg = router();
    await createPrivateRepo(handle, reg); // alice/web is a USER owner
    const res = await dispatch(
      reg,
      jsonRequest("PUT", "/api/v1/repos/alice/web/teams/core", { role: "writer" }, "taksrv_alice_a"),
      handle.env,
      tokens,
    );
    expect(res.status).toBe(400);
  });
});
