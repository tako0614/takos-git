// Synthetic issuer, fake D1 and memory R2; all membership changes use actual APIs.
import { expect, test } from "bun:test";
import { createGitWorker } from "../../worker.ts";
import {
  jsonRequest,
  makeEnv,
  TEST_APP_URL,
  TEST_CAPSULE,
  TEST_WORKSPACE,
} from "./testkit.ts";

const claims = {
  taksrv_org_owner_admin: { sub: "alice", binding: "binding_owner_api", path: "/api/v1", scope: "source.git.hosting.admin" },
  taksrv_org_owner_read: { sub: "alice", binding: "binding_owner_api", path: "/api/v1", scope: "source.git.hosting.read" },
  taksrv_org_bob_admin: { sub: "bob", binding: "binding_bob_api", path: "/api/v1", scope: "source.git.hosting.admin" },
  taksrv_org_bob_read: { sub: "bob", binding: "binding_bob_api", path: "/api/v1", scope: "source.git.hosting.read" },
  taksrv_org_bob_mcp: { sub: "bob", binding: "binding_bob_mcp", path: "/mcp", scope: "mcp.invoke" },
} as const;

async function fixture() {
  const handle = makeEnv();
  const worker = createGitWorker(async (_input, init) => {
    const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer\s+/u, "");
    const claim = claims[token as keyof typeof claims];
    if (!claim) return new Response(null, { status: 401 });
    return Response.json({
      token_use: "interface_oauth", sub: claim.sub,
      aud: TEST_APP_URL + claim.path, scope: claim.scope,
      takosumi: {
        workspace_id: TEST_WORKSPACE, capsule_id: TEST_CAPSULE,
        interface_id: `interface_${claim.path === "/mcp" ? "mcp" : "hosting"}`,
        interface_binding_id: claim.binding, interface_resolved_revision: 1,
      },
    });
  });
  const request = (method: string, path: string, body?: unknown, token = "taksrv_org_owner_admin") =>
    worker.fetch(jsonRequest(method, path, body, token), handle.env);
  const create = await request("POST", "/api/v1/orgs", { login: "Acme" });
  expect(create.status).toBe(201);
  const mcpCreate = async (repo: string) => {
    const response = await worker.fetch(jsonRequest("POST", "/mcp", {
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "git_repo_create", arguments: { repo } },
    }, "taksrv_org_bob_mcp"), handle.env);
    expect(response.status).toBe(200);
    return response.json() as Promise<{
      error?: { message: string };
      result?: { structuredContent: { repo: string } };
    }>;
  };
  const withoutMetadata = (method: string, path: string, body?: unknown) => worker.fetch(
    jsonRequest(method, path, body, "taksrv_org_owner_admin"), { ...handle.env, DB: undefined },
  );
  return { request, mcpCreate, withoutMetadata };
}

test("org owner can authorize a distinct MCP binding through the membership API", async () => {
  const handle = await fixture();
  expect((await handle.mcpCreate("Acme/widgets")).error?.message).toBe("forbidden");
  const grant = await handle.request("PUT", "/api/v1/orgs/acme/members/bob", {
    role: "admin", bindingId: "binding_bob_mcp",
  });
  expect(grant.status).toBe(200);
  const created = await handle.mcpCreate("Acme/widgets");
  expect(created.error).toBeUndefined();
  expect(created.result?.structuredContent.repo).toBe("Acme/widgets");
});

test("current members can page exact identities while another binding stays outside the org", async () => {
  const handle = await fixture();
  const path = "/api/v1/orgs/acme/members";
  expect((await handle.request("GET", path, undefined, "taksrv_org_bob_read")).status).toBe(404);
  expect((await handle.request("PUT", path + "/%20", { role: "member" })).status).toBe(400);
  expect((await handle.request("DELETE", path + "/%20")).status).toBe(400);
  for (const bindingId of [undefined, "binding_bob_mcp", "binding_bob_api"]) {
    const grant = await handle.request("PUT", path + "/bob", {
      role: bindingId === "binding_bob_mcp" ? "admin" : "member",
      ...(bindingId ? { bindingId } : {}),
    });
    expect(grant.status).toBe(200);
  }
  const response = await handle.request("GET", path, undefined, "taksrv_org_owner_read");
  expect(response.status).toBe(200);
  const all = await response.json() as { members: { principalId: string; subject: string; bindingId: string | null; role: string }[] };
  expect(all.members).toHaveLength(4);
  expect(all.members).toEqual(expect.arrayContaining([
    expect.objectContaining({ subject: "bob", bindingId: null, role: "member" }),
    expect.objectContaining({ subject: "bob", bindingId: "binding_bob_api", role: "member" }),
    expect.objectContaining({ subject: "bob", bindingId: "binding_bob_mcp", role: "admin" }),
  ]));
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const response = await handle.request("GET", path + "?limit=1" + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""), undefined, "taksrv_org_bob_read");
    expect(response.status).toBe(200);
    const page = await response.json() as { members: { principalId: string }[]; nextCursor: string | null };
    expect(page.members).toHaveLength(1);
    ids.push(page.members[0]!.principalId);
    cursor = page.nextCursor;
    expect(ids.length).toBeLessThanOrEqual(4);
  } while (cursor);
  expect(ids).toEqual(all.members.map(member => member.principalId));
  expect(new Set(ids).size).toBe(4);
  // A current member is not an admin because another binding of Bob is one.
  expect((await handle.request("PUT", path + "/eve", { role: "admin" }, "taksrv_org_bob_admin")).status).toBe(403);
});

