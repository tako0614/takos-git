/**
 * The typed same-origin fetch wrapper every feature client is built on.
 *
 * Invariants:
 * - Cookie-only auth (`credentials: "same-origin"`). The SPA NEVER sends an
 *   Interface OAuth `taksrv_` bearer — that channel is CLI/automation-only.
 * - Standard error envelope `{ error: { code, message, details? } }` (contract
 *   §"Pagination + error envelope"), surfaced as a typed `ApiError`.
 * - CSRF on writes is proven by the browser-automatic `Origin` / `Sec-Fetch-Site`
 *   headers on a same-origin fetch (server `csrfGuard`); no custom token header
 *   is required.
 * - One pagination convention: `?limit&cursor` → `{ <key>: [...], nextCursor }`.
 */

const API_TIMEOUT_MS = 20_000;

/** A structured API failure carrying the envelope code + HTTP status. */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    if (details) this.details = details;
  }

  get isUnauthenticated(): boolean {
    return this.status === 401;
  }
  get isForbidden(): boolean {
    return this.status === 403;
  }
  get isNotFound(): boolean {
    return this.status === 404;
  }
}

export type QueryValue = string | number | boolean | null | undefined;
export type Query = Record<string, QueryValue>;

/** `owner/name` segment-encoded exactly as the worker's `parseRepoRoute` expects. */
export function repoPath(owner: string, repo: string): string {
  return `/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function withQuery(path: string, query?: Query): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

async function toError(response: Response): Promise<ApiError> {
  let code = "http_error";
  let message = response.statusText || `Request failed (${response.status})`;
  let details: Record<string, unknown> | undefined;
  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string; details?: Record<string, unknown> };
    };
    if (body?.error) {
      if (body.error.code) code = body.error.code;
      if (body.error.message) message = body.error.message;
      if (body.error.details) details = body.error.details;
    }
  } catch {
    /* non-JSON error body — keep the status-derived message */
  }
  return new ApiError(response.status, code, message, details);
}

interface RequestOptions {
  readonly query?: Query;
  readonly signal?: AbortSignal;
  readonly body?: unknown;
  /** Send a raw body (FormData / Blob) untouched instead of JSON. */
  readonly rawBody?: BodyInit;
}

async function request<T>(
  method: string,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  const signal = options.signal
    ? anySignal([options.signal, controller.signal])
    : controller.signal;

  const headers: Record<string, string> = { accept: "application/json" };
  let body: BodyInit | undefined;
  if (options.rawBody !== undefined) {
    body = options.rawBody;
  } else if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }

  try {
    const response = await fetch(withQuery(path, options.query), {
      method,
      credentials: "same-origin",
      headers,
      ...(body !== undefined ? { body } : {}),
      signal,
    });
    if (!response.ok) throw await toError(response);
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  } finally {
    clearTimeout(timer);
  }
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}

// --- verb helpers -----------------------------------------------------------

export const api = {
  get: <T>(path: string, query?: Query, signal?: AbortSignal) =>
    request<T>("GET", path, { query, signal }),
  post: <T>(path: string, body?: unknown, signal?: AbortSignal) =>
    request<T>("POST", path, { body, signal }),
  put: <T>(path: string, body?: unknown, signal?: AbortSignal) =>
    request<T>("PUT", path, { body, signal }),
  patch: <T>(path: string, body?: unknown, signal?: AbortSignal) =>
    request<T>("PATCH", path, { body, signal }),
  del: <T>(path: string, signal?: AbortSignal) =>
    request<T>("DELETE", path, { signal }),
  /** Upload a raw body (release/artifact assets) without JSON-encoding. */
  upload: <T>(path: string, rawBody: BodyInit, signal?: AbortSignal) =>
    request<T>("POST", path, { rawBody, signal }),
};

/** A page of a cursor-paginated list under a named resource key. */
export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

/**
 * GET a paginated collection. The server wraps items under `resourceKey`
 * (`repositories`, `issues`, `pulls`, …) with a sibling `nextCursor`.
 */
export async function getPage<T>(
  path: string,
  resourceKey: string,
  params: { limit?: number; cursor?: string | null } = {},
  signal?: AbortSignal,
): Promise<Page<T>> {
  const query: Query = {};
  if (params.limit) query.limit = params.limit;
  if (params.cursor) query.cursor = params.cursor;
  const body = await api.get<Record<string, unknown>>(path, query, signal);
  const items = (body?.[resourceKey] as T[] | undefined) ?? [];
  const nextCursor = (body?.nextCursor as string | null | undefined) ?? null;
  return { items, nextCursor };
}

/** Build a same-origin URL for a streamed download (raw/asset/artifact/logs). */
export function downloadUrl(path: string, query?: Query): string {
  return withQuery(path, query);
}
