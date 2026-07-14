import { describe, expect, test } from "bun:test";
import { createFakeD1 } from "./fake.ts";
import { createDbClient } from "./client.ts";
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
    expect(rows.length).toBe(1);
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
