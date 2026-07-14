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
  delivered_at: number | null;
  created_at: number;
}

/** Retry ceiling: after this many attempts a failed delivery is terminal. */
export const MAX_DELIVERY_ATTEMPTS = 5;

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

function payloadKey(deliveryId: string): string {
  return `webhooks/v1/deliveries/${deliveryId}.json`;
}

async function readPayload(
  bucket: ObjectStoreBinding,
  key: string,
): Promise<string | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  return new TextDecoder().decode(new Uint8Array(await object.arrayBuffer()));
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
  return sendOne(db, hook, source.event, body, source.attempt + 1, deps);
}

/** Deliver `body` to a single webhook, persisting a fresh delivery row. */
export async function sendOne(
  db: DbClient,
  hook: WebhookRow,
  event: string,
  body: string,
  attempt: number,
  deps: DispatchDeps,
): Promise<DeliveryOutcome> {
  const deliveryId = db.id();
  const now = db.now();

  // Spill the signed body to R2 (best-effort; null key when no bucket).
  let payloadR2Key: string | null = null;
  if (deps.bucket) {
    const key = payloadKey(deliveryId);
    try {
      await deps.bucket.put(key, new TextEncoder().encode(body));
      payloadR2Key = key;
    } catch {
      payloadR2Key = null;
    }
  }

  const headers: Record<string, string> = {
    "content-type": hook.content_type || "application/json",
    [EVENT_HEADER]: event,
    [DELIVERY_HEADER]: deliveryId,
  };
  if (hook.secret_enc && deps.encryptionKey) {
    const secret = await decryptSecret(hook.secret_enc, deps.encryptionKey);
    if (secret) {
      headers[SIGNATURE_HEADER] = `sha256=${await signPayload(body, secret)}`;
    }
  }

  await db.run(
    `INSERT INTO webhook_deliveries
       (id, webhook_id, event, payload_r2_key, request_headers, status, attempt, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [
      deliveryId,
      hook.id,
      event,
      payloadR2Key,
      JSON.stringify(headers),
      attempt,
      now,
    ],
  );

  const fetchImpl = deps.fetchImpl ?? fetch;
  const startedAt = Date.now();
  let status: "success" | "failed" = "failed";
  let responseStatus: number | null = null;
  let error: string | null = null;
  try {
    const response = await fetchImpl(hook.url, {
      method: "POST",
      headers,
      body,
    });
    responseStatus = response.status;
    status = response.status >= 200 && response.status < 300 ? "success" : "failed";
    if (status === "failed") {
      error = `non-2xx response: ${response.status}`;
    }
  } catch (cause) {
    status = "failed";
    error = cause instanceof Error ? cause.message : "delivery failed";
  }
  const responseMs = Date.now() - startedAt;

  await db.run(
    `UPDATE webhook_deliveries
       SET status = ?, response_status = ?, response_ms = ?, error = ?, delivered_at = ?
     WHERE id = ?`,
    [status, responseStatus, responseMs, error, db.now(), deliveryId],
  );

  return { deliveryId, webhookId: hook.id, status, responseStatus };
}
