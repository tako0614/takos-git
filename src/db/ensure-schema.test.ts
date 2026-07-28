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
    ]);
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
