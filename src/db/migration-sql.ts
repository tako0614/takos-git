/**
 * The baseline D1 schema as text. Import-as-text is inlined by the bundler and
 * typed by the `*.sql` ambient module. Loaded into the in-memory `fake.ts` adapter
 * by tests, AND embedded in the deployed Worker so `ensure-schema.ts` can apply the
 * schema on first use (the install ships no separate `wrangler d1 migrations` step).
 */
import baseline from "../../migrations/0001_init.sql" with { type: "text" };

export const migrationSql: string = baseline;
