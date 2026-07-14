/**
 * Small request-parsing helpers shared by the issues feature handlers. Response
 * + error helpers and identity/CSRF come from the frozen repos-feature modules
 * (`../repos/http.ts`, `../repos/identity.ts`) — reused verbatim, not re-authored.
 */

import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
} from "../../contract/v1.ts";

const MAX_BODY_BYTES = 256 * 1024;

/** Parse a JSON object body, or null on oversize / non-object / bad JSON. */
export async function readJson(
  request: Request,
): Promise<Record<string, unknown> | null> {
  const length = request.headers.get("content-length");
  if (length && Number(length) > MAX_BODY_BYTES) return null;
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > MAX_BODY_BYTES) return null;
  if (bytes.length === 0) return {};
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** A trimmed non-empty string, or null. */
export function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** A string array of trimmed non-empty entries (deduped), or null if not an array. */
export function strArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    const s = str(entry);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/** Parse a positive integer path param (issue/milestone number), or null. */
export function parseNumberParam(value: string | undefined): number | null {
  if (!value) return null;
  if (!/^[0-9]+$/u.test(value)) return null;
  const n = Number.parseInt(value, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Opaque offset cursor: `?cursor=` decodes to a non-negative integer offset. */
export function decodeOffsetCursor(cursor: string | null): number {
  if (!cursor) return 0;
  try {
    const decoded = atob(cursor);
    if (!/^o:[0-9]+$/u.test(decoded)) return 0;
    const offset = Number.parseInt(decoded.slice(2), 10);
    return Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  } catch {
    return 0;
  }
}

export function encodeOffsetCursor(offset: number): string {
  return btoa(`o:${offset}`);
}

/** Read `?limit=` clamped to [1, MAX], defaulting to DEFAULT_PAGE_LIMIT. */
export function readLimit(url: URL): number {
  const requested = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  return Number.isSafeInteger(requested)
    ? Math.max(1, Math.min(requested, MAX_PAGE_LIMIT))
    : DEFAULT_PAGE_LIMIT;
}

export function parseStateFilter(
  value: string | null,
): "open" | "closed" | "all" {
  if (value === "closed") return "closed";
  if (value === "all") return "all";
  return "open";
}
