/**
 * The baseline D1 schema as text. Import-as-text is inlined by the bundler and
 * typed by the `*.sql` ambient module. Loaded into the in-memory `fake.ts` adapter
 * by tests, AND embedded in the deployed Worker so `ensure-schema.ts` can apply the
 * schema on first use (the install ships no separate `wrangler d1 migrations` step).
 */
import baseline from "../../migrations/0001_init.sql" with { type: "text" };
import principalIdentity from "../../migrations/0002_principal_identity.sql" with { type: "text" };
import webhookOutbox from "../../migrations/0003_webhook_outbox.sql" with { type: "text" };
import repositoryDeletionQuarantine from "../../migrations/0004_repository_deletion_quarantine.sql" with { type: "text" };

export const migrations: readonly {
  readonly version: string;
  readonly sql: string;
}[] = [
  { version: "0001", sql: baseline },
  { version: "0002", sql: principalIdentity },
  { version: "0003", sql: webhookOutbox },
  { version: "0004", sql: repositoryDeletionQuarantine },
];

/**
 * Complete already-applied current schema, used by in-memory tests and local
 * tooling. Include ledger rows so a Worker request over a preloaded fake does
 * not try to re-run non-idempotent ALTER statements.
 */
export const migrationSql: string = migrations
  .map(
    (migration) =>
      `${migration.sql}\nINSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES ('${migration.version}', 0);`,
  )
  .join("\n");
