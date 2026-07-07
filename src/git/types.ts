/**
 * Minimal R2 object-store binding surface used by the lifted git engine.
 *
 * The engine only ever calls get / head / put / delete, so this narrow type is
 * satisfied by a real Cloudflare `R2Bucket` (and by the in-memory test double).
 * Declared locally so the standalone service typechecks without
 * `@cloudflare/workers-types`.
 */

export interface ObjectStoreObjectBody {
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface ObjectStoreObjectHead {
  key: string;
}

export interface ObjectStoreBinding {
  get(key: string): Promise<ObjectStoreObjectBody | null>;
  head(key: string): Promise<ObjectStoreObjectHead | null>;
  put(
    key: string,
    value: Uint8Array | ArrayBuffer | ReadableStream | string,
  ): Promise<unknown>;
  delete(key: string): Promise<void>;
}
