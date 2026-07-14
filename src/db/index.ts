/**
 * D1 metadata-plane entrypoint.
 *
 * Re-exports the runtime DB contract every feature service imports. `fake.ts` is
 * test-only (it value-imports `bun:sqlite`) and is therefore imported directly by
 * tests — never re-exported here, so it can never reach the deployed Worker
 * bundle.
 */

export {
  createDbClient,
  DbClient,
  ulid,
  type D1Binding,
  type D1Database,
  type D1PreparedStatement,
  type D1Result,
  type D1RunMeta,
  type DbClientOptions,
  type DbStatement,
} from "./client.ts";
