/**
 * In-memory `D1Database`-shaped adapter backed by `bun:sqlite`, for tests.
 *
 * The real Worker never imports this file, so `bun:sqlite` never enters the
 * deployed bundle; `bun-sqlite.d.ts` supplies the compile-time types. It is
 * "good enough" to load `migrations/0001_init.sql` and round-trip
 * inserts/selects through the same `DbClient` the product uses.
 */

import { Database } from "bun:sqlite";
import type {
  D1Binding,
  D1PreparedStatement,
  D1Result,
} from "./client.ts";

/** Coerce a bound value into a type `bun:sqlite` accepts (mirrors D1 coercion). */
function coerce(value: unknown): string | number | bigint | null | Uint8Array {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    value instanceof Uint8Array
  ) {
    return value;
  }
  // Fall back to JSON text for structured values, matching how callers persist
  // JSON columns (D1 would reject the raw object).
  return JSON.stringify(value);
}

class FakeStatement implements D1PreparedStatement {
  readonly #db: Database;
  readonly #sql: string;
  #params: Array<string | number | bigint | null | Uint8Array> = [];

  constructor(db: Database, sql: string) {
    this.#db = db;
    this.#sql = sql;
  }

  bind(...values: unknown[]): D1PreparedStatement {
    this.#params = values.map(coerce);
    return this;
  }

  async first<T = Record<string, unknown>>(colName?: string): Promise<unknown> {
    const row = this.#db.query(this.#sql).get(...this.#params) as
      | Record<string, unknown>
      | null
      | undefined;
    if (row === null || row === undefined) return null;
    if (colName !== undefined) return row[colName] ?? null;
    return row as T;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const results = this.#db.query(this.#sql).all(...this.#params) as T[];
    return { results, success: true, meta: { rows_read: results.length } };
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const info = this.#db.query(this.#sql).run(...this.#params);
    return {
      results: [],
      success: true,
      meta: { changes: info.changes, last_row_id: info.lastInsertRowid },
    };
  }

  async raw<T = unknown>(): Promise<T[]> {
    return this.#db.query(this.#sql).values(...this.#params) as T[];
  }
}

/** A `bun:sqlite`-backed object implementing the narrow D1 binding surface. */
export class FakeD1 implements D1Binding {
  readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  prepare(query: string): D1PreparedStatement {
    return new FakeStatement(this.db, query);
  }

  async batch<T = Record<string, unknown>>(
    statements: D1PreparedStatement[],
  ): Promise<D1Result<T>[]> {
    // D1 batches run atomically; mirror that with a sqlite transaction.
    this.db.exec("BEGIN");
    try {
      const out: D1Result<T>[] = [];
      for (const statement of statements) out.push(await statement.run<T>());
      this.db.exec("COMMIT");
      return out;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async exec(query: string): Promise<{ count: number; duration: number }> {
    const started = Date.now();
    this.db.exec(query);
    // count is best-effort (statement count) — good enough for tests.
    const count = query.split(";").filter((part) => part.trim()).length;
    return { count, duration: Date.now() - started };
  }
}

/**
 * Create an in-memory D1 binding, optionally loading a schema (e.g. the text of
 * `migrations/0001_init.sql`). Foreign keys are enforced to match D1.
 */
export function createFakeD1(schemaSql?: string): FakeD1 {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  if (schemaSql) db.exec(schemaSql);
  return new FakeD1(db);
}
