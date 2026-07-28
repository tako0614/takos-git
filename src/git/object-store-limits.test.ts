import { expect, test } from "bun:test";

import { getRawObject } from "./object-store.ts";
import type { ObjectStoreBinding } from "./types.ts";

test("loose-object reads reject an oversized compressed body before buffering it", async () => {
  let buffered = false;
  const bucket = {
    get: async () => ({
      key: "objects/aa/rest",
      etag: "oversized",
      size: 33 * 1024 * 1024 + 1,
      arrayBuffer: async () => {
        buffered = true;
        return new ArrayBuffer(0);
      },
    }),
    head: async () => null,
    put: async () => null,
    delete: async () => undefined,
    list: async () => ({ objects: [], truncated: false }),
  } satisfies ObjectStoreBinding;

  await expect(getRawObject(bucket, "a".repeat(40))).rejects.toThrow(
    "Compressed Git object exceeds the 34603008-byte limit",
  );
  expect(buffered).toBe(false);
});