test("revocation targets one org and cannot remove or demote its final admin", async () => {
  const handle = await fixture();
  expect((await handle.request("POST", "/api/v1/orgs", { login: "Other" })).status).toBe(201);
  let bobId = "";
  for (const org of ["acme", "other"]) {
    const grant = await handle.request("PUT", `/api/v1/orgs/${org}/members/bob`, {
      role: "admin", bindingId: "binding_bob_mcp",
    });
    expect(grant.status).toBe(200);
    const body = await grant.json() as { member: { principalId: string } };
    bobId = body.member.principalId;
  }
  const removed = await handle.request("DELETE", `/api/v1/orgs/acme/members/${bobId}`);
  expect(removed.status).toBe(200);
  expect((await handle.mcpCreate("Acme/revoked")).error?.message).toBe("forbidden");
  expect((await handle.mcpCreate("Other/retained")).result?.structuredContent.repo).toBe("Other/retained");
  const response = await handle.request("GET", "/api/v1/orgs/acme/members", undefined, "taksrv_org_owner_read");
  const body = await response.json() as { members: { principalId: string; role: string }[] };
  expect(body.members).toHaveLength(1);
  const ownerId = body.members[0]!.principalId;
  const demote = await handle.request("PUT", "/api/v1/orgs/acme/members/alice", {
    role: "member", bindingId: "binding_owner_api",
  });
  expect(demote.status).toBe(409);
  expect((await demote.json() as { error: { code: string } }).error.code).toBe("last_admin");
  const removeOwner = await handle.request("DELETE", `/api/v1/orgs/acme/members/${ownerId}`);
  expect(removeOwner.status).toBe(409);
  expect((await removeOwner.json() as { error: { code: string } }).error.code).toBe("last_admin");
  expect((await handle.request("DELETE", `/api/v1/orgs/acme/members/${bobId}`)).status).toBe(200);
  const retained = await handle.request("GET", "/api/v1/orgs/acme/members", undefined, "taksrv_org_owner_read");
  expect((await retained.json() as { members: unknown[] }).members).toEqual(body.members);
});

test("concurrent admin self-demotions and self-removals always retain an admin", async () => {
  for (const operation of ["demote", "remove"]) {
    const handle = await fixture();
    const grant = await handle.request("PUT", "/api/v1/orgs/acme/members/bob", { role: "admin", bindingId: "binding_bob_api" });
    expect(grant.status).toBe(200);
    const listed = await handle.request("GET", "/api/v1/orgs/acme/members", undefined, "taksrv_org_owner_read");
    const members = (await listed.json() as { members: { principalId: string; subject: string }[] }).members;
    const subjects = ["alice", "bob"];
    const tokens = ["taksrv_org_owner_admin", "taksrv_org_bob_admin"];
    const responses = await Promise.all(subjects.map((subject, i) => operation === "demote"
      ? handle.request("PUT", `/api/v1/orgs/acme/members/${subject}`, {
          role: "member", bindingId: i === 0 ? "binding_owner_api" : "binding_bob_api",
        }, tokens[i])
      : handle.request("DELETE", `/api/v1/orgs/acme/members/${members.find(member => member.subject === subject)!.principalId}`, undefined, tokens[i])));
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    const retainedAdmin = responses.findIndex(response => response.status === 409);
    const readToken = retainedAdmin === 0 ? "taksrv_org_owner_read" : "taksrv_org_bob_read";
    const after = await handle.request("GET", "/api/v1/orgs/acme/members", undefined, readToken);
    expect(after.status).toBe(200);
    const roles = (await after.json() as { members: { role: string }[] }).members;
    expect(roles.filter(member => member.role === "admin")).toHaveLength(1);
  }
});

test("invalid inputs and non-admin mutation preserve the existing membership list", async () => {
  const handle = await fixture();
  const path = "/api/v1/orgs/acme/members";
  const before = await (await handle.request("GET", path, undefined, "taksrv_org_owner_read")).json();
  for (const body of [
    { role: "owner" }, { role: "admin", bindingId: "" },
    { role: "admin", bindingId: "   " }, { role: "admin", bindingId: " binding " },
    { role: "admin", bindingId: "x".repeat(513) },
  ]) expect((await handle.request("PUT", path + "/bob", body)).status).toBe(400);
  for (const query of ["?limit=0", "?limit=101", "?limit=1&limit=2", "?cursor=%20", "?cursor=x&cursor=y"]) {
    expect((await handle.request("GET", path + query, undefined, "taksrv_org_owner_read")).status).toBe(400);
  }
  expect((await handle.request("PUT", path + "/bob", { role: "admin" }, "taksrv_org_bob_admin")).status).toBe(403);
  expect((await handle.request("PUT", path + "/bob", { role: "admin" }, "taksrv_org_owner_read")).status).toBe(401);
  expect((await handle.request("GET", path, undefined, "taksrv_org_bob_mcp")).status).toBe(401);
  expect((await handle.request("GET", path, undefined, "taksrv_unknown")).status).toBe(401);
  expect((await handle.request("GET", path, undefined, "taksrv_org_bob_read")).status).toBe(404);
  const after = await (await handle.request("GET", path, undefined, "taksrv_org_owner_read")).json();
  expect(after).toEqual(before);
});

test("membership endpoints fail closed without the metadata plane", async () => {
  const handle = await fixture();
  for (const [method, path, body] of [
    ["GET", "/api/v1/orgs/acme/members", undefined],
    ["PUT", "/api/v1/orgs/acme/members/bob", { role: "member" }],
    ["DELETE", "/api/v1/orgs/acme/members/unknown", undefined],
  ] as const) {
    expect((await handle.withoutMetadata(method, path, body)).status).toBe(503);
  }
});
