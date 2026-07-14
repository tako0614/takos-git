import { describe, expect, test } from "bun:test";

import { RouteRegistry, type RouterEnv } from "../../router.ts";
import { registerWebhookRoutes } from "./routes.ts";
import type { OAuthFetch } from "../../browser-auth.ts";
import {
  get,
  interfaceUserInfoFetch,
  jsonRequest,
  makeEnv,
  type TestEnvHandle,
} from "../repos/testkit.ts";
import { registerRepoRoutes } from "../repos/routes.ts";
import {
  MAX_DELIVERY_ATTEMPTS,
  dispatchWebhook,
  nextRetryDelayMs,
  subscribes,
} from "./service.ts";
import {
  SIGNATURE_HEADER,
  decryptSecret,
  encryptSecret,
  signPayload,
} from "./crypto.ts";

const KEY = "test-webhook-encryption-key";

const tokens = interfaceUserInfoFetch({
  taksrv_alice_a: { scope: "source.git.hosting.admin", subject: "sub-alice" },
  taksrv_alice_w: { scope: "source.git.hosting.write", subject: "sub-alice" },
  taksrv_carol_a: { scope: "source.git.hosting.admin", subject: "sub-carol" },
  taksrv_dave_w: { scope: "source.git.hosting.write", subject: "sub-dave" },
  taksrv_dave_a: { scope: "source.git.hosting.admin", subject: "sub-dave" },
});

function envWithKey(): TestEnvHandle {
  const handle = makeEnv();
  (handle.env as unknown as Record<string, unknown>).WEBHOOK_SECRET_KEY = KEY;
  return handle;
}

function router(): RouteRegistry {
  const reg = new RouteRegistry();
  registerRepoRoutes(reg);
  registerWebhookRoutes(reg);
  return reg;
}

async function dispatch(
  reg: RouteRegistry,
  request: Request,
  env: RouterEnv,
  fetchMock: OAuthFetch = tokens,
): Promise<Response> {
  const res = await reg.handle({ request, env, interfaceUserInfoFetch: fetchMock });
  if (!res) throw new Error("route was not handled");
  return res;
}

/** Create a private alice/web owned by sub-alice, plus a webhook; returns its id. */
async function seedRepoAndHook(
  handle: TestEnvHandle,
  reg: RouteRegistry,
  body: Record<string, unknown> = {
    url: "https://hook.example/receive",
    events: ["push", "issues"],
    secret: "s3cr3t",
  },
): Promise<string> {
  await dispatch(
    reg,
    jsonRequest("POST", "/api/v1/repos", { owner: "alice", name: "web", visibility: "private" }, "taksrv_alice_w"),
    handle.env,
  );
  const created = await dispatch(
    reg,
    jsonRequest("POST", "/api/v1/repos/alice/web/webhooks", body, "taksrv_alice_a"),
    handle.env,
  );
  expect(created.status).toBe(201);
  const json = (await created.json()) as { webhook: { id: string } };
  return json.webhook.id;
}

describe("webhook secret crypto", () => {
  test("encrypt/decrypt round-trips and never leaks plaintext", async () => {
    const sealed = await encryptSecret("hunter2", KEY);
    expect(sealed).not.toContain("hunter2");
    expect(await decryptSecret(sealed, KEY)).toBe("hunter2");
    // wrong key fails closed.
    expect(await decryptSecret(sealed, "other")).toBeNull();
    // tampered ciphertext fails closed.
    expect(await decryptSecret(`${sealed}x`, KEY)).toBeNull();
  });

  test("signPayload is a stable HMAC-SHA256 hex", async () => {
    const a = await signPayload("body", "secret");
    const b = await signPayload("body", "secret");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/u);
    expect(await signPayload("body", "other")).not.toBe(a);
  });
});

describe("backoff metadata", () => {
  test("exponential with cap, terminal after MAX_DELIVERY_ATTEMPTS", () => {
    expect(nextRetryDelayMs(1)).toBe(30_000);
    expect(nextRetryDelayMs(2)).toBe(60_000);
    expect(nextRetryDelayMs(3)).toBe(120_000);
    expect(nextRetryDelayMs(MAX_DELIVERY_ATTEMPTS)).toBeNull();
  });
  test("subscribes matches explicit + wildcard", () => {
    expect(subscribes(["push"], "push")).toBe(true);
    expect(subscribes(["push"], "issues")).toBe(false);
    expect(subscribes(["*"], "anything")).toBe(true);
  });
});

