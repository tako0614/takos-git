/**
 * Git packfile **writer** (format v2), used to serve clone/fetch over smart
 * HTTP from the R2-backed loose-object store.
 *
 * Objects are emitted **undeltified** (full, zlib-compressed content). This is
 * a valid packfile that every git client accepts; it trades a larger transfer
 * for a simple, allocation-bounded encoder that needs no delta search. Delta
 * compression is a future optimization, not a correctness requirement.
 */

import type { ObjectStoreBinding } from "./types.ts";
import type { GitObjectType } from "./git-objects.ts";
import { concatBytes, hexToBytes, sha1 } from "./sha1.ts";
import { deflate, getObject } from "./object-store.ts";
import { encodePackObjectHeader, gitTypeToNumber } from "./pack-common.ts";
import {
  GitResourceLimitError,
  MAX_GIT_OBJECT_BYTES,
  MAX_PACK_BYTES,
  MAX_PACK_INFLATED_BYTES,
  MAX_PACK_OBJECTS,
  MAX_TAG_OBJECT_BYTES,
} from "./limits.ts";

const TEXT_ENCODER = new TextEncoder();

export interface PackInputObject {
  readonly type: GitObjectType;
  readonly content: Uint8Array;
}

interface PackBudget {
  inflatedBytes: number;
  encodedBytes: number;
}

function packHeader(objectCount: number): Uint8Array {
  const header = new Uint8Array(12);
  header.set(TEXT_ENCODER.encode("PACK"), 0);
  const view = new DataView(header.buffer);
  view.setUint32(4, 2, false); // version 2
  view.setUint32(8, objectCount, false); // object count (big-endian)
  return header;
}

async function appendPackObject(
  chunks: Uint8Array[],
  obj: PackInputObject,
  budget: PackBudget,
): Promise<void> {
  const maxObjectBytes =
    obj.type === "tag" ? MAX_TAG_OBJECT_BYTES : MAX_GIT_OBJECT_BYTES;
  if (obj.content.byteLength > maxObjectBytes) {
    throw new GitResourceLimitError(
      `pack: object exceeds the ${maxObjectBytes}-byte limit`,
    );
  }
  if (
    budget.inflatedBytes >
    MAX_PACK_INFLATED_BYTES - obj.content.byteLength
  ) {
    throw new GitResourceLimitError(
      `pack: objects exceed the ${MAX_PACK_INFLATED_BYTES}-byte limit`,
    );
  }
  budget.inflatedBytes += obj.content.byteLength;

  const header = encodePackObjectHeader(
    gitTypeToNumber(obj.type),
    obj.content.length,
  );
  const compressed = await deflate(obj.content);
  if (
    budget.encodedBytes >
    MAX_PACK_BYTES - header.byteLength - compressed.byteLength
  ) {
    throw new GitResourceLimitError(
      `pack: encoded output exceeds the ${MAX_PACK_BYTES}-byte limit`,
    );
  }
  budget.encodedBytes += header.byteLength + compressed.byteLength;
  chunks.push(header, compressed);
}

async function finishPack(
  chunks: Uint8Array[],
  objectCount: number,
): Promise<Uint8Array> {
  chunks[0] = packHeader(objectCount);
  const body = concatBytes(...chunks);
  // Drop the per-entry compressed buffers before allocating the final result.
  chunks.length = 0;
  const trailer = hexToBytes(await sha1(body));
  const pack = new Uint8Array(body.byteLength + trailer.byteLength);
  pack.set(body);
  pack.set(trailer, body.byteLength);
  return pack;
}

/**
 * Build a packfile from fully-materialized objects. Each object is written as a
 * base (non-delta) entry; a 20-byte SHA-1 trailer over all preceding bytes is
 * appended per the pack format.
 */
export async function writePack(
  objects: readonly PackInputObject[],
): Promise<Uint8Array> {
  if (objects.length > MAX_PACK_OBJECTS) {
    throw new GitResourceLimitError(
      `pack: object count exceeds the ${MAX_PACK_OBJECTS}-entry limit`,
    );
  }
  const chunks: Uint8Array[] = [packHeader(0)];
  const budget: PackBudget = {
    inflatedBytes: 0,
    encodedBytes: 12 + 20, // header + checksum
  };

  for (const obj of objects) {
    await appendPackObject(chunks, obj, budget);
  }

  return finishPack(chunks, objects.length);
}

/**
 * Build a packfile for the given object SHAs by reading each from the object
 * store. Unknown/missing SHAs are skipped (they cannot be encoded and would
 * otherwise abort a whole clone); callers compute the SHA set from reachability
 * so a missing object signals a corrupt/partially-ingested repo, not a normal
 * case. The returned `missing` list lets the caller log/deny as appropriate.
 */
export async function writePackFromShas(
  bucket: ObjectStoreBinding,
  shas: readonly string[],
): Promise<{ pack: Uint8Array; written: number; missing: string[] }> {
  if (shas.length > MAX_PACK_OBJECTS) {
    throw new GitResourceLimitError(
      `pack: object count exceeds the ${MAX_PACK_OBJECTS}-entry limit`,
    );
  }
  const chunks: Uint8Array[] = [packHeader(0)];
  const missing: string[] = [];
  const budget: PackBudget = {
    inflatedBytes: 0,
    encodedBytes: 12 + 20,
  };
  let written = 0;

  for (const sha of shas) {
    const obj = await getObject(bucket, sha);
    if (!obj) {
      missing.push(sha);
      continue;
    }
    await appendPackObject(chunks, obj, budget);
    written += 1;
  }

  const pack = await finishPack(chunks, written);
  return { pack, written, missing };
}
