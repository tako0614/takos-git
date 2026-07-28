/**
 * Webhook metadata service + delivery dispatcher.
 *
 * D1 holds webhook config (`webhooks`) and a delivery ledger
 * (`webhook_deliveries`). The signed request BODY spills to R2 when a bucket is
 * available (`payload_r2_key`) so a delivery can be re-sent without the caller
 * re-supplying the payload; D1 never stores the payload bytes.
 *
 * `dispatchWebhook(db, repoId, event, payload, deps?)` is the single seam the
 * other features' event descriptors wire into. It records one delivery row per
 * subscribed active webhook and performs the HTTP POST best-effort, persisting
 * status/response. It imports NO other feature module.
 */

import type { DbClient } from "../../db/index.ts";
import type { ObjectStoreBinding } from "../../git/types.ts";
import {
  DELIVERY_HEADER,
  EVENT_HEADER,
  SIGNATURE_HEADER,
  decryptSecret,
  signPayload,
} from "./crypto.ts";

// ============================================================================
// Rows + DTOs
// ============================================================================

export interface WebhookRow {
  id: string;
  repo_id: string;
  url: string;
  content_type: string;
  secret_enc: string | null;
  events: string;
  active: number;
  ssl_verify: number;
  created_at: number;
  updated_at: number;
}

export interface DeliveryRow {
  id: string;
  webhook_id: string;
  event: string;
  payload_r2_key: string | null;
  request_headers: string | null;
  status: string;
  attempt: number;
  response_status: number | null;
  response_ms: number | null;
  error: string | null;
  claim_token: string | null;
  payload_sha256: string | null;
  next_attempt_at: number | null;
  lease_until: number | null;
  updated_at: number | null;
  delivered_at: number | null;
  created_at: number;
}

/** Retry ceiling: after this many attempts a failed delivery is terminal. */
export const MAX_DELIVERY_ATTEMPTS = 5;
export const DEFAULT_DELIVERY_TIMEOUT_MS = 10_000;
const DELIVERY_LEASE_MS = 30_000;
const MAX_DUE_DELIVERIES = 25;
const MAX_ERROR_LENGTH = 512;

/**
 * Exponential backoff (ms) before the next attempt of a failed delivery:
 * 30s, 60s, 120s, 240s … capped at 1h. Returns null once the attempt count has
 * reached {@link MAX_DELIVERY_ATTEMPTS} (terminal, no further retry).
 */
export function nextRetryDelayMs(attempt: number): number | null {
  if (attempt >= MAX_DELIVERY_ATTEMPTS) return null;
  const base = 30_000 * 2 ** (attempt - 1);
  return Math.min(base, 3_600_000);
}

export function webhookDto(row: WebhookRow): Record<string, unknown> {
  return {
    id: row.id,
    url: row.url,
    contentType: row.content_type,
    events: parseEvents(row.events),
    active: row.active !== 0,
    sslVerify: row.ssl_verify !== 0,
    // The secret is write-only: never echoed. `hasSecret` lets a UI show state.
    hasSecret: row.secret_enc !== null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function deliveryDto(row: DeliveryRow): Record<string, unknown> {
  const retryDelayMs =
    row.status === "failed" ? nextRetryDelayMs(row.attempt) : null;
  return {
    id: row.id,
    webhookId: row.webhook_id,
    event: row.event,
    status: row.status,
    attempt: row.attempt,
    responseStatus: row.response_status,
    responseMs: row.response_ms,
    error: row.error,
    requestHeaders: parseHeaders(row.request_headers),
    // Derived retry/backoff metadata (schema stores attempt, not a next-run ts).
    retryable: retryDelayMs !== null,
    nextRetryDelayMs: retryDelayMs,
    nextAttemptAt: row.next_attempt_at,
    deliveredAt: row.delivered_at,
    createdAt: row.created_at,
  };
}

function parseEvents(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function parseHeaders(value: string | null): Record<string, string> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

/** True when `webhook` subscribes to `event` (explicit match or `"*"` wildcard). */
export function subscribes(events: readonly string[], event: string): boolean {
  return events.includes("*") || events.includes(event);
}

// ============================================================================
// Payload spill (R2)
// ============================================================================

function payloadKey(repoId: string, deliveryId: string): string {
  return `webhooks/v1/repos/${repoId}/${deliveryId}.json`;
}

async function readPayload(
  bucket: ObjectStoreBinding,
  key: string,
): Promise<string | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  return new TextDecoder().decode(new Uint8Array(await object.arrayBuffer()));
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function payloadSha256(body: string): Promise<string> {
  return toHex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)),
    ),
  );
}

