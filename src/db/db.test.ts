import { describe, expect, test } from "bun:test";

import { createDbClient } from "./client.ts";
import { createFakeD1 } from "./fake.ts";
import { migrationSql } from "./migration-sql.ts";

function client() {
  let clock = 1_700_000_000_000;
  const db = createFakeD1(migrationSql);
  return createDbClient(db, { now: () => clock++ });
}

describe("D1 metadata plane (fake adapter + baseline schema)", () => {
  test("loads the full baseline schema", () => {
    // Reaching here means createFakeD1(migrationSql) applied every CREATE TABLE /
    // INDEX in 0001_init.sql without error.
    const db = createFakeD1(migrationSql);
    expect(db).toBeDefined();
  });

  test("round-trips a principal → owner → repository graph", async () => {
    const db = client();
    const principalId = db.id();
    const ownerId = db.id();
    const repoId = db.id();
    const now = db.now();

    await db.batch([
      {
        sql: `INSERT INTO principals (id, subject, kind, display_name, email, created_at, updated_at)
              VALUES (?, ?, 'user', ?, ?, ?, ?)`,
        params: [principalId, "sub-alice", "Alice", "alice@example.test", now, now],
      },
      {
        sql: `INSERT INTO owners (id, login, type, principal_id, created_at, updated_at)
              VALUES (?, 'alice', 'user', ?, ?, ?)`,
        params: [ownerId, principalId, now, now],
      },
      {
        sql: `INSERT INTO repositories (id, owner_id, name, storage_key, visibility, default_branch, created_at, updated_at)
              VALUES (?, ?, 'web', 'alice/web', 'public', 'main', ?, ?)`,
        params: [repoId, ownerId, now, now],
      },
    ]);

    const repo = await db.queryOne<{ name: string; owner_login: string; visibility: string }>(
      `SELECT r.name, r.visibility, o.login AS owner_login
         FROM repositories r JOIN owners o ON o.id = r.owner_id
        WHERE r.id = ?`,
      [repoId],
    );
    expect(repo).toMatchObject({
      name: "web",
      owner_login: "alice",
      visibility: "public",
    });

    const rows = await db.query<{ login: string }>(`SELECT login FROM owners`);
    expect(rows.map((row) => row.login)).toEqual(["alice"]);
  });

  test("enforces foreign keys like D1", async () => {
    const db = client();
    // repositories.owner_id references owners(id) — an orphan insert must fail.
    let failed = false;
    try {
      await db.run(
        `INSERT INTO repositories (id, owner_id, name, storage_key, visibility, default_branch, created_at, updated_at)
         VALUES (?, 'missing-owner', 'x', 'ghost/x', 'private', 'main', ?, ?)`,
        [db.id(), db.now(), db.now()],
      );
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });

  test("ULIDs are lexicographically sortable by creation time", () => {
    const db = client();
    const first = db.id();
    const second = db.id();
    expect(second > first || second.slice(0, 10) >= first.slice(0, 10)).toBe(true);
    expect(first).toHaveLength(26);
  });
});
