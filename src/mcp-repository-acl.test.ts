// takos-secret-scan: synthetic — fake D1, disposable bucket, verified-shaped test broker claims only.
import { expect, spyOn, test } from "bun:test";

import { createGitWorker } from "./worker.ts";
import { upsertPrincipal } from "./auth/acl.ts";
import { createOrgOwner } from "./features/repos/owners.ts";
import {
  makeEnv,
  seedFullRepo,
  TEST_APP_URL,
  TEST_CAPSULE,
  TEST_ISSUER,
  TEST_WORKSPACE,
} from "./features/repos/testkit.ts";

type Claim = {
  subject: string;
  scope: "mcp.invoke" | "source.git.smart_http.read";
  path: "/mcp" | "/git";
  bindingId: string;
};

const claims: Record<string, Claim> = {
  taksrv_alice_mcp: {
    subject: "alice",
    scope: "mcp.invoke",
    path: "/mcp",
    bindingId: "binding_alice_mcp",
  },
  taksrv_bob_mcp: {
    subject: "bob",
    scope: "mcp.invoke",
    path: "/mcp",
    bindingId: "binding_bob_mcp",
  },
  taksrv_bob_git_read: {
    subject: "bob",
    scope: "source.git.smart_http.read",
    path: "/git",
    bindingId: "binding_bob_git_read",
  },
  taksrv_alice_other_mcp: {
    subject: "alice",
    scope: "mcp.invoke",
    path: "/mcp",
    bindingId: "binding_alice_other_mcp",
  },
};

const worker = createGitWorker(async (_input, init) => {
  const bearer = new Headers(init?.headers)
    .get("authorization")
    ?.replace(/^Bearer\s+/u, "");
  const claim = bearer ? claims[bearer] : undefined;
  if (!claim) return new Response(null, { status: 401 });
  return Response.json({
    token_use: "interface_oauth",
    sub: claim.subject,
    aud: `${TEST_APP_URL}${claim.path}`,
    scope: claim.scope,
    takosumi: {
      workspace_id: TEST_WORKSPACE,
      capsule_id: TEST_CAPSULE,
      interface_id: `interface_${claim.path.slice(1)}`,
      interface_binding_id: claim.bindingId,
      interface_resolved_revision: 1,
    },
  });
});

