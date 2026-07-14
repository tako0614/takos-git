/**
 * Ambient declaration for the tiny subset of `bun:sqlite` used by the in-memory
 * D1 test adapter (`fake.ts`). The real module ships with the Bun runtime; this
 * keeps `tsc --noEmit` honest without pulling `bun-types` (which would collide
 * with the WebWorker lib the worker typechecks against). The adapter is never in
 * the deployed Worker bundle — only tests import it.
 */
declare module "bun:sqlite" {
  export type SqlParam = string | number | bigint | boolean | null | Uint8Array;

  export class Statement {
    all(...params: SqlParam[]): unknown[];
    get(...params: SqlParam[]): unknown;
    run(...params: SqlParam[]): {
      lastInsertRowid: number | bigint;
      changes: number;
    };
    values(...params: SqlParam[]): unknown[][];
    finalize(): void;
  }

  export class Database {
    constructor(filename?: string, options?: unknown);
    query(sql: string): Statement;
    prepare(sql: string): Statement;
    run(
      sql: string,
      ...params: SqlParam[]
    ): { lastInsertRowid: number | bigint; changes: number };
    exec(sql: string): void;
    close(): void;
  }

  export default Database;
}
