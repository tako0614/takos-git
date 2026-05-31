// Bun migration shim: node:sqlite -> bun:sqlite.
//
// Bun 1.3.14 does not implement Node's experimental built-in `node:sqlite`
// (the `DatabaseSync` API used by src/git.ts and src/index_test.ts). Bun
// instead ships `bun:sqlite`, which provides an API-compatible synchronous
// SQLite binding. This shim re-exports a `DatabaseSync` class backed by
// `bun:sqlite` so the existing `import { DatabaseSync } from "node:sqlite"`
// call sites run unchanged under bun. It is wired in via tsconfig "paths"
// ("node:sqlite" -> this file), the same mechanism the @std/* shims use.
//
// Surface required by this repo (verified by grep over src/):
//   new DatabaseSync(path)         -> open a database file (or :memory:)
//   db.close()
//   db.exec(sql)                   -> run statements with no params (DDL, tx)
//   const stmt = db.prepare(sql)
//   stmt.get(...params)            -> first row as object, or undefined on miss
//   stmt.run(...params)            -> execute write
//   stmt.all(...params)            -> all rows as objects
//
// node:sqlite `.get()` returns `undefined` when there is no row; bun:sqlite's
// `Statement.get()` can return `null`. We normalize `null` -> `undefined` so
// callers like `if (hasMigration.get(version))` and `.get() as { count }`
// behave identically to node:sqlite.

import { Database, type Statement as BunStatement } from "bun:sqlite";

class StatementSync {
  #stmt: BunStatement;
  constructor(stmt: BunStatement) {
    this.#stmt = stmt;
  }

  get(...params: unknown[]): unknown {
    // deno-lint-ignore no-explicit-any
    const row = (this.#stmt.get as (...a: unknown[]) => any)(...params);
    return row == null ? undefined : row;
  }

  run(...params: unknown[]): unknown {
    // deno-lint-ignore no-explicit-any
    return (this.#stmt.run as (...a: unknown[]) => any)(...params);
  }

  all(...params: unknown[]): unknown[] {
    // deno-lint-ignore no-explicit-any
    return (this.#stmt.all as (...a: unknown[]) => any[])(...params) ?? [];
  }

  iterate(...params: unknown[]): IterableIterator<unknown> {
    // bun:sqlite exposes iteration via .iterate when available.
    // deno-lint-ignore no-explicit-any
    const it = (this.#stmt as any).iterate;
    if (typeof it === "function") return it.call(this.#stmt, ...params);
    return this.all(...params)[Symbol.iterator]();
  }
}

export class DatabaseSync {
  #db: Database;
  constructor(path: string) {
    this.#db = new Database(path);
  }

  exec(sql: string): void {
    this.#db.exec(sql);
  }

  prepare(sql: string): StatementSync {
    return new StatementSync(this.#db.prepare(sql));
  }

  close(): void {
    this.#db.close();
  }
}

export { StatementSync };
export default { DatabaseSync, StatementSync };