function mcpRequest(token: string, name: string, args: Record<string, unknown>) {
  return new Request(`${TEST_APP_URL}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
}

async function call(
  env: ReturnType<typeof makeEnv>["env"],
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await worker.fetch(mcpRequest(token, name, args), env);
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    result?: { structuredContent?: Record<string, unknown> };
    error?: unknown;
  };
  expect(body.error).toBeUndefined();
  return body.result?.structuredContent ?? {};
}

async function denied(
  env: ReturnType<typeof makeEnv>["env"],
  token: string,
  name: string,
  args: Record<string, unknown>,
  reason: "not_found" | "forbidden",
): Promise<void> {
  const response = await worker.fetch(mcpRequest(token, name, args), env);
  expect(response.status).toBe(200);
  const body = await response.json() as {
    result?: unknown;
    error?: { code: number; message: string };
  };
  expect(body.result).toBeUndefined();
  expect(body.error?.message).toBe(reason);
}

test("MCP Interface principal is fenced by repo ACL and owner namespace", async () => {
  const handle = makeEnv();

  // Establish Alice's Interface principal as the owner of her namespace.
  await call(handle.env, "taksrv_alice_mcp", "git_repo_create", {
    repo: "alice/bootstrap",
  });
  const owner = await handle.db.queryOne<{ principal_id: string }>(
    `SELECT principal_id FROM owners WHERE login = 'alice'`,
  );
  expect(owner?.principal_id).toBeTruthy();
  const alicePrincipalId = owner?.principal_id as string;

  const seeded = await seedFullRepo(handle, {
    ownerLogin: "alice",
    ownerType: "user",
    ownerPrincipalId: alicePrincipalId,
    name: "secret",
    visibility: "private",
  });

  // Authentication works, and the same Bob principal is denied by smart HTTP.
  const badAuth = await worker.fetch(
    mcpRequest("taksrv_not_a_real_token", "git_repo_list", {}),
    handle.env,
  );
  expect(badAuth.status).toBe(401);
  const smartHttp = await worker.fetch(
    new Request(
      `${TEST_APP_URL}/git/alice/secret.git/info/refs?service=git-upload-pack`,
      { headers: { authorization: "Bearer taksrv_bob_git_read" } },
    ),
    handle.env,
  );
  expect(smartHttp.status).toBe(404);

  // Positive control: Alice can read the private repository through MCP.
  const aliceListed = await call(handle.env, "taksrv_alice_mcp", "git_repo_list", {});
  expect(aliceListed.repos).toContain("alice/secret");
  const aliceInfo = await call(handle.env, "taksrv_alice_mcp", "git_repo_info", {
    repo: "alice/secret",
  });
  expect(aliceInfo.repo).toBe("alice/secret");
  expect(aliceInfo.refs).toEqual([
    { name: "refs/heads/main", sha: seeded.commitSha },
  ]);

  // Bob cannot discover or read Alice's private repository.
  const bobListed = await call(handle.env, "taksrv_bob_mcp", "git_repo_list", {});
  expect(bobListed.repos).not.toContain("alice/secret");
  await denied(
    handle.env,
    "taksrv_bob_mcp",
    "git_repo_info",
    { repo: "alice/secret" },
    "not_found",
  );

  // Bob cannot create inside Alice's namespace, but can create his own.
  await denied(
    handle.env,
    "taksrv_bob_mcp",
    "git_repo_create",
    { repo: "alice/bob-created" },
    "forbidden",
  );
  const createdRow = await handle.db.queryOne<{
    owner_principal_id: string;
    visibility: string;
  }>(
    `SELECT o.principal_id AS owner_principal_id, r.visibility
       FROM repositories r JOIN owners o ON o.id = r.owner_id
      WHERE r.storage_key = 'alice/bob-created'`,
  );
  expect(createdRow).toBeNull();
  const bobCreated = await call(handle.env, "taksrv_bob_mcp", "git_repo_create", {
    repo: "bob/own",
  });
  expect(bobCreated.repo).toBe("bob/own");

  // Bob cannot quarantine Alice's private repository without repo.admin.
  await denied(
    handle.env,
    "taksrv_bob_mcp",
    "git_repo_delete",
    { repo: "alice/secret" },
    "not_found",
  );
  const deletedRow = await handle.db.queryOne<{
    lifecycle_state: string;
    repo_id: string;
  }>(
    `SELECT lifecycle_state, id AS repo_id FROM repositories
      WHERE storage_key = 'alice/secret'`,
  );
  expect(deletedRow).toEqual({
    lifecycle_state: "active",
    repo_id: seeded.repoId,
  });
  const refs = await handle.bucket.get(`git/v2/refs/alice/secret.json`);
  expect(refs).not.toBeNull();

  // Positive control: Alice retains namespace and repository authority.
  const aliceDeleted = await call(handle.env, "taksrv_alice_mcp", "git_repo_delete", {
    repo: "alice/bootstrap",
  });
  expect(aliceDeleted.deleted).toBe(true);
});

// Metadata-disabled installs intentionally retain the documented scope-only mode.
test("R2-only Interface MCP retains its four repository lifecycle tools", async () => {
  const handle = makeEnv();
  const env = { ...handle.env, DB: undefined };
  expect((await call(env, "taksrv_bob_mcp", "git_repo_create", { repo: "scope-only/fixture" })).repo).toBe("scope-only/fixture");
  expect((await call(env, "taksrv_bob_mcp", "git_repo_list", {})).repos).toContain("scope-only/fixture");
  expect((await call(env, "taksrv_bob_mcp", "git_repo_info", { repo: "scope-only/fixture" })).repo).toBe("scope-only/fixture");
  expect((await call(env, "taksrv_bob_mcp", "git_repo_delete", { repo: "scope-only/fixture" })).deleted).toBe(true);
  expect((await call(env, "taksrv_bob_mcp", "git_repo_list", {})).repos).not.toContain("scope-only/fixture");
});

async function privateRepo() {
  const handle = makeEnv();
  await call(handle.env, "taksrv_alice_mcp", "git_repo_create", { repo: "alice/bootstrap" });
  const alice = await upsertPrincipal(handle.db, {
    issuer: TEST_ISSUER, subject: "alice", kind: "service_account", bindingId: "binding_alice_mcp",
  });
  const repo = await seedFullRepo(handle, {
    ownerLogin: "alice", ownerType: "user", ownerPrincipalId: alice.id,
    name: "secret", visibility: "private",
  });
  return { handle, alice, repo };
}

test("denied repository operations do not read or mutate R2 and leave owner/repo rows intact", async () => {
  const { handle } = await privateRepo();
  const snapshot = async () => ({
    owners: await handle.db.query("SELECT id, login, type, principal_id FROM owners ORDER BY id"),
    repos: await handle.db.query("SELECT id, owner_id, name, lifecycle_state FROM repositories ORDER BY id"),
    bytes: [...handle.bucket.store.entries()].map(([key, value]) => [key, [...value]]),
    etags: [...handle.bucket.etags.entries()],
  });
  const before = await snapshot();
  const get = spyOn(handle.bucket, "get"), head = spyOn(handle.bucket, "head"),
    put = spyOn(handle.bucket, "put"), remove = spyOn(handle.bucket, "delete"), list = spyOn(handle.bucket, "list");
  try {
    expect((await call(handle.env, "taksrv_bob_mcp", "git_repo_list", {})).repos).not.toContain("alice/secret");
    await denied(handle.env, "taksrv_bob_mcp", "git_repo_info", { repo: "alice/secret" }, "not_found");
    await denied(handle.env, "taksrv_bob_mcp", "git_repo_create", { repo: "alice/unauthorized" }, "forbidden");
    await denied(handle.env, "taksrv_bob_mcp", "git_repo_delete", { repo: "alice/secret" }, "not_found");
    for (const operation of [get, head, put, remove, list]) expect(operation).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  } finally {
    for (const operation of [get, head, put, remove, list]) operation.mockRestore();
  }
});

test("a repository reader can inspect but cannot administer the private repository", async () => {
  const { handle, repo } = await privateRepo();
  const bob = await upsertPrincipal(handle.db, {
    issuer: TEST_ISSUER, subject: "bob", kind: "service_account", bindingId: "binding_bob_mcp",
  });
  await handle.db.run(
    "INSERT INTO repo_collaborators (repo_id, principal_id, role, created_at) VALUES (?, ?, 'reader', ?)",
    [repo.repoId, bob.id, handle.db.now()],
  );
  expect((await call(handle.env, "taksrv_bob_mcp", "git_repo_list", {})).repos).toContain("alice/secret");
  expect((await call(handle.env, "taksrv_bob_mcp", "git_repo_info", { repo: "alice/secret" })).repo).toBe("alice/secret");
  await denied(handle.env, "taksrv_bob_mcp", "git_repo_delete", { repo: "alice/secret" }, "not_found");
  await handle.db.run("DELETE FROM repo_collaborators WHERE repo_id = ? AND principal_id = ?", [repo.repoId, bob.id]);
  await denied(handle.env, "taksrv_bob_mcp", "git_repo_info", { repo: "alice/secret" }, "not_found");
});

test("organization creation requires org admin and keeps members scoped", async () => {
  const { handle, alice } = await privateRepo();
  const org = await createOrgOwner(handle.db, alice, "fixture-org");
  const bob = await upsertPrincipal(handle.db, {
    issuer: TEST_ISSUER, subject: "bob", kind: "service_account", bindingId: "binding_bob_mcp",
  });
  await handle.db.run(
    "INSERT INTO org_memberships (owner_id, principal_id, role, created_at) VALUES (?, ?, 'member', ?)",
    [org.id, bob.id, handle.db.now()],
  );
  await denied(handle.env, "taksrv_bob_mcp", "git_repo_create", { repo: "fixture-org/denied" }, "forbidden");
  await handle.db.run("UPDATE org_memberships SET role = 'admin' WHERE owner_id = ? AND principal_id = ?", [org.id, bob.id]);
  expect((await call(handle.env, "taksrv_bob_mcp", "git_repo_create", { repo: "fixture-org/allowed" })).repo).toBe("fixture-org/allowed");
  expect((await call(handle.env, "taksrv_bob_mcp", "git_repo_delete", { repo: "fixture-org/allowed" })).deleted).toBe(true);
});

test("another binding with the same subject does not inherit a service Principal's repository", async () => {
  const { handle } = await privateRepo();
  expect((await call(handle.env, "taksrv_alice_other_mcp", "git_repo_list", {})).repos).not.toContain("alice/secret");
  await denied(handle.env, "taksrv_alice_other_mcp", "git_repo_info", { repo: "alice/secret" }, "not_found");
  await denied(handle.env, "taksrv_alice_other_mcp", "git_repo_create", { repo: "alice/denied" }, "forbidden");
});
