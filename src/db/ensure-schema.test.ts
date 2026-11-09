import { describe, expect, test } from "bun:test";
import { createFakeD1 } from "./fake.ts";
import {
  createDbClient,
  type D1Database,
  type D1PreparedStatement,
  type D1Result,
} from "./client.ts";
import { ensureSchema, resetSchemaCacheForTests } from "./ensure-schema.ts";

describe("ensureSchema", () => {
  test("applies the baseline schema to an empty D1", async () => {
    resetSchemaCacheForTests();
    const fake = createFakeD1(); // empty — no schema pre-loaded
    const db = createDbClient(fake);

    // Before: core tables do not exist.
    await expect(db.query(`SELECT id FROM repositories`)).rejects.toThrow();

    await ensureSchema(fake);

    // After: schema is present and usable end-to-end.
    const now = db.now();
    await db.run(
      `INSERT INTO principals (id, subject, kind, created_at, updated_at) VALUES ('p1','sub','user',?,?)`,
      [now, now],
    );
    const p = await db.queryOne<{ subject: string }>(
      `SELECT subject FROM principals WHERE id = 'p1'`,
    );
    expect(p?.subject).toBe("sub");

    const ledger = await db.queryOne<{ version: string }>(
      `SELECT version FROM schema_migrations WHERE version = '0001'`,
    );
    expect(ledger?.version).toBe("0001");
    const identityLedger = await db.queryOne<{ version: string }>(
      `SELECT version FROM schema_migrations WHERE version = '0002'`,
    );
    expect(identityLedger?.version).toBe("0002");
    const webhookOutboxLedger = await db.queryOne<{ version: string }>(
      `SELECT version FROM schema_migrations WHERE version = '0003'`,
    );
    expect(webhookOutboxLedger?.version).toBe("0003");
    const deletionLedger = await db.queryOne<{ version: string }>(
      `SELECT version FROM schema_migrations WHERE version = '0004'`,
    );
    expect(deletionLedger?.version).toBe("0004");
    expect(await db.queryOne("SELECT version FROM schema_migrations WHERE version = '0005'"))
      .toEqual({ version: "0005" });
    expect(await db.queryOne("SELECT version FROM schema_migrations WHERE version = '0006'"))
      .toEqual({ version: "0006" });
  });

  test("is idempotent — re-applying does not throw or duplicate", async () => {
    resetSchemaCacheForTests();
    const fake = createFakeD1();
    const db = createDbClient(fake);

    await ensureSchema(fake);
    resetSchemaCacheForTests(); // force a second real apply
    await ensureSchema(fake); // IF NOT EXISTS + INSERT OR IGNORE → safe

    const rows = await db.query<{ version: string }>(
      `SELECT version FROM schema_migrations`,
    );
    expect(rows.map((row) => row.version)).toEqual([
      "0001",
      "0002",
      "0003",
      "0004",
      "0005",
      "0006",
    ]);
  });

  test("upgrades an existing 0001 database without dropping principals", async () => {
    resetSchemaCacheForTests();
    const { migrations } = await import("./migration-sql.ts");
    const fake = createFakeD1(migrations[0]?.sql);
    const db = createDbClient(fake);
    const now = db.now();
    await db.run(
      `INSERT INTO principals (id, subject, kind, created_at, updated_at)
       VALUES ('legacy', 'sub-legacy', 'user', ?, ?)`,
      [now, now],
    );
    await db.run(
      `INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES ('0001', ?)`,
      [now],
    );

    await ensureSchema(fake);

    const principal = await db.queryOne<{
      id: string;
      issuer: string;
      binding_id: string;
    }>(
      `SELECT id, issuer, binding_id FROM principals WHERE id = 'legacy'`,
    );
    expect(principal).toEqual({
      id: "legacy",
      issuer: "",
      binding_id: "",
    });
  });

  test("accepts a migration batch whose commit won a concurrent race", async () => {
    resetSchemaCacheForTests();
    const fake = createFakeD1();
    let lostFirstResponse = true;
    const raced = {
      prepare: (query: string) => fake.prepare(query),
      exec: (query: string) => fake.exec(query),
      async batch<T = Record<string, unknown>>(
        statements: D1PreparedStatement[],
      ): Promise<D1Result<T>[]> {
        const result = await fake.batch<T>(statements);
        if (lostFirstResponse) {
          lostFirstResponse = false;
          throw new Error("simulated concurrent winner / lost batch response");
        }
        return result;
      },
    } satisfies D1Database;

    await ensureSchema(raced);
    const versions = await createDbClient(fake).query<{ version: string }>(
      `SELECT version FROM schema_migrations ORDER BY version`,
    );
    expect(versions.map((row) => row.version)).toEqual([
      "0001",
      "0002",
      "0003",
      "0004",
      "0005",
      "0006",
    ]);
  });

  test("additively upgrades populated0004 without changing legacy rows or FK behavior", async () => {
    resetSchemaCacheForTests();
    const { migrations } = await import("./migration-sql.ts");
    const previous = migrations.filter(m => m.version <= "0004").map(m =>
      `${m.sql}\nINSERT INTO schema_migrations (version, applied_at) VALUES ('${m.version}', 1);`).join("\n");
    const fake = createFakeD1(previous), db = createDbClient(fake);
    await db.batch([
      { sql: "INSERT INTO principals (id, subject, kind, created_at, updated_at) VALUES ('p','legacy','user',1,1)" },
      { sql: "INSERT INTO owners (id, login, type, principal_id, created_at, updated_at) VALUES ('o','legacy','user','p',1,1)" },
      { sql: "INSERT INTO repositories (id, owner_id, name, storage_key, created_at, updated_at) VALUES ('r','o','repo','legacy/repo',1,1)" },
      { sql: "INSERT INTO issues (id, repo_id, number, title, comment_count, created_at, updated_at) VALUES ('i','r',1,'existing',1,1,1)" },
      { sql: "INSERT INTO issue_comments (id, issue_id, author_id, body, created_at, updated_at) VALUES ('c','i','p','keep this',1,1)" },
    ]);
    const tables = ["principals", "owners", "repositories", "issues", "issue_comments", "schema_migrations"];
    const before = await Promise.all(tables.map(t => db.query(`SELECT * FROM ${t}`)));
    await ensureSchema(fake);
    for (let n = 0; n < tables.length - 1; n++) expect(await db.query(`SELECT * FROM ${tables[n]}`)).toEqual(before[n]);
    expect((await db.query<{ version: string }>("SELECT version FROM schema_migrations ORDER BY version")).map(r => r.version))
      .toEqual(["0001", "0002", "0003", "0004", "0005", "0006"]);
    expect(await db.query("SELECT * FROM issue_comment_submissions")).toEqual([]);
    expect(await db.query("PRAGMA foreign_key_check")).toEqual([]);
    // The old unkeyed writer's SQL continues to work after the additive change.
    await db.run("INSERT INTO issue_comments (id, issue_id, author_id, body, created_at, updated_at) VALUES ('new','i','p','legacy write',2,2)");
    expect((await db.query("SELECT id FROM issue_comments"))).toHaveLength(2);
    await db.run("DELETE FROM issues WHERE id = 'i'");
    expect(await db.query("SELECT id FROM issue_comments")).toEqual([]);
  });

  test("0005 comment receipt and metadata survive the0006 additive upgrade", async () => {
    resetSchemaCacheForTests();
    const { migrations } = await import("./migration-sql.ts");
    const previous = migrations.filter(m => m.version <= "0005").map(m =>
      `${m.sql}\nINSERT INTO schema_migrations (version, applied_at) VALUES ('${m.version}', 1);`).join("\n");
    const fake = createFakeD1(previous), db = createDbClient(fake);
    await db.batch([
      { sql: "INSERT INTO principals (id, subject, kind, created_at, updated_at) VALUES ('p','legacy','user',1,1)" },
      { sql: "INSERT INTO owners (id, login, type, principal_id, created_at, updated_at) VALUES ('o','legacy','user','p',1,1)" },
      { sql: "INSERT INTO repositories (id, owner_id, name, storage_key, created_at, updated_at) VALUES ('r','o','repo','legacy/repo',1,1)" },
      { sql: "INSERT INTO issues (id, repo_id, number, title, created_at, updated_at) VALUES ('i','r',1,'keep this',1,1)" },
    ]);
    const { createCommentSubmission } = await import("../features/issues/store.ts");
    await createCommentSubmission(db, "i", "p", "original", "legacy-key");
    const tables = ["principals", "owners", "repositories", "issues", "issue_comments", "issue_comment_submissions"];
    const before = await Promise.all(tables.map(t => db.query(`SELECT * FROM ${t}`)));
    await ensureSchema(fake);
    for (let n = 0; n < tables.length; n++) expect(await db.query(`SELECT * FROM ${tables[n]}`)).toEqual(before[n]);
    expect(await db.query("SELECT * FROM issue_submissions")).toEqual([]);
    expect(await db.query("PRAGMA foreign_key_check")).toEqual([]);
  });

  test("caches per isolate — second call does not re-apply", async () => {
    resetSchemaCacheForTests();
    const fake = createFakeD1();
    await ensureSchema(fake);

    // A second binding is NOT migrated while the cache is warm — proving the apply
    // ran once, not on every call.
    const other = createFakeD1();
    await ensureSchema(other);
    await expect(
      createDbClient(other).query(`SELECT version FROM schema_migrations`),
    ).rejects.toThrow();
  });
});
