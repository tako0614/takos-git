/**
 * Idempotent, self-applied D1 schema migration.
 *
 * The install ships a single self-contained Worker with no separate
 * `wrangler d1 migrations apply` step, so the Worker applies ordered migrations
 * on first use, guarded by the `schema_migrations` ledger. Each migration and
 * ledger write run in one D1 batch, so an ALTER cannot be left half-applied and
 * unrecorded. A failure clears the cache so the next request retries.
 */

import { createDbClient, type D1Database } from "./client.ts";
import { migrations } from "./migration-sql.ts";

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

  for (const migration of migrations) {
    // On a fresh database the first lookup throws because the ledger itself is
    // part of 0001. Existing databases simply skip versions already recorded.
    let applied = false;
    try {
      const row = await db.queryOne<{ version: string }>(
        `SELECT version FROM schema_migrations WHERE version = ? LIMIT 1`,
        [migration.version],
      );
      applied = row !== null;
    } catch {
      applied = false;
    }
    if (applied) continue;

    // D1 batch is transactional. DDL and its ledger entry commit together, so a
    // crash cannot leave an ALTER half-applied and unrecorded.
    try {
      await db.batch([
        ...statements(migration.sql).map((sql) => ({ sql })),
        {
          sql: `INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)`,
          params: [migration.version, db.now()],
        },
      ]);
    } catch (error) {
      // Separate isolates can both observe a missing version. D1 serializes the
      // batches; the loser may see duplicate-column/index errors after the
      // winner committed. A lost response has the same shape. Accept only a
      // ledger row now visible from D1—otherwise preserve the real failure.
      let wonElsewhere = false;
      try {
        const row = await db.queryOne<{ version: string }>(
          `SELECT version FROM schema_migrations WHERE version = ? LIMIT 1`,
          [migration.version],
        );
        wonElsewhere = row !== null;
      } catch {
        wonElsewhere = false;
      }
      if (!wonElsewhere) throw error;
    }
  }
}

/**
 * Ensure every D1 migration is applied. Cached per isolate: the first call
 * applies missing versions, later calls await the resolved promise (~free).
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
