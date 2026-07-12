/**
 * Minimal R2 object-store binding surface used by the lifted git engine.
 *
 * The engine only ever calls get / head / put / delete / list, so this narrow type is
 * satisfied by a real Cloudflare `R2Bucket` (and by the in-memory test double).
 * Declared locally so the standalone service typechecks without
 * `@cloudflare/workers-types`.
 */

export interface ObjectStoreObjectBody {
  readonly key: string;
  readonly etag: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface ObjectStoreObjectHead {
  readonly key: string;
  readonly etag: string;
}

export interface ObjectStorePutOptions {
  readonly onlyIf?: {
    readonly etagMatches?: string;
    readonly etagDoesNotMatch?: string;
  };
}

export interface ObjectStoreListResult {
  objects: Array<{ key: string }>;
  truncated: boolean;
  cursor?: string;
}

export interface ObjectStoreBinding {
  get(key: string): Promise<ObjectStoreObjectBody | null>;
  head(key: string): Promise<ObjectStoreObjectHead | null>;
  put(
    key: string,
    value: Uint8Array | ArrayBuffer | ReadableStream | string,
    options?: ObjectStorePutOptions,
  ): Promise<ObjectStoreObjectHead | null>;
  delete(key: string | string[]): Promise<void>;
  list(options?: {
    prefix?: string;
    cursor?: string;
    limit?: number;
  }): Promise<ObjectStoreListResult>;
}
