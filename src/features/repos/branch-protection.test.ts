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
import {
  authorizeRepo,
  upsertPrincipal,
  type RepoAclRow,
} from "../../auth/acl.ts";
import {
  SCOPES,
  type AuthContext,
  type Principal,
} from "../../contract/v1.ts";
import { resolveRepoRow } from "../../auth/acl.ts";
import type { DbClient } from "../../db/client.ts";
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
  taksrv_carol_a: { scope: "source.git.hosting.admin", subject: "sub-carol" },
});

function browserCtx(principal: Principal): AuthContext {
  return { principal, channel: "browser", scopes: new Set(Object.values(SCOPES)) };
}

async function seedRule(
  db: DbClient,
  repoId: string,
  fields: Partial<{
    pattern: string;
    required_reviews: number;
    restrict_push: number;
    push_allowlist: string | null;
    enforce_admins: number;
  }>,
): Promise<void> {
  const now = db.now();
  await db.run(
    `INSERT INTO branch_protection_rules
       (id, repo_id, pattern, required_reviews, restrict_push, push_allowlist, enforce_admins, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      db.id(),
      repoId,
      fields.pattern ?? "main",
      fields.required_reviews ?? 0,
      fields.restrict_push ?? 0,
      fields.push_allowlist ?? null,
      fields.enforce_admins ?? 0,
      now,
      now,
    ],
  );
}

describe("branch protection CRUD via router", () => {
  test("owner creates/lists/deletes a rule; a maintainer may list but not mutate", async () => {
    const handle = makeEnv();
    const reg = router();
    await dispatch(
      reg,
      jsonRequest("POST", "/api/v1/repos", { owner: "alice", name: "web", visibility: "private" }, "taksrv_alice_w"),
      handle.env,
      tokens,
    );
    // Make carol a maintainer.
    await dispatch(
      reg,
      jsonRequest("PUT", "/api/v1/repos/alice/web/collaborators/sub-carol", { role: "maintainer" }, "taksrv_alice_a"),
      handle.env,
      tokens,
    );

    const put = await dispatch(
      reg,
      jsonRequest(
        "PUT",
        "/api/v1/repos/alice/web/branch-protection/main",
        { requiredReviews: 2, restrictPush: true, pushAllowlist: ["p1"] },
        "taksrv_alice_a",
      ),
      handle.env,
      tokens,
    );
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({
      rule: { pattern: "main", requiredReviews: 2, restrictPush: true, pushAllowlist: ["p1"] },
    });

    // maintainer can list.
    const list = await dispatch(reg, get("/api/v1/repos/alice/web/branch-protection", "taksrv_carol_a"), handle.env, tokens);
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ rules: [{ pattern: "main" }] });

    // maintainer cannot mutate.
    const denied = await dispatch(
      reg,
      jsonRequest("DELETE", "/api/v1/repos/alice/web/branch-protection/main", undefined, "taksrv_carol_a"),
      handle.env,
      tokens,
    );
    expect(denied.status).toBe(403);

    // owner deletes.
    const removed = await dispatch(
      reg,
      jsonRequest("DELETE", "/api/v1/repos/alice/web/branch-protection/main", undefined, "taksrv_alice_a"),
      handle.env,
      tokens,
    );
    expect(removed.status).toBe(200);
  });
});

describe("checkBranchProtection enforcement (via authorizeRepo)", () => {
  async function setup(): Promise<{
    db: DbClient;
    repo: RepoAclRow;
    alice: Principal;
  }> {
    const handle = makeEnv();
    const alice = await upsertPrincipal(handle.db, { subject: "sub-alice", kind: "user" });
    const ownerId = await seedOwner(handle.db, "alice", "user", alice.id);
    const now = handle.db.now();
    const repoId = handle.db.id();
    await handle.db.run(
      `INSERT INTO repositories (id, owner_id, name, storage_key, visibility, default_branch, created_at, updated_at)
       VALUES (?, ?, 'web', 'alice/web', 'private', 'main', ?, ?)`,
      [repoId, ownerId, now, now],
    );
    const repo = (await resolveRepoRow(handle.db, "alice", "web")) as RepoAclRow;
    return { db: handle.db, repo, alice };
  }

  test("required-review rule refuses a direct push to the protected branch", async () => {
    const { db, repo, alice } = await setup();
    await seedRule(db, repo.id, { pattern: "main", required_reviews: 1, enforce_admins: 1 });
    const denied = await authorizeRepo(db, browserCtx(alice), "alice", "web", "contents.write", {
      ref: "main",
    });
    expect(denied).toMatchObject({ allow: false, reason: "protected_ref" });
    // a non-matching branch is unaffected.
    const ok = await authorizeRepo(db, browserCtx(alice), "alice", "web", "contents.write", {
      ref: "dev",
    });
    expect(ok).toMatchObject({ allow: true });
  });

  test("admins bypass a rule unless enforce_admins is set", async () => {
    const { db, repo, alice } = await setup();
    await seedRule(db, repo.id, { pattern: "main", required_reviews: 1, enforce_admins: 0 });
    // owner ≥ maintainer → bypass.
    const ok = await authorizeRepo(db, browserCtx(alice), "alice", "web", "contents.write", {
      ref: "main",
    });
    expect(ok).toMatchObject({ allow: true });
  });

  test("restrict-push denies a principal absent from the allowlist", async () => {
    const { db, repo, alice } = await setup();
    await seedRule(db, repo.id, {
      pattern: "main",
      restrict_push: 1,
      push_allowlist: JSON.stringify(["someone-else"]),
      enforce_admins: 1,
    });
    const denied = await authorizeRepo(db, browserCtx(alice), "alice", "web", "contents.write", {
      ref: "main",
    });
    expect(denied).toMatchObject({ allow: false, reason: "protected_ref" });

    await db.run(`DELETE FROM branch_protection_rules WHERE repo_id = ?`, [repo.id]);
    await seedRule(db, repo.id, {
      pattern: "main",
      restrict_push: 1,
      push_allowlist: JSON.stringify([alice.id]),
      enforce_admins: 1,
    });
    const ok = await authorizeRepo(db, browserCtx(alice), "alice", "web", "contents.write", {
      ref: "main",
    });
    expect(ok).toMatchObject({ allow: true });
  });

  test("a glob pattern matches release branches", async () => {
    const { db, repo, alice } = await setup();
    await seedRule(db, repo.id, { pattern: "release/*", required_reviews: 1, enforce_admins: 1 });
    const denied = await authorizeRepo(db, browserCtx(alice), "alice", "web", "contents.write", {
      ref: "release/1.0",
    });
    expect(denied).toMatchObject({ allow: false, reason: "protected_ref" });
  });
});
