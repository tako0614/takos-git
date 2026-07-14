import { beforeEach, describe, expect, test } from "bun:test";

import { createDbClient, type DbClient } from "../db/client.ts";
import { createFakeD1 } from "../db/fake.ts";
import { migrationSql } from "../db/migration-sql.ts";
import {
  SCOPES,
  type AuthContext,
  type Principal,
  type Visibility,
} from "../contract/v1.ts";
import {
  anonymousContext,
  authorizeRepo,
  effectiveRole,
  resolveRepoRow,
  upsertPrincipal,
} from "./acl.ts";

let db: DbClient;

beforeEach(() => {
  let clock = 1_700_000_000_000;
  db = createDbClient(createFakeD1(migrationSql), { now: () => clock++ });
});

async function seedOwner(
  login: string,
  type: "user" | "org",
  principalId: string | null,
): Promise<string> {
  const id = db.id();
  const now = db.now();
  await db.run(
    `INSERT INTO owners (id, login, type, principal_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, login, type, principalId, now, now],
  );
  return id;
}

async function seedRepo(
  ownerId: string,
  ownerLogin: string,
  name: string,
  visibility: Visibility,
): Promise<string> {
  const id = db.id();
  const now = db.now();
  await db.run(
    `INSERT INTO repositories (id, owner_id, name, storage_key, visibility, default_branch, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'main', ?, ?)`,
    [id, ownerId, name, `${ownerLogin}/${name}`, visibility, now, now],
  );
  return id;
}

function browserCtx(principal: Principal): AuthContext {
  return {
    principal,
    channel: "browser",
    scopes: new Set(Object.values(SCOPES)),
  };
}

function interfaceCtx(principal: Principal, scope: string): AuthContext {
  return { principal, channel: "interface", scopes: new Set([scope]) };
}

describe("upsertPrincipal", () => {
  test("JIT-creates then updates a principal keyed on subject", async () => {
    const first = await upsertPrincipal(db, {
      subject: "sub-a",
      kind: "user",
      displayName: "A",
    });
    expect(first.id).toHaveLength(26);
    expect(first.kind).toBe("user");

    const second = await upsertPrincipal(db, {
      subject: "sub-a",
      kind: "user",
      displayName: "A renamed",
      email: "a@example.test",
    });
    expect(second.id).toBe(first.id); // identity is the subject, stable id
    expect(second.email).toBe("a@example.test");
  });
});

describe("effectiveRole", () => {
  test("public repo grants reader to anonymous; private grants nothing", async () => {
    const ownerId = await seedOwner("acme", "org", null);
    await seedRepo(ownerId, "acme", "pub", "public");
    await seedRepo(ownerId, "acme", "secret", "private");
    const pub = (await resolveRepoRow(db, "acme", "pub"))!;
    const priv = (await resolveRepoRow(db, "acme", "secret"))!;
    const anon = anonymousContext().principal;
    expect(await effectiveRole(db, anon, pub)).toBe("reader");
    expect(await effectiveRole(db, anon, priv)).toBeNull();
  });

  test("internal repo grants reader to any authenticated principal, not anon", async () => {
    const ownerId = await seedOwner("acme", "org", null);
    await seedRepo(ownerId, "acme", "internal", "internal");
    const repo = (await resolveRepoRow(db, "acme", "internal"))!;
    const member = await upsertPrincipal(db, { subject: "sub-m", kind: "user" });
    expect(await effectiveRole(db, member, repo)).toBe("reader");
    expect(await effectiveRole(db, anonymousContext().principal, repo)).toBeNull();
  });

  test("user-owner principal is owner of its repo", async () => {
    const alice = await upsertPrincipal(db, { subject: "sub-alice", kind: "user" });
    const ownerId = await seedOwner("alice", "user", alice.id);
    await seedRepo(ownerId, "alice", "web", "private");
    const repo = (await resolveRepoRow(db, "alice", "web"))!;
    expect(await effectiveRole(db, alice, repo)).toBe("owner");
  });

  test("effective role is the max of collaborator and team grants", async () => {
    const ownerId = await seedOwner("acme", "org", null);
    const repoId = await seedRepo(ownerId, "acme", "web", "private");
    const repo = (await resolveRepoRow(db, "acme", "web"))!;
    const bob = await upsertPrincipal(db, { subject: "sub-bob", kind: "user" });

    // direct collaborator: reader
    await db.run(
      `INSERT INTO repo_collaborators (repo_id, principal_id, role, created_at) VALUES (?, ?, 'reader', ?)`,
      [repoId, bob.id, db.now()],
    );
    expect(await effectiveRole(db, bob, repo)).toBe("reader");

    // team grant: maintainer → wins
    const teamId = db.id();
    await db.run(
      `INSERT INTO teams (id, owner_id, slug, name, created_at, updated_at) VALUES (?, ?, 'core', 'Core', ?, ?)`,
      [teamId, ownerId, db.now(), db.now()],
    );
    await db.run(
      `INSERT INTO team_members (team_id, principal_id, role, created_at) VALUES (?, ?, 'member', ?)`,
      [teamId, bob.id, db.now()],
    );
    await db.run(
      `INSERT INTO team_repo_access (team_id, repo_id, role, created_at) VALUES (?, ?, 'maintainer', ?)`,
      [teamId, repoId, db.now()],
    );
    expect(await effectiveRole(db, bob, repo)).toBe("maintainer");
  });

  test("org admin administers the org's repos; plain member has no base grant", async () => {
    const ownerId = await seedOwner("acme", "org", null);
    await seedRepo(ownerId, "acme", "web", "private");
    const repo = (await resolveRepoRow(db, "acme", "web"))!;
    const admin = await upsertPrincipal(db, { subject: "sub-admin", kind: "user" });
    const member = await upsertPrincipal(db, { subject: "sub-mem", kind: "user" });
    await db.run(
      `INSERT INTO org_memberships (owner_id, principal_id, role, created_at) VALUES (?, ?, 'admin', ?)`,
      [ownerId, admin.id, db.now()],
    );
    await db.run(
      `INSERT INTO org_memberships (owner_id, principal_id, role, created_at) VALUES (?, ?, 'member', ?)`,
      [ownerId, member.id, db.now()],
    );
    expect(await effectiveRole(db, admin, repo)).toBe("owner");
    expect(await effectiveRole(db, member, repo)).toBeNull();
  });
});

describe("authorizeRepo (fail-closed)", () => {
  test("absent repo → 404", async () => {
    const decision = await authorizeRepo(
      db,
      anonymousContext(),
      "nobody",
      "ghost",
      "contents.read",
    );
    expect(decision).toEqual({ allow: false, status: 404, reason: "not_found" });
  });

  test("private repo, no access → 404 (non-disclosure)", async () => {
    const ownerId = await seedOwner("acme", "org", null);
    await seedRepo(ownerId, "acme", "secret", "private");
    const stranger = await upsertPrincipal(db, { subject: "sub-x", kind: "user" });
    const decision = await authorizeRepo(
      db,
      browserCtx(stranger),
      "acme",
      "secret",
      "contents.read",
    );
    expect(decision).toMatchObject({ allow: false, status: 404 });
  });

  test("public repo read allowed for anonymous; write forbidden (403)", async () => {
    const ownerId = await seedOwner("acme", "org", null);
    await seedRepo(ownerId, "acme", "web", "public");
    const read = await authorizeRepo(
      db,
      anonymousContext(),
      "acme",
      "web",
      "contents.read",
    );
    expect(read).toEqual({ allow: true, role: "reader" });

    const write = await authorizeRepo(
      db,
      anonymousContext(),
      "acme",
      "web",
      "contents.write",
    );
    expect(write).toEqual({ allow: false, status: 403, reason: "forbidden" });
  });

  test("interface channel is capped by its scope ceiling", async () => {
    const alice = await upsertPrincipal(db, { subject: "sub-alice", kind: "service_account" });
    const ownerId = await seedOwner("alice", "user", alice.id);
    await seedRepo(ownerId, "alice", "web", "private");

    // owner role, but the token only holds hosting.read → cannot write.
    const readOnly = interfaceCtx(alice, SCOPES.hostingRead);
    const denied = await authorizeRepo(
      db,
      readOnly,
      "alice",
      "web",
      "issues.write",
    );
    expect(denied).toEqual({
      allow: false,
      status: 403,
      reason: "scope_insufficient",
    });

    // same identity with the write scope → allowed.
    const writeCtx = interfaceCtx(alice, SCOPES.hostingWrite);
    const allowed = await authorizeRepo(
      db,
      writeCtx,
      "alice",
      "web",
      "issues.write",
    );
    expect(allowed).toEqual({ allow: true, role: "owner" });
  });
});
