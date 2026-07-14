/**
 * Test-only helpers for the repos feature: an in-memory env (fake D1 + memory R2),
 * D1 seeding, and an Interface-OAuth userinfo mock. Imported ONLY by `*.test.ts`
 * files, so it never reaches the deployed Worker bundle (which starts at
 * worker.ts).
 */

import { createDbClient, type DbClient } from "../../db/client.ts";
import { createFakeD1, type FakeD1 } from "../../db/fake.ts";
import { migrationSql } from "../../db/migration-sql.ts";
import { MemoryBucket } from "../../test-bucket.ts";
import { seedRepo } from "../../seed.ts";
import type { RouterEnv } from "../../router.ts";
import type { OAuthFetch } from "../../browser-auth.ts";
import type { Visibility } from "../../contract/v1.ts";

export const TEST_APP_URL = "https://git.example";
export const TEST_WORKSPACE = "workspace_a";
export const TEST_CAPSULE = "capsule_git";

export interface TestEnvHandle {
  readonly env: RouterEnv;
  readonly db: DbClient;
  readonly fake: FakeD1;
  readonly bucket: MemoryBucket;
}

/** A fresh in-memory env with the baseline schema loaded and OIDC configured. */
export function makeEnv(): TestEnvHandle {
  const fake = createFakeD1(migrationSql);
  let clock = 1_700_000_000_000;
  const db = createDbClient(fake, { now: () => clock++ });
  const bucket = new MemoryBucket();
  const env: RouterEnv = {
    BUCKET: bucket,
    DB: fake,
    APP_URL: TEST_APP_URL,
    OIDC_ISSUER_URL: "https://accounts.example",
    APP_WORKSPACE_ID: TEST_WORKSPACE,
    APP_CAPSULE_ID: TEST_CAPSULE,
  };
  return { env, db, fake, bucket };
}

export async function seedPrincipal(
  db: DbClient,
  subject: string,
  kind: "user" | "service_account" = "user",
): Promise<string> {
  const id = db.id();
  const now = db.now();
  await db.run(
    `INSERT INTO principals (id, subject, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    [id, subject, kind, now, now],
  );
  return id;
}

export async function seedOwner(
  db: DbClient,
  login: string,
  type: "user" | "org",
  principalId: string | null,
): Promise<string> {
  const id = db.id();
  const now = db.now();
  await db.run(
    `INSERT INTO owners (id, login, type, principal_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, login, type, principalId, now, now],
  );
  return id;
}

export interface SeedRepoOpts {
  readonly ownerLogin: string;
  readonly ownerType?: "user" | "org";
  readonly ownerPrincipalId?: string | null;
  readonly name: string;
  readonly visibility?: Visibility;
  readonly file?: string;
  readonly content?: string;
  readonly message?: string;
}

export interface SeededRepo {
  readonly ownerId: string;
  readonly repoId: string;
  readonly commitSha: string;
  readonly storageKey: string;
}

/** Insert a D1 owner (if needed) + repo row AND seed the R2 refs/objects. */
export async function seedFullRepo(
  handle: TestEnvHandle,
  opts: SeedRepoOpts,
): Promise<SeededRepo> {
  const { db, bucket } = handle;
  let ownerId = await db.queryOne<{ id: string }>(
    `SELECT id FROM owners WHERE login = ? COLLATE NOCASE`,
    [opts.ownerLogin],
  );
  if (!ownerId) {
    const id = await seedOwner(
      db,
      opts.ownerLogin,
      opts.ownerType ?? "org",
      opts.ownerPrincipalId ?? null,
    );
    ownerId = { id };
  }
  const storageKey = `${opts.ownerLogin}/${opts.name}`;
  const repoId = db.id();
  const now = db.now();
  await db.run(
    `INSERT INTO repositories (id, owner_id, name, storage_key, visibility, default_branch, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'main', ?, ?)`,
    [repoId, ownerId.id, opts.name, storageKey, opts.visibility ?? "public", now, now],
  );
  const seeded = await seedRepo(bucket, {
    repo: storageKey,
    fileName: opts.file ?? "README.md",
    content: opts.content ?? "# fixture\n",
    message: opts.message ?? "init\n",
  });
  return { ownerId: ownerId.id, repoId, commitSha: seeded.commitSha, storageKey };
}

export interface InterfaceToken {
  readonly scope: string;
  readonly subject: string;
}

/**
 * Build an Interface-OAuth userinfo mock over a token→(scope, subject) table, for
 * the `/api/v1` audience. Unknown tokens yield a non-200 (invalid credential).
 */
export function interfaceUserInfoFetch(
  tokens: Record<string, InterfaceToken>,
): OAuthFetch {
  return async (_input, init) => {
    const token = new Headers(init?.headers)
      .get("authorization")
      ?.replace(/^Bearer\s+/u, "");
    const entry = token ? tokens[token] : undefined;
    if (!entry) return new Response("no", { status: 401 });
    return Response.json({
      token_use: "interface_oauth",
      sub: entry.subject,
      aud: `${TEST_APP_URL}/api/v1`,
      scope: entry.scope,
      takosumi: {
        workspace_id: TEST_WORKSPACE,
        capsule_id: TEST_CAPSULE,
        interface_id: "interface_git",
        interface_binding_id: `binding_${entry.subject}`,
        interface_resolved_revision: 1,
      },
    });
  };
}

/** A GET request with an optional bearer token. */
export function get(path: string, token?: string): Request {
  return new Request(`${TEST_APP_URL}${path}`, {
    method: "GET",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

/** A JSON-body request with an optional bearer token. */
export function jsonRequest(
  method: string,
  path: string,
  body: unknown,
  token?: string,
): Request {
  return new Request(`${TEST_APP_URL}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
