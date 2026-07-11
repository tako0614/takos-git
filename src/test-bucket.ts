/**
 * In-memory R2 double for tests: implements the narrow ObjectStoreBinding
 * surface (get / head / put / delete / list) over a Map.
 */

import type {
  ObjectStoreBinding,
  ObjectStoreListResult,
  ObjectStoreObjectBody,
  ObjectStoreObjectHead,
  ObjectStorePutOptions,
} from "./git/types.ts";

export class MemoryBucket implements ObjectStoreBinding {
  readonly store = new Map<string, Uint8Array>();
  readonly etags = new Map<string, string>();
  #version = 0;

  async get(key: string): Promise<ObjectStoreObjectBody | null> {
    const value = this.store.get(key);
    if (!value) return null;
    return {
      key,
      etag: this.etags.get(key) as string,
      arrayBuffer: async () => value.slice().buffer as ArrayBuffer,
    };
  }

  async head(key: string): Promise<ObjectStoreObjectHead | null> {
    return this.store.has(key)
      ? { key, etag: this.etags.get(key) as string }
      : null;
  }

  async put(
    key: string,
    value: Uint8Array | ArrayBuffer | ReadableStream | string,
    options?: ObjectStorePutOptions,
  ): Promise<ObjectStoreObjectHead | null> {
    const currentEtag = this.etags.get(key);
    const condition = options?.onlyIf;
    if (
      condition?.etagMatches !== undefined &&
      currentEtag !== condition.etagMatches
    ) {
      return null;
    }
    if (
      condition?.etagDoesNotMatch !== undefined &&
      (condition.etagDoesNotMatch === "*"
        ? currentEtag !== undefined
        : currentEtag === condition.etagDoesNotMatch)
    ) {
      return null;
    }
    let bytes: Uint8Array;
    if (typeof value === "string") bytes = new TextEncoder().encode(value);
    else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
    else if (value instanceof Uint8Array) bytes = value.slice();
    else bytes = new Uint8Array(await new Response(value).arrayBuffer());
    this.store.set(key, bytes);
    const etag = `memory-${++this.#version}`;
    this.etags.set(key, etag);
    return { key, etag };
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
    this.etags.delete(key);
  }

  async list(options?: {
    prefix?: string;
    cursor?: string;
    limit?: number;
  }): Promise<ObjectStoreListResult> {
    const prefix = options?.prefix ?? "";
    const keys = [...this.store.keys()].filter((key) => key.startsWith(prefix)).sort();
    const start = options?.cursor ? Number.parseInt(options.cursor, 10) : 0;
    const limit = Math.max(1, Math.min(options?.limit ?? 1000, 1000));
    const objects = keys.slice(start, start + limit).map((key) => ({ key }));
    const next = start + objects.length;
    return {
      objects,
      truncated: next < keys.length,
      ...(next < keys.length ? { cursor: String(next) } : {}),
    };
  }
}
