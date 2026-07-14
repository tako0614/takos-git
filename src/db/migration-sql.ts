/**
 * The baseline D1 schema as text, for tests that load it into the in-memory
 * `fake.ts` adapter. Import-as-text is inlined by the bundler and typed by the
 * `*.sql` ambient module; this file is only ever imported by tests, so the SQL
 * never enters the deployed Worker.
 */
import baseline from "../../migrations/0001_init.sql" with { type: "text" };

export const migrationSql: string = baseline;
