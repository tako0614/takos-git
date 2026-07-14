/**
 * Thin typed wrapper over the Cloudflare D1 binding (`env.DB`).
 *
 * takos-git is framework-free and typechecks without `@cloudflare/workers-types`,
 * so the D1 surface is declared locally (mirroring `src/git/types.ts` for R2). A
 * real `D1Database` satisfies `D1Binding`, and so does the in-memory `fake.ts`
 * adapter used by tests.
 *
 * D1 is the METADATA plane only. Git objects and refs stay authoritative in R2;
 * every SHA/ref pointer stored through D1 is an advisory projection re-validatable
 * against R2 (see `src/git/two-phase.ts`, the only sanctioned cross-store writer).
 */

// --- narrow D1 binding surface (subset of Cloudflare's D1Database) -----------

export interface D1RunMeta {
  readonly changes?: number;
  readonly last_row_id?: number | bigint;
  readonly rows_read?: number;
  readonly rows_written?: number;
  readonly [key: string]: unknown;
}

export interface D1Result<T = Record<string, unknown>> {
  readonly results: T[];
  readonly success: boolean;
  readonly meta: D1RunMeta;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(colName: string): Promise<unknown>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  raw<T = unknown>(): Promise<T[]>;
}

export interface D1Binding {
  prepare(query: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(
    statements: D1PreparedStatement[],
  ): Promise<D1Result<T>[]>;
  exec(query: string): Promise<{ count: number; duration: number }>;
}

// Alias kept so call sites can name the Cloudflare type they expect.
export type D1Database = D1Binding;

// --- ULID generation (dependency-free, lexicographically sortable) -----------

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Generate a Crockford base32 ULID (48-bit time + 80-bit randomness). */
export function ulid(now: number = Date.now()): string {
  let time = Math.floor(now);
  const timeChars = new Array<string>(10);
  for (let index = 9; index >= 0; index -= 1) {
    timeChars[index] = CROCKFORD[time % 32];
    time = Math.floor(time / 32);
  }
  const random = crypto.getRandomValues(new Uint8Array(16));
  let randomChars = "";
  for (let index = 0; index < 16; index += 1) {
    randomChars += CROCKFORD[random[index] % 32];
  }
  return timeChars.join("") + randomChars;
}

// --- client ------------------------------------------------------------------

export interface DbClientOptions {
  /** Injected clock (epoch ms) so tests get deterministic timestamps. */
  readonly now?: () => number;
  /** Injected id generator so tests can pin ULIDs. */
  readonly ulid?: () => string;
}

export interface DbStatement {
  readonly sql: string;
  readonly params?: readonly unknown[];
}

/**
 * The DB contract every feature service imports. Keeps SQL text explicit (no ORM)
 * and threads the injected clock + id generator used across the metadata plane.
 */
export class DbClient {
  readonly binding: D1Binding;
  readonly #now: () => number;
  readonly #ulid: () => string;

  constructor(binding: D1Binding, options: DbClientOptions = {}) {
    this.binding = binding;
    this.#now = options.now ?? (() => Date.now());
    this.#ulid = options.ulid ?? (() => ulid(this.#now()));
  }

  /** Current epoch milliseconds from the injected clock. */
  now(): number {
    return this.#now();
  }

  /** A fresh ULID from the injected generator. */
  id(): string {
    return this.#ulid();
  }

  /** Run a query and return every row. */
  async query<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> {
    const result = await this.binding
      .prepare(sql)
      .bind(...params)
      .all<T>();
    return result.results;
  }

  /** Run a query and return the first row (or null). */
  async queryOne<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T | null> {
    return this.binding
      .prepare(sql)
      .bind(...params)
      .first<T>();
  }

  /** Execute a write statement; returns the D1 run result. */
  async run(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<D1Result> {
    return this.binding
      .prepare(sql)
      .bind(...params)
      .run();
  }

  /** Execute a batch atomically (D1 wraps the batch in a transaction). */
  async batch(statements: readonly DbStatement[]): Promise<void> {
    if (statements.length === 0) return;
    await this.binding.batch(
      statements.map((statement) =>
        this.binding.prepare(statement.sql).bind(...(statement.params ?? [])),
      ),
    );
  }
}

/** Construct a {@link DbClient} over a raw D1 binding. */
export function createDbClient(
  binding: D1Binding,
  options?: DbClientOptions,
): DbClient {
  return new DbClient(binding, options);
}