describe("dispatchWebhook fan-out", () => {
  test("delivers to subscribed active hooks with a signature; records success", async () => {
    const handle = envWithKey();
    const reg = router();
    const hookId = await seedRepoAndHook(handle, reg);
    // resolve repo id
    const repoRow = await handle.db.queryOne<{ id: string }>(
      `SELECT id FROM repositories WHERE storage_key = 'alice/web'`,
    );
    const repoId = repoRow!.id;

    const seen: Array<{ url: string; headers: Headers; body: string }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: String(init?.body),
      });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const outcomes = await dispatchWebhook(handle.db, repoId, "push", { ref: "main" }, {
      encryptionKey: KEY,
      bucket: handle.bucket,
      fetchImpl,
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ status: "success", responseStatus: 200, webhookId: hookId });
    expect(seen).toHaveLength(1);
    // signed with the stored secret
    const sig = seen[0].headers.get(SIGNATURE_HEADER)!;
    expect(sig.startsWith("sha256=")).toBe(true);
    expect(sig.slice(7)).toBe(await signPayload(seen[0].body, "s3cr3t"));

    // delivery row persisted as success + payload spilled to R2
    const row = await handle.db.queryOne<{ status: string; payload_r2_key: string | null }>(
      `SELECT status, payload_r2_key FROM webhook_deliveries WHERE id = ?`,
      [outcomes[0].deliveryId],
    );
    expect(row!.status).toBe("success");
    expect(row!.payload_r2_key).not.toBeNull();
    expect(handle.bucket.store.has(row!.payload_r2_key!)).toBe(true);
  });

  test("skips unsubscribed events and inactive hooks", async () => {
    const handle = envWithKey();
    const reg = router();
    await seedRepoAndHook(handle, reg, { url: "https://a.example", events: ["issues"] });
    const repoRow = await handle.db.queryOne<{ id: string }>(
      `SELECT id FROM repositories WHERE storage_key = 'alice/web'`,
    );
    const fetchImpl = (async () => new Response("ok")) as unknown as typeof fetch;
    const outcomes = await dispatchWebhook(handle.db, repoRow!.id, "push", {}, { fetchImpl });
    expect(outcomes).toHaveLength(0);
  });

  test("captures a failed send without throwing", async () => {
    const handle = envWithKey();
    const reg = router();
    await seedRepoAndHook(handle, reg, { url: "https://a.example", events: ["push"] });
    const repoRow = await handle.db.queryOne<{ id: string }>(
      `SELECT id FROM repositories WHERE storage_key = 'alice/web'`,
    );
    const fetchImpl = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    const outcomes = await dispatchWebhook(handle.db, repoRow!.id, "push", {}, { fetchImpl });
    expect(outcomes[0].status).toBe("failed");
    const row = await handle.db.queryOne<{ status: string; error: string }>(
      `SELECT status, error FROM webhook_deliveries WHERE id = ?`,
      [outcomes[0].deliveryId],
    );
    expect(row!.status).toBe("failed");
    expect(row!.error).toContain("connection refused");
  });
});

describe("webhook CRUD routes", () => {
  test("owner creates, lists, gets, patches, and deletes; secret never echoed", async () => {
    const handle = envWithKey();
    const reg = router();
    const hookId = await seedRepoAndHook(handle, reg);

    const list = await dispatch(reg, get("/api/v1/repos/alice/web/webhooks", "taksrv_alice_a"), handle.env);
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { webhooks: Array<Record<string, unknown>> };
    expect(listed.webhooks).toHaveLength(1);
    expect(listed.webhooks[0]).toMatchObject({ id: hookId, hasSecret: true, active: true });
    expect(JSON.stringify(listed.webhooks[0])).not.toContain("s3cr3t");
    expect(listed.webhooks[0]).not.toHaveProperty("secret");
    expect(listed.webhooks[0]).not.toHaveProperty("secretEnc");

    const got = await dispatch(reg, get(`/api/v1/repos/alice/web/webhooks/${hookId}`, "taksrv_alice_a"), handle.env);
    expect(got.status).toBe(200);

    const patched = await dispatch(
      reg,
      jsonRequest("PATCH", `/api/v1/repos/alice/web/webhooks/${hookId}`, { active: false, events: ["*"] }, "taksrv_alice_a"),
      handle.env,
    );
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ webhook: { active: false, events: ["*"] } });

    const removed = await dispatch(
      reg,
      jsonRequest("DELETE", `/api/v1/repos/alice/web/webhooks/${hookId}`, undefined, "taksrv_alice_a"),
      handle.env,
    );
    expect(removed.status).toBe(200);
    const after = await dispatch(reg, get("/api/v1/repos/alice/web/webhooks", "taksrv_alice_a"), handle.env);
    expect((await after.json()) as { webhooks: unknown[] }).toMatchObject({ webhooks: [] });
  });

  test("rejects a bad url and unknown events", async () => {
    const handle = envWithKey();
    const reg = router();
    await dispatch(
      reg,
      jsonRequest("POST", "/api/v1/repos", { owner: "alice", name: "web", visibility: "private" }, "taksrv_alice_w"),
      handle.env,
    );
    const badUrl = await dispatch(
      reg,
      jsonRequest("POST", "/api/v1/repos/alice/web/webhooks", { url: "ftp://x", events: ["push"] }, "taksrv_alice_a"),
      handle.env,
    );
    expect(badUrl.status).toBe(400);
    const badEvent = await dispatch(
      reg,
      jsonRequest("POST", "/api/v1/repos/alice/web/webhooks", { url: "https://x.example", events: ["not_a_real_event"] }, "taksrv_alice_a"),
      handle.env,
    );
    expect(badEvent.status).toBe(400);
  });

  test("storing a secret without an encryption key fails closed (503)", async () => {
    const handle = makeEnv(); // no WEBHOOK_SECRET_KEY / APP_SESSION_SECRET
    const reg = router();
    await dispatch(
      reg,
      jsonRequest("POST", "/api/v1/repos", { owner: "alice", name: "web", visibility: "private" }, "taksrv_alice_w"),
      handle.env,
    );
    const res = await dispatch(
      reg,
      jsonRequest("POST", "/api/v1/repos/alice/web/webhooks", { url: "https://x.example", events: ["push"], secret: "s" }, "taksrv_alice_a"),
      handle.env,
    );
    expect(res.status).toBe(503);
  });
});

