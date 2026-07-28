/**
 * Hard resource budgets for the pure Git engine.
 *
 * The Worker must materialize loose objects and pack entries in memory. The
 * 48 MiB pack budgets leave room for the request buffer and decoder state in a
 * 128 MiB Worker isolate.
 */
export const MAX_GIT_OBJECT_BYTES = 32 * 1024 * 1024;
export const MAX_GIT_RAW_OBJECT_BYTES = MAX_GIT_OBJECT_BYTES + 128;
export const MAX_GIT_COMPRESSED_OBJECT_BYTES = 33 * 1024 * 1024;
export const MAX_TAG_OBJECT_BYTES = 64 * 1024;
export const MAX_PACK_BYTES = 48 * 1024 * 1024;
export const MAX_PACK_INFLATED_BYTES = 48 * 1024 * 1024;
export const MAX_PACK_OBJECTS = 100_000;
export const MAX_DELTA_DEPTH = 50;
export const MAX_REACHABLE_OBJECTS = 100_000;
export const MAX_TREE_DEPTH = 256;
export const MAX_TAG_PEEL_DEPTH = 10;
export const MAX_UPLOAD_PACK_REQUEST_BYTES = 1024 * 1024;
export const MAX_RECEIVE_PACK_REQUEST_BYTES = 64 * 1024 * 1024;

export class GitResourceLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitResourceLimitError";
  }
}
