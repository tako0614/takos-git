/**
 * In-memory R2 double for tests: implements the narrow ObjectStoreBinding
 * surface (get / head / put / delete) over a Map.
 */

import type { ObjectStoreBinding, ObjectStoreObjectBody, ObjectStoreObjectHead } from "./git/types.ts";

export class MemoryBucket implements ObjectStoreBinding {
  readonly store = new Map<string, Uint8Array>();

  async get(key: string): Promise<ObjectStoreObjectBody | null> {
    const value = this.store.get(key);
    if (!value) return null;
    return { arrayBuffer: async () => value.slice().buffer as ArrayBuffer };
  }

  async head(key: string): Promise<ObjectStoreObjectHead | null> {
    return this.store.has(key) ? { key } : null;
  }

  async put(
    key: string,
    value: Uint8Array | ArrayBuffer | ReadableStream | string,
  ): Promise<unknown> {
    let bytes: Uint8Array;
    if (typeof value === "string") bytes = new TextEncoder().encode(value);
    else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
    else if (value instanceof Uint8Array) bytes = value.slice();
    else bytes = new Uint8Array(await new Response(value).arrayBuffer());
    this.store.set(key, bytes);
    return {};
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}