describe("webhook route authorization", () => {
  test("anonymous is unauthenticated on the admin surface", async () => {
    const handle = envWithKey();
    const reg = router();
    await seedRepoAndHook(handle, reg);
    const res = await dispatch(reg, get("/api/v1/repos/alice/web/webhooks"), handle.env);
    expect(res.status).toBe(401);
  });

  test("a non-member cannot see a private repo's hooks (404 non-disclosure)", async () => {
    const handle = envWithKey();
    const reg = router();
    await seedRepoAndHook(handle, reg);
    const res = await dispatch(reg, get("/api/v1/repos/alice/web/webhooks", "taksrv_carol_a"), handle.env);
    expect(res.status).toBe(404);
  });

  test("a writer lacks the admin floor (403 on a public repo)", async () => {
    const handle = envWithKey();
    const reg = router();
    // Public repo so an insufficient-role denial surfaces as 403 (a private repo
    // would hide it behind 404 non-disclosure).
    await dispatch(
      reg,
      jsonRequest("POST", "/api/v1/repos", { owner: "alice", name: "pub", visibility: "public" }, "taksrv_alice_w"),
      handle.env,
    );
    await dispatch(
      reg,
      jsonRequest("PUT", "/api/v1/repos/alice/pub/collaborators/sub-dave", { role: "writer" }, "taksrv_alice_a"),
      handle.env,
    );
    // dave presents an admin-scoped credential (so the scope ceiling passes) but
    // holds only a writer grant → blocked at the repo.admin role floor.
    const res = await dispatch(reg, get("/api/v1/repos/alice/pub/webhooks", "taksrv_dave_a"), handle.env);
    expect(res.status).toBe(403);
  });
});

describe("deliveries + ping + redeliver routes", () => {
  test("ping records a delivery, list/get surface it, redeliver bumps attempt", async () => {
    const handle = envWithKey();
    const reg = router();
    const hookId = await seedRepoAndHook(handle, reg, {
      url: "https://hook.example/receive",
      events: ["*"],
      secret: "s3cr3t",
    });

    const originalFetch = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const ping = await dispatch(
        reg,
        jsonRequest("POST", `/api/v1/repos/alice/web/webhooks/${hookId}/pings`, undefined, "taksrv_alice_a"),
        handle.env,
      );
      expect(ping.status).toBe(201);
      const pinged = (await ping.json()) as { delivery: { id: string; event: string; status: string; attempt: number } };
      expect(pinged.delivery).toMatchObject({ event: "ping", status: "success", attempt: 1 });

      const list = await dispatch(
        reg,
        get(`/api/v1/repos/alice/web/webhooks/${hookId}/deliveries`, "taksrv_alice_a"),
        handle.env,
      );
      const listed = (await list.json()) as { deliveries: Array<{ id: string }> };
      expect(listed.deliveries).toHaveLength(1);

      const getOne = await dispatch(
        reg,
        get(`/api/v1/repos/alice/web/webhooks/${hookId}/deliveries/${pinged.delivery.id}`, "taksrv_alice_a"),
        handle.env,
      );
      expect(getOne.status).toBe(200);

      const redeliver = await dispatch(
        reg,
        jsonRequest(
          "POST",
          `/api/v1/repos/alice/web/webhooks/${hookId}/deliveries/${pinged.delivery.id}/redeliveries`,
          undefined,
          "taksrv_alice_a",
        ),
        handle.env,
      );
      expect(redeliver.status).toBe(201);
      expect(await redeliver.json()).toMatchObject({ delivery: { attempt: 2, status: "success" } });
      expect(seen).toHaveLength(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
