/**
 * Webhook administration routes (`webhooks` + `webhook_deliveries`).
 *
 * All webhook management is admin-level: every route authorizes via
 * `requireRepoAccess(ctx, "repo.admin", hostingAdmin)` (repo.admin floor =
 * maintainer, per the port map's "manage = maintainer+"). Delivery is internal
 * and carries no external auth — it is reached only through the exported
 * `dispatchWebhook` seam (wired by the integrator) or the ping/redeliver admin
 * routes here.
 *
 * Registered `auth:"public"` and gated inside the handler, mirroring the repos
 * feature so one path serves anonymous/browser/interface callers; browser
 * mutations pass `csrfGuard`.
 */

import { SCOPES } from "../../contract/v1.ts";
import type { Route, RouteContext, RouteRegistry } from "../../router.ts";
import { csrfGuard, requireRepoAccess } from "../repos/identity.ts";
import { errorResponse, json } from "../repos/http.ts";
import {
  webhookEncryptionKey,
  encryptSecret,
} from "./crypto.ts";
import {
  type DeliveryRow,
  type DispatchDeps,
  type WebhookRow,
  deliveryDto,
  redeliver,
  sendOne,
  webhookDto,
} from "./service.ts";

const MAX_BODY_BYTES = 32 * 1024;
const KNOWN_EVENTS = new Set([
  "*",
  "push",
  "issues",
  "issue_comment",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "release",
  "fork",
  "check_run",
  "status",
  "ping",
]);

async function readJson(
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

function validUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Normalize an `events` input to a de-duped list of KNOWN event names. */
function normalizeEvents(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || !KNOWN_EVENTS.has(entry)) return null;
    out.add(entry);
  }
  return out.size > 0 ? [...out] : null;
}

function dispatchDeps(ctx: RouteContext): DispatchDeps {
  return {
    encryptionKey: webhookEncryptionKey(ctx.env),
    bucket: ctx.env.BUCKET,
  };
}

async function loadHook(
  ctx: RouteContext,
  repoId: string,
): Promise<WebhookRow | null> {
  return ctx.db!.queryOne<WebhookRow>(
    `SELECT * FROM webhooks WHERE id = ? AND repo_id = ? LIMIT 1`,
    [ctx.params.hook, repoId],
  );
}

// ============================================================================
// CRUD
// ============================================================================

const listWebhooks: Route["handler"] = async (ctx) => {
  const access = await requireRepoAccess(ctx, "repo.admin", SCOPES.hostingAdmin);
  if (access instanceof Response) return access;
  const rows = await ctx.db!.query<WebhookRow>(
    `SELECT * FROM webhooks WHERE repo_id = ? ORDER BY created_at DESC`,
    [access.repo.id],
  );
  return json({ webhooks: rows.map(webhookDto) });
};

const getWebhook: Route["handler"] = async (ctx) => {
  const access = await requireRepoAccess(ctx, "repo.admin", SCOPES.hostingAdmin);
  if (access instanceof Response) return access;
  const row = await loadHook(ctx, access.repo.id);
  if (!row) return errorResponse(404, "not_found", "Webhook not found.");
  return json({ webhook: webhookDto(row) });
};

