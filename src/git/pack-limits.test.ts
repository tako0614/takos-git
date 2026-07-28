import { describe, expect, test } from "bun:test";

import { deflate } from "./object-store.ts";
import { inflateZlibAt } from "./inflate-raw.ts";
import { encodePackObjectHeader, PACK_OBJ } from "./pack-common.ts";
import { readPack } from "./pack-reader.ts";
import { concatBytes, hexToBytes, sha1 } from "./sha1.ts";

const MAX_OBJECT_BYTES = 32 * 1024 * 1024;

function packHeader(objectCount: number): Uint8Array {
  const header = new Uint8Array(12);
  header.set(new TextEncoder().encode("PACK"));
  const view = new DataView(header.buffer);
  view.setUint32(4, 2, false);
  view.setUint32(8, objectCount, false);
  return header;
}

async function checkedPackBody(...entries: Uint8Array[]): Promise<Uint8Array> {
  const body = concatBytes(...entries);
  return concatBytes(body, hexToBytes(await sha1(body)));
}

function encodeOfsDistance(distance: number): Uint8Array {
  const bytes = [distance & 0x7f];
  while ((distance = Math.floor(distance / 128)) > 0) {
    distance -= 1;
    bytes.push(0x80 | (distance & 0x7f));
  }
  bytes.reverse();
  return new Uint8Array(bytes);
}

async function deltaChainPack(depth: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [packHeader(depth + 1)];
  let bodyLength = 12;

  const base = new TextEncoder().encode("a");
  const baseEntry = concatBytes(
    encodePackObjectHeader(PACK_OBJ.BLOB, base.length),
    await deflate(base),
  );
  let previousStart = bodyLength;
  chunks.push(baseEntry);
  bodyLength += baseEntry.length;

  // source-size=1, target-size=1, copy one byte from offset zero.
  const delta = new Uint8Array([0x01, 0x01, 0x90, 0x01]);
  for (let i = 0; i < depth; i += 1) {
    const start = bodyLength;
    const entry = concatBytes(
      encodePackObjectHeader(PACK_OBJ.OFS_DELTA, delta.length),
      encodeOfsDistance(start - previousStart),
      await deflate(delta),
    );
    chunks.push(entry);
    bodyLength += entry.length;
    previousStart = start;
  }

  return checkedPackBody(...chunks);
}

describe("pack resource limits", () => {
  test("inflation stops at the caller's output budget", async () => {
    const compressed = await deflate(new TextEncoder().encode("hello"));
    expect(() => inflateZlibAt(compressed, 0, 4)).toThrow(
      "inflate: output exceeds the 4-byte limit",
    );
  });

  test("rejects an object whose declared size exceeds 32 MiB before inflation", async () => {
    const pack = await checkedPackBody(
      packHeader(1),
      encodePackObjectHeader(PACK_OBJ.BLOB, MAX_OBJECT_BYTES + 1),
      await deflate(new Uint8Array()),
    );
    await expect(readPack(pack)).rejects.toThrow(
      `pack: object exceeds the ${MAX_OBJECT_BYTES}-byte limit`,
    );
  });

  test("rejects more than 100,000 entries before parsing them", async () => {
    await expect(readPack(packHeader(100_001))).rejects.toThrow(
      "pack: object count exceeds the 100000-entry limit",
    );
  });

  test("rejects delta chains deeper than 50 objects", async () => {
    await expect(readPack(await deltaChainPack(51))).rejects.toThrow(
      "pack: delta chain exceeds the 50-object depth limit",
    );
  });
});
