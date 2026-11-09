import { decodeOffsetCursor } from "./common.ts";
import type { CommentPosition } from "./store.ts";

export type CommentCursor =
  | { readonly kind: "offset"; readonly offset: number }
  | { readonly kind: "after"; readonly after: CommentPosition };

/** New cursors anchor a row; old server-issued offsets remain readable. */
export function decodeCommentCursor(cursor: string | null): CommentCursor {
  const first: CommentCursor = { kind: "offset", offset: 0 };
  if (!cursor || cursor.length > 2048) return first;
  try {
    const bytes = Uint8Array.from(atob(cursor), (char) => char.charCodeAt(0));
    const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!value.startsWith("c:")) return { kind: "offset", offset: decodeOffsetCursor(cursor) };
    const position: unknown = JSON.parse(value.slice(2));
    if (!Array.isArray(position) || position.length !== 2) return first;
    const [createdAt, id] = position;
    if (!Number.isSafeInteger(createdAt) || createdAt < 0 || typeof id !== "string" ||
        id.length === 0 || id.length > 256 || /[\u0000-\u001f\u007f]/u.test(id)) return first;
    return { kind: "after", after: { createdAt, id } };
  } catch {
    return first;
  }
}

export function encodeCommentCursor(position: CommentPosition): string {
  const bytes = new TextEncoder().encode(`c:${JSON.stringify([position.createdAt, position.id])}`);
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
}