const createWebhook: Route["handler"] = async (ctx) => {
  const access = await requireRepoAccess(ctx, "repo.admin", SCOPES.hostingAdmin);
  if (access instanceof Response) return access;
  const csrf = csrfGuard(ctx, access.auth);
  if (csrf) return csrf;
  const body = await readJson(ctx.request);
  if (!body) return errorResponse(400, "invalid_body", "Invalid request body.");
  if (!validUrl(body.url)) {
    return errorResponse(400, "invalid_url", "url must be an http(s) URL.");
  }
  const events = normalizeEvents(body.events);
  if (!events) {
    return errorResponse(400, "invalid_events", "events must be a non-empty array of known event names.");
  }
  const contentType =
    typeof body.contentType === "string" &&
    (body.contentType === "application/json" ||
      body.contentType === "application/x-www-form-urlencoded")
      ? body.contentType
      : "application/json";

  let secretEnc: string | null = null;
  if (typeof body.secret === "string" && body.secret.length > 0) {
    const key = webhookEncryptionKey(ctx.env);
    if (!key) {
      return errorResponse(
        503,
        "secret_encryption_unconfigured",
        "A webhook secret cannot be stored because encryption is not configured.",
      );
    }
    if (body.secret.length > 1024) {
      return errorResponse(400, "invalid_secret", "secret is too long.");
    }
    secretEnc = await encryptSecret(body.secret, key);
  }

  const id = ctx.db!.id();
  const now = ctx.db!.now();
  await ctx.db!.run(
    `INSERT INTO webhooks
       (id, repo_id, url, content_type, secret_enc, events, active, ssl_verify, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      access.repo.id,
      body.url,
      contentType,
      secretEnc,
      JSON.stringify(events),
      body.active === false ? 0 : 1,
      body.sslVerify === false ? 0 : 1,
      now,
      now,
    ],
  );
  const row = await ctx.db!.queryOne<WebhookRow>(
    `SELECT * FROM webhooks WHERE id = ? LIMIT 1`,
    [id],
  );
  return json({ webhook: row ? webhookDto(row) : null }, 201);
};

const patchWebhook: Route["handler"] = async (ctx) => {
  const access = await requireRepoAccess(ctx, "repo.admin", SCOPES.hostingAdmin);
  if (access instanceof Response) return access;
  const csrf = csrfGuard(ctx, access.auth);
  if (csrf) return csrf;
  const existing = await loadHook(ctx, access.repo.id);
  if (!existing) return errorResponse(404, "not_found", "Webhook not found.");
  const body = await readJson(ctx.request);
  if (!body) return errorResponse(400, "invalid_body", "Invalid request body.");

  const sets: string[] = [];
  const params: unknown[] = [];
  if (body.url !== undefined) {
    if (!validUrl(body.url)) {
      return errorResponse(400, "invalid_url", "url must be an http(s) URL.");
    }
    sets.push("url = ?");
    params.push(body.url);
  }
  if (body.events !== undefined) {
    const events = normalizeEvents(body.events);
    if (!events) {
      return errorResponse(400, "invalid_events", "events must be a non-empty array of known event names.");
    }
    sets.push("events = ?");
    params.push(JSON.stringify(events));
  }
  if (body.active !== undefined) {
    sets.push("active = ?");
    params.push(body.active === false ? 0 : 1);
  }
  if (body.sslVerify !== undefined) {
    sets.push("ssl_verify = ?");
    params.push(body.sslVerify === false ? 0 : 1);
  }
  if (body.contentType !== undefined) {
    if (
      body.contentType !== "application/json" &&
      body.contentType !== "application/x-www-form-urlencoded"
    ) {
      return errorResponse(400, "invalid_content_type", "Unsupported content type.");
    }
    sets.push("content_type = ?");
    params.push(body.contentType);
  }
  if (body.secret !== undefined) {
    if (body.secret === null || body.secret === "") {
      sets.push("secret_enc = ?");
      params.push(null);
    } else if (typeof body.secret === "string" && body.secret.length <= 1024) {
      const key = webhookEncryptionKey(ctx.env);
      if (!key) {
        return errorResponse(
          503,
          "secret_encryption_unconfigured",
          "A webhook secret cannot be stored because encryption is not configured.",
        );
      }
      sets.push("secret_enc = ?");
      params.push(await encryptSecret(body.secret, key));
    } else {
      return errorResponse(400, "invalid_secret", "Invalid secret.");
    }
  }
  if (sets.length === 0) {
    return json({ webhook: webhookDto(existing) });
  }
  sets.push("updated_at = ?");
  params.push(ctx.db!.now());
  params.push(existing.id, access.repo.id);
  await ctx.db!.run(
    `UPDATE webhooks SET ${sets.join(", ")} WHERE id = ? AND repo_id = ?`,
    params,
  );
  const row = await ctx.db!.queryOne<WebhookRow>(
    `SELECT * FROM webhooks WHERE id = ? LIMIT 1`,
    [existing.id],
  );
  return json({ webhook: row ? webhookDto(row) : null });
};

const deleteWebhook: Route["handler"] = async (ctx) => {
  const access = await requireRepoAccess(ctx, "repo.admin", SCOPES.hostingAdmin);
  if (access instanceof Response) return access;
  const csrf = csrfGuard(ctx, access.auth);
  if (csrf) return csrf;
  const existing = await loadHook(ctx, access.repo.id);
  if (!existing) return errorResponse(404, "not_found", "Webhook not found.");
  await ctx.db!.run(`DELETE FROM webhooks WHERE id = ? AND repo_id = ?`, [
    existing.id,
    access.repo.id,
  ]);
  return json({ removed: true });
};

// ============================================================================
// Deliveries
// ============================================================================

const listDeliveries: Route["handler"] = async (ctx) => {
  const access = await requireRepoAccess(ctx, "repo.admin", SCOPES.hostingAdmin);
  if (access instanceof Response) return access;
  const hook = await loadHook(ctx, access.repo.id);
  if (!hook) return errorResponse(404, "not_found", "Webhook not found.");
  const rows = await ctx.db!.query<DeliveryRow>(
    `SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT 100`,
    [hook.id],
  );
  return json({ deliveries: rows.map(deliveryDto) });
};

async function loadDelivery(
  ctx: RouteContext,
  hook: WebhookRow,
): Promise<DeliveryRow | null> {
  return ctx.db!.queryOne<DeliveryRow>(
    `SELECT * FROM webhook_deliveries WHERE id = ? AND webhook_id = ? LIMIT 1`,
    [ctx.params.delivery, hook.id],
  );
}

const getDelivery: Route["handler"] = async (ctx) => {
  const access = await requireRepoAccess(ctx, "repo.admin", SCOPES.hostingAdmin);
  if (access instanceof Response) return access;
  const hook = await loadHook(ctx, access.repo.id);
  if (!hook) return errorResponse(404, "not_found", "Webhook not found.");
  const row = await loadDelivery(ctx, hook);
  if (!row) return errorResponse(404, "not_found", "Delivery not found.");
  return json({ delivery: deliveryDto(row) });
};

const pingWebhook: Route["handler"] = async (ctx) => {
  const access = await requireRepoAccess(ctx, "repo.admin", SCOPES.hostingAdmin);
  if (access instanceof Response) return access;
  const csrf = csrfGuard(ctx, access.auth);
  if (csrf) return csrf;
  const hook = await loadHook(ctx, access.repo.id);
  if (!hook) return errorResponse(404, "not_found", "Webhook not found.");
  const body = JSON.stringify({
    event: "ping",
    repoId: access.repo.id,
    deliveredAt: ctx.db!.now(),
    payload: { hookId: hook.id, zen: "Deliver every event, exactly once, verifiably." },
  });
  const outcome = await sendOne(
    ctx.db!,
    hook,
    "ping",
    body,
    1,
    dispatchDeps(ctx),
  );
  const row = await ctx.db!.queryOne<DeliveryRow>(
    `SELECT * FROM webhook_deliveries WHERE id = ? LIMIT 1`,
    [outcome.deliveryId],
  );
  return json({ delivery: row ? deliveryDto(row) : null }, 201);
};

const redeliverDelivery: Route["handler"] = async (ctx) => {
  const access = await requireRepoAccess(ctx, "repo.admin", SCOPES.hostingAdmin);
  if (access instanceof Response) return access;
  const csrf = csrfGuard(ctx, access.auth);
  if (csrf) return csrf;
  const hook = await loadHook(ctx, access.repo.id);
  if (!hook) return errorResponse(404, "not_found", "Webhook not found.");
  const source = await loadDelivery(ctx, hook);
  if (!source) return errorResponse(404, "not_found", "Delivery not found.");
  const outcome = await redeliver(ctx.db!, hook, source, dispatchDeps(ctx));
  const row = await ctx.db!.queryOne<DeliveryRow>(
    `SELECT * FROM webhook_deliveries WHERE id = ? LIMIT 1`,
    [outcome.deliveryId],
  );
  return json({ delivery: row ? deliveryDto(row) : null }, 201);
};

// ============================================================================
// Registration
// ============================================================================

const RR = "/api/v1/repos/:owner/:repo";

const webhookRoutes: readonly Route[] = [
  { method: "GET", path: `${RR}/webhooks`, auth: "public", handler: listWebhooks },
  { method: "POST", path: `${RR}/webhooks`, auth: "public", handler: createWebhook },
  { method: "GET", path: `${RR}/webhooks/:hook`, auth: "public", handler: getWebhook },
  { method: "PATCH", path: `${RR}/webhooks/:hook`, auth: "public", handler: patchWebhook },
  { method: "DELETE", path: `${RR}/webhooks/:hook`, auth: "public", handler: deleteWebhook },
  { method: "GET", path: `${RR}/webhooks/:hook/deliveries`, auth: "public", handler: listDeliveries },
  { method: "GET", path: `${RR}/webhooks/:hook/deliveries/:delivery`, auth: "public", handler: getDelivery },
  { method: "POST", path: `${RR}/webhooks/:hook/pings`, auth: "public", handler: pingWebhook },
  { method: "POST", path: `${RR}/webhooks/:hook/deliveries/:delivery/redeliveries`, auth: "public", handler: redeliverDelivery },
];

const registered = new WeakSet<object>();

/** Register every webhooks-feature route into `registry`. Idempotent per registry. */
export function registerWebhookRoutes(registry: RouteRegistry): void {
  if (registered.has(registry)) return;
  registered.add(registry);
  registry.registerAll(webhookRoutes);
}

export { webhookRoutes };
