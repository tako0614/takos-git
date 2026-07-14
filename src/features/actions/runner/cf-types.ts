/**
 * Narrow, local Cloudflare Durable Object + Container binding surfaces.
 *
 * takos-git typechecks WITHOUT `@cloudflare/workers-types` (see `src/git/types.ts`
 * for R2 and `src/db/client.ts` for D1). The Durable Object / Container runtime is
 * declared here as the minimal subset the runner wiring uses; a real workerd
 * `DurableObjectState` / `Container` satisfies it structurally.
 */

export interface DurableObjectId {
  toString(): string;
  readonly name?: string;
}

export interface DurableObjectStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T = unknown>(options?: { prefix?: string }): Promise<Map<string, T>>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  getAlarm(): Promise<number | null>;
}

export interface DurableObjectState {
  readonly id: DurableObjectId;
  readonly storage: DurableObjectStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  waitUntil?(promise: Promise<unknown>): void;
}

export interface DurableObjectStub {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

export interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

/** The `@cloudflare/containers` Container subset the job-runner DO uses. */
export interface ContainerRuntime {
  containerFetch(request: Request, port?: number): Promise<Response>;
  startAndWaitForPorts(
    ports?: number | number[],
    cancellationOptions?: Record<string, unknown>,
    startOptions?: { envVars?: Record<string, string>; entrypoint?: string[] },
  ): Promise<void>;
  destroy?(): Promise<void> | void;
  stop?(): Promise<void> | void;
}