function wireBody(contentType: string, jsonBody: string): string {
  if (contentType === "application/json") return jsonBody;
  if (contentType === "application/x-www-form-urlencoded") {
    return `payload=${encodeURIComponent(jsonBody)}`;
  }
  throw new Error(`unsupported webhook content type: ${contentType}`);
}

// ============================================================================
// Dispatch
// ============================================================================

export interface DispatchDeps {
  /** Key material to decrypt each webhook secret for signing. */
  readonly encryptionKey?: string | null;
  /** R2 bucket to spill the signed body into (enables redelivery). */
  readonly bucket?: ObjectStoreBinding | null;
  /** Injected fetch (tests capture the outbound request here). */
  readonly fetchImpl?: typeof fetch;
  /** Hard timeout for one receiver request. */
  readonly deliveryTimeoutMs?: number;
}

export interface DeliveryOutcome {
  readonly deliveryId: string;
  readonly webhookId: string;
  readonly status: "success" | "failed";
  readonly responseStatus: number | null;
}

/**
 * Fan `event` out to every active webhook of `repoId` that subscribes to it,
 * recording + sending one delivery each. Best-effort: send failures are captured
 * on the delivery row, never thrown. Returns one outcome per attempted delivery.
 */
export async function dispatchWebhook(
  db: DbClient,
  repoId: string,
  event: string,
  payload: unknown,
  deps: DispatchDeps = {},
): Promise<DeliveryOutcome[]> {
  const hooks = await db.query<WebhookRow>(
    `SELECT * FROM webhooks WHERE repo_id = ? AND active = 1`,
    [repoId],
  );
  const body = JSON.stringify({ event, repoId, deliveredAt: db.now(), payload });
  const outcomes: DeliveryOutcome[] = [];
  for (const hook of hooks) {
    if (!subscribes(parseEvents(hook.events), event)) continue;
    outcomes.push(
      await sendOne(db, hook, event, body, 1, deps),
    );
  }
  return outcomes;
}

/**
 * Re-send an existing delivery (ping/redeliver routes). Reuses the spilled body
 * when present; otherwise re-signs `fallbackBody`. Records a NEW delivery row
 * with `attempt` incremented from the source row.
 */
export async function redeliver(
  db: DbClient,
  hook: WebhookRow,
  source: DeliveryRow,
  deps: DispatchDeps,
): Promise<DeliveryOutcome> {
  let body: string | null = null;
  if (source.payload_r2_key && deps.bucket) {
    body = await readPayload(deps.bucket, source.payload_r2_key);
  }
  if (body === null) {
    body = JSON.stringify({
      event: source.event,
      repoId: hook.repo_id,
      deliveredAt: db.now(),
      payload: { redeliveryOf: source.id },
    });
  }
  return sendOne(
    db,
    hook,
    source.event,
    body,
    source.attempt + 1,
    deps,
    source.payload_r2_key !== null,
  );
}

/**
 * Add the HMAC signature header, or return the reason it could not be produced.
 * A non-null return means the delivery must not be sent.
 */
async function applySignature(
  hook: WebhookRow,
  body: string,
  headers: Record<string, string>,
  deps: DispatchDeps,
): Promise<string | null> {
  if (!hook.secret_enc) return "signing_unconfigured: webhook has no secret";
  if (!deps.encryptionKey) {
    return "signing_unconfigured: WEBHOOK_SECRET_KEY (or APP_SESSION_SECRET) is not bound";
  }
  const secret = await decryptSecret(hook.secret_enc, deps.encryptionKey);
  if (!secret) return "signing_unconfigured: stored secret does not decrypt under the current key";
  headers[SIGNATURE_HEADER] = `sha256=${await signPayload(body, secret)}`;
  return null;
}

/**
 * Commit one delivery intent, then make its first leased attempt.
 *
 * `body` is the canonical JSON envelope unless `alreadyEncoded` is true
 * (manual redelivery reuses the exact R2 bytes). The payload is durable before
 * any receiver request; if R2 is unavailable no request is sent.
 */
