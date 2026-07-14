/**
 * Idempotent, self-applied D1 schema migration.
 *
 * The install ships a single self-contained Worker with no separate
 * `wrangler d1 migrations apply` step, so the Worker applies its own baseline
 * schema (migration 0001) the first time it sees a configured D1 binding, guarded
 * by the `schema_migrations` ledger. The DDL is fully `IF NOT EXISTS`, so a
 * partial prior apply (e.g. a crash before the ledger row was written) re-applies
 * safely. Applied once per isolate (cached promise); a failure clears the cache so
 * the next request retries.
 */

import { createDbClient, type D1Database } from "./client.ts";
import { migrationSql } from "./migration-sql.ts";

const SCHEMA_VERSION = "0001";

let pending: Promise<void> | null = null;

/**
 * Split the baseline SQL into individual DDL statements. Strips every `-- …`
 * comment to end-of-line FIRST (the baseline has no `--` inside string literals),
 * so a `;` inside a comment can't truncate a statement, then splits on `;`. The
 * baseline DDL has no `;` inside string literals.
 */
function statements(sql: string): string[] {
  return sql
    .split("\n")
    .map((line) => {
      const comment = line.indexOf("--");
      return comment >= 0 ? line.slice(0, comment) : line;
    })
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

async function apply(binding: D1Database): Promise<void> {
  const db = createDbClient(binding);

  // Fast path: already applied. The SELECT throws if schema_migrations doesn't
  // exist yet (first ever run) — treat that as "not applied" and fall through.
  try {
    const row = await db.queryOne<{ version: string }>(
      `SELECT version FROM schema_migrations WHERE version = ? LIMIT 1`,
      [SCHEMA_VERSION],
    );
    if (row) return;
  } catch {
    /* schema_migrations absent → apply below */
  }

  for (const statement of statements(migrationSql)) {
    await db.run(statement);
  }
  await db.run(
    `INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)`,
    [SCHEMA_VERSION, db.now()],
  );
}

/**
 * Ensure the D1 baseline schema is applied. Cached per isolate: the first call
 * applies (idempotently), later calls await the resolved promise (~free). Safe
 * under concurrent first-requests — the DDL is IF NOT EXISTS and the ledger insert
 * is INSERT OR IGNORE.
 */
export function ensureSchema(binding: D1Database): Promise<void> {
  if (!pending) {
    pending = apply(binding).catch((error) => {
      pending = null; // allow a retry on the next request
      throw error;
    });
  }
  return pending;
}

/** Test-only: reset the per-isolate apply cache. */
export function resetSchemaCacheForTests(): void {
  pending = null;
}
