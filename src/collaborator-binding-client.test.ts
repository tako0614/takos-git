// Synthetic UserInfo, fake D1 and memory R2; actual SPA client and API handlers.
import { expect, test } from "bun:test";

import { collaboratorsApi } from "../web/src/api/admin.ts";
import { RouteRegistry } from "./router.ts";
import { registerRepoRoutes } from "./features/repos/routes.ts";
import {
  interfaceUserInfoFetch,
  jsonRequest,
  makeEnv,
  TEST_APP_URL,
} from "./features/repos/testkit.ts";

async function fixture() {
  const handle = makeEnv();
  const registry = new RouteRegistry();
  registerRepoRoutes(registry);
  const userInfo = interfaceUserInfoFetch({
    taksrv_fixture_owner_write: { subject: "alice", scope: "source.git.hosting.write" },
    taksrv_fixture_owner_admin: { subject: "alice", scope: "source.git.hosting.admin" },
    taksrv_fixture_owner_read: { subject: "alice", scope: "source.git.hosting.read" },
    taksrv_fixture_reader: { subject: "bob", bindingId: "binding-two", scope: "source.git.hosting.admin" },
  });
  const dispatch = async (request: Request) => {
    const response = await registry.handle({ request, env: handle.env, interfaceUserInfoFetch: userInfo });
    if (!response) throw new Error("unhandled local route");
    return response;
  };
  const create = await dispatch(jsonRequest("POST", "/api/v1/repos", {
    owner: "alice", name: "widgets", visibility: "private",
  }, "taksrv_fixture_owner_write"));
  expect(create.status).toBe(201);
  const grants = new Map<string, string>();
  for (const [bindingId, role] of [[undefined, "maintainer"], ["binding-one", "writer"], ["binding-two", "reader"]] as const) {
    const response = await dispatch(jsonRequest("PUT", "/api/v1/repos/alice/widgets/collaborators/bob", {
      role, ...(bindingId ? { bindingId } : {}),
    }, "taksrv_fixture_owner_admin"));
    expect(response.status).toBe(200);
    const body = await response.json() as { principalId: string };
    grants.set(bindingId ?? "", body.principalId);
  }
  const rows = () => handle.db.query<{ bindingId: string; role: string }>(
    `SELECT p.binding_id AS bindingId, rc.role FROM repo_collaborators rc
     JOIN principals p ON p.id = rc.principal_id ORDER BY p.binding_id`,
  );
  const withClient = async (run: () => Promise<void>) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof input !== "string" || !input.startsWith("/api/v1/")) {
        throw new Error("fixture refuses external traffic");
      }
      const headers = new Headers(init?.headers);
      // Test transport supplies a valid-shaped local owner Interface credential;
      // this is not browser Cookie/SSO qualification or an auth bypass in source.
      headers.set("authorization", `Bearer ${init?.method === "GET" ? "taksrv_fixture_owner_read" : "taksrv_fixture_owner_admin"}`);
      return dispatch(new Request(new URL(input, TEST_APP_URL), { ...init, headers }));
    }) as typeof fetch;
    try { await run(); } finally { globalThis.fetch = originalFetch; }
  };
  return { dispatch, rows, grants, withClient };
}

test("SPA role update preserves the selected Interface binding and sibling grants", async () => {
  const handle = await fixture();
  await handle.withClient(async () => {
    await collaboratorsApi.set("alice", "widgets", "bob", "reader", "binding-one");
  });
  expect(await handle.rows()).toEqual([
    { bindingId: "", role: "maintainer" },
    { bindingId: "binding-one", role: "reader" },
    { bindingId: "binding-two", role: "reader" },
  ]);
});

test("SPA removes one selected grant without revoking another binding or the person", async () => {
  const handle = await fixture();
  await handle.withClient(async () => {
    await collaboratorsApi.remove("alice", "widgets", "bob", handle.grants.get("binding-one")!);
  });
  expect(await handle.rows()).toEqual([
    { bindingId: "", role: "maintainer" },
    { bindingId: "binding-two", role: "reader" },
  ]);
});

test("normal collaborator list identifies a typed Principal and exact service binding", async () => {
  const handle = await fixture();
  await handle.withClient(async () => {
    const listed = await collaboratorsApi.list("alice", "widgets");
    expect(listed.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        principalId: handle.grants.get("binding-one"),
        bindingId: "binding-one",
        principal: { id: handle.grants.get("binding-one"), subject: "bob", displayName: null },
        role: "writer",
      }),
      expect.objectContaining({ principalId: handle.grants.get(""), bindingId: null }),
    ]));
  });
});

test("person updates and deletion stay separate from service grants", async () => {
  const handle = await fixture();
  await handle.withClient(async () => {
    await collaboratorsApi.set("alice", "widgets", "bob", "reader");
    expect(await handle.rows()).toEqual([
      { bindingId: "", role: "reader" },
      { bindingId: "binding-one", role: "writer" },
      { bindingId: "binding-two", role: "reader" },
    ]);
    await collaboratorsApi.remove("alice", "widgets", "bob", handle.grants.get("")!);
    await collaboratorsApi.set("alice", "widgets", "carol", "writer", "new-binding");
  });
  expect(await handle.rows()).toEqual([
    { bindingId: "binding-one", role: "writer" },
    { bindingId: "binding-two", role: "reader" },
    { bindingId: "new-binding", role: "writer" },
  ]);
});

test("selected removal validates its selector and retains subject, repo and owner fences", async () => {
  const handle = await fixture();
  const before = await handle.rows();
  for (const selector of ["", "%00", "%20", "one&principalId=two"]) {
    const response = await handle.dispatch(jsonRequest("DELETE",
      `/api/v1/repos/alice/widgets/collaborators/bob?principalId=${selector}`,
      undefined, "taksrv_fixture_owner_admin"));
    expect(response.status).toBe(400);
    expect(await handle.rows()).toEqual(before);
  }
  for (const path of [
    `/api/v1/repos/alice/widgets/collaborators/not-bob?principalId=${handle.grants.get("binding-one")}`,
    "/api/v1/repos/alice/widgets/collaborators/bob?principalId=unknown",
  ]) {
    const response = await handle.dispatch(jsonRequest("DELETE", path, undefined, "taksrv_fixture_owner_admin"));
    expect(response.status).toBe(200);
    expect(await handle.rows()).toEqual(before);
  }
  const denied = await handle.dispatch(jsonRequest("DELETE",
    `/api/v1/repos/alice/widgets/collaborators/bob?principalId=${handle.grants.get("binding-one")}`,
    undefined, "taksrv_fixture_reader"));
  expect(denied.status).toBe(404);
  expect(await handle.rows()).toEqual(before);
  const missingRepo = await handle.dispatch(jsonRequest("DELETE",
    `/api/v1/repos/alice/missing/collaborators/bob?principalId=${handle.grants.get("binding-one")}`,
    undefined, "taksrv_fixture_owner_admin"));
  expect(missingRepo.status).toBe(404);
  expect(await handle.rows()).toEqual(before);
});

test("legacy subject-wide API removal retains its documented behavior", async () => {
  const handle = await fixture();
  const response = await handle.dispatch(jsonRequest("DELETE",
    "/api/v1/repos/alice/widgets/collaborators/bob", undefined, "taksrv_fixture_owner_admin"));
  expect(response.status).toBe(200);
  expect(await handle.rows()).toEqual([]);
});