export async function sendOne(
  db: DbClient,
  hook: WebhookRow,
  event: string,
  body: string,
  attempt: number,
  deps: DispatchDeps,
  alreadyEncoded = false,
): Promise<DeliveryOutcome> {
  const deliveryId = db.id();
  const now = db.now();
  const encodedBody = alreadyEncoded
    ? body
    : wireBody(hook.content_type || "application/json", body);

  // The outbox cannot be replayed without payload bytes. Persist an explicit,
  // terminal failure rather than sending a request whose intent exists only in
  // this isolate's memory.
  let payloadR2Key: string | null = null;
  let payloadDigest: string | null = null;
  let outboxError: string | null = null;
  if (deps.bucket) {
    const key = payloadKey(hook.repo_id, deliveryId);
    try {
      await deps.bucket.put(key, new TextEncoder().encode(encodedBody));
      payloadR2Key = key;
      payloadDigest = await payloadSha256(encodedBody);
    } catch (cause) {
      outboxError =
        cause instanceof Error
          ? `outbox_unavailable: ${cause.message.slice(0, MAX_ERROR_LENGTH)}`
          : "outbox_unavailable";
    }
  } else {
    outboxError = "outbox_unavailable: BUCKET is not bound";
  }

  const headers: Record<string, string> = {
    "content-type": hook.content_type || "application/json",
    [EVENT_HEADER]: event,
    [DELIVERY_HEADER]: deliveryId,
  };

  if (outboxError) {
    await db.run(
      `INSERT INTO webhook_deliveries
         (id, webhook_id, event, payload_r2_key, payload_sha256,
          request_headers, status, attempt, error, next_attempt_at,
          claim_token, lease_until, delivered_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'failed', ?, ?, NULL, NULL, NULL, ?, ?, ?)`,
      [
        deliveryId,
        hook.id,
        event,
        payloadR2Key,
        payloadDigest,
        JSON.stringify(headers),
        MAX_DELIVERY_ATTEMPTS,
        outboxError,
        now,
        now,
        now,
      ],
    );
    return { deliveryId, webhookId: hook.id, status: "failed", responseStatus: null };
  }

  await db.run(
    `INSERT INTO webhook_deliveries
       (id, webhook_id, event, payload_r2_key, payload_sha256,
        request_headers, status, attempt, next_attempt_at,
        claim_token, lease_until, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, ?, ?)`,
    [
      deliveryId,
      hook.id,
      event,
      payloadR2Key,
      payloadDigest,
      JSON.stringify(headers),
      Math.max(0, attempt - 1),
      now,
      now,
      now,
    ],
  );

  return (
    (await deliverExisting(db, deliveryId, deps)) ?? {
      deliveryId,
      webhookId: hook.id,
      status: "failed",
      responseStatus: null,
    }
  );
}

async function finishAttempt(
  db: DbClient,
  row: DeliveryRow,
  result: {
    readonly status: "success" | "failed";
    readonly responseStatus: number | null;
    readonly responseMs: number;
    readonly error: string | null;
    readonly permanent?: boolean;
  },
): Promise<DeliveryOutcome> {
  const now = db.now();
  const delay =
    result.status === "failed" && !result.permanent
      ? nextRetryDelayMs(row.attempt)
      : null;
  await db.run(
    `UPDATE webhook_deliveries
       SET status = ?, response_status = ?, response_ms = ?, error = ?,
           claim_token = NULL, lease_until = NULL, next_attempt_at = ?,
           delivered_at = ?, updated_at = ?
     WHERE id = ?`,
    [
      result.status,
      result.responseStatus,
      result.responseMs,
      result.error,
      delay === null ? null : now + delay,
      now,
      now,
      row.id,
    ],
  );
  return {
    deliveryId: row.id,
    webhookId: row.webhook_id,
    status: result.status,
    responseStatus: result.responseStatus,
  };
}

/**
 * Lease and attempt one existing outbox row. Returns null when another
 * invocation already owns it or it is no longer due.
 */
