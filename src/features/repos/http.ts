/**
 * Shared response helpers for the repos feature (and, by pattern, every Phase-3b
 * feature). All bodies use the versioned contract envelope from `contract/v1.ts`
 * — success bodies are resource-shaped; errors are `{ error: { code, message } }`.
 */

import { errorBody } from "../../contract/v1.ts";

export function json(
  body: unknown,
  status = 200,
  headers?: HeadersInit,
): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "application/json; charset=utf-8");
  responseHeaders.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
}

export function errorResponse(
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
  headers?: HeadersInit,
): Response {
  return json(errorBody(code, message, details), status, headers);
}
