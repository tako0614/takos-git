import { describe, expect, test } from "bun:test";

import { decodeObject } from "./object.ts";

const encode = (value: string) => new TextEncoder().encode(value);

describe("git loose object decoder", () => {
  test("rejects an unknown object type", () => {
    expect(() => decodeObject(encode("unknown 3\0abc"))).toThrow(
      "Invalid git object header type",
    );
  });

  test("rejects a declared size that differs from the payload", () => {
    expect(() => decodeObject(encode("blob 5\0abc"))).toThrow(
      "declared size does not match content",
    );
  });

  test("accepts an exact object payload", () => {
    expect(decodeObject(encode("blob 3\0abc"))).toEqual({
      type: "blob",
      content: encode("abc"),
    });
  });
});