async function deliverExisting(
  db: DbClient,
  deliveryId: string,
  deps: DispatchDeps,
): Promise<DeliveryOutcome | null> {
  const now = db.now();
  const claimToken = db.id();
  const claimed = await db.run(
    `UPDATE webhook_deliveries
     SET claim_token = ?, lease_until = ?, attempt = attempt + 1, updated_at = ?
     WHERE id = ?
       AND status IN ('pending', 'failed')
       AND attempt < ?
       AND next_attempt_at IS NOT NULL
       AND next_attempt_at <= ?
       AND (claim_token IS NULL OR lease_until IS NULL OR lease_until <= ?)`,
    [
      claimToken,
      now + DELIVERY_LEASE_MS,
      now,
      deliveryId,
      MAX_DELIVERY_ATTEMPTS,
      now,
      now,
    ],
  );
  if (Number(claimed.meta.changes ?? 0) !== 1) return null;

  const row = await db.queryOne<DeliveryRow>(
    `SELECT * FROM webhook_deliveries WHERE id = ? AND claim_token = ? LIMIT 1`,
    [deliveryId, claimToken],
  );
  if (!row) return null;
  const hook = await db.queryOne<WebhookRow>(
    `SELECT * FROM webhooks WHERE id = ? LIMIT 1`,
    [row.webhook_id],
  );
  if (!hook) {
    return finishAttempt(db, row, {
      status: "failed",
      responseStatus: null,
      responseMs: 0,
      error: "webhook no longer exists",
      permanent: true,
    });
  }
  if (!deps.bucket || !row.payload_r2_key || !row.payload_sha256) {
    return finishAttempt(db, row, {
      status: "failed",
      responseStatus: null,
      responseMs: 0,
      error: "outbox payload is unavailable",
      permanent: true,
    });
  }
  const body = await readPayload(deps.bucket, row.payload_r2_key);
  if (body === null || (await payloadSha256(body)) !== row.payload_sha256) {
    return finishAttempt(db, row, {
      status: "failed",
      responseStatus: null,
      responseMs: 0,
      error: "outbox payload is missing or failed its SHA-256 check",
      permanent: true,
    });
  }

  const headers: Record<string, string> = {
    "content-type": hook.content_type || "application/json",
    [EVENT_HEADER]: row.event,
    [DELIVERY_HEADER]: row.id,
  };
  const signingError = await applySignature(hook, body, headers, deps);
  if (signingError) {
    return finishAttempt(db, row, {
      status: "failed",
      responseStatus: null,
      responseMs: 0,
      error: signingError,
    });
  }
  await db.run(
    `UPDATE webhook_deliveries SET request_headers = ?, updated_at = ?
     WHERE id = ? AND claim_token = ?`,
    [JSON.stringify(headers), db.now(), row.id, claimToken],
  );

  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = Math.max(
    1,
    Math.min(deps.deliveryTimeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS, 30_000),
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  let responseStatus: number | null = null;
  let error: string | null = null;
  try {
    const response = await fetchImpl(hook.url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    responseStatus = response.status;
    if (response.status < 200 || response.status >= 300) {
      error = `non-2xx response: ${response.status}`;
    }
  } catch (cause) {
    error = controller.signal.aborted
      ? "delivery timed out"
      : cause instanceof Error
        ? cause.message.slice(0, MAX_ERROR_LENGTH)
        : "delivery failed";
  } finally {
    clearTimeout(timeout);
  }
  return finishAttempt(db, row, {
    status: error === null ? "success" : "failed",
    responseStatus,
    responseMs: Date.now() - startedAt,
    error,
  });
}

/**
 * Drain a bounded batch of due deliveries. A scheduled invocation and ordinary
 * request scopes both call this; the lease makes concurrent drains safe.
 */
export async function processDueWebhookDeliveries(
  db: DbClient,
  deps: DispatchDeps,
  limit = MAX_DUE_DELIVERIES,
): Promise<DeliveryOutcome[]> {
  const boundedLimit = Math.max(1, Math.min(limit, MAX_DUE_DELIVERIES));
  const due = await db.query<{ id: string }>(
    `SELECT id
     FROM webhook_deliveries
     WHERE status IN ('pending', 'failed')
       AND attempt < ?
       AND next_attempt_at IS NOT NULL
       AND next_attempt_at <= ?
       AND (claim_token IS NULL OR lease_until IS NULL OR lease_until <= ?)
     ORDER BY next_attempt_at ASC, created_at ASC
     LIMIT ?`,
    [
      MAX_DELIVERY_ATTEMPTS,
      db.now(),
      db.now(),
      boundedLimit,
    ],
  );
  const outcomes: DeliveryOutcome[] = [];
  for (const row of due) {
    const outcome = await deliverExisting(db, row.id, deps);
    if (outcome) outcomes.push(outcome);
  }
  return outcomes;
}
