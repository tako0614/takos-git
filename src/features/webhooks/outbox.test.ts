import { describe, expect, test } from "bun:test";

import { seedFullRepo, seedPrincipal, makeEnv } from "../repos/testkit.ts";
import { encryptSecret, SIGNATURE_HEADER, signPayload } from "./crypto.ts";
import { createGitWorker } from "../../worker.ts";
import { strictExecutionContext } from "../../lifecycle-testkit.ts";
import {
  dispatchWebhook,
  processDueWebhookDeliveries,
  type WebhookRow,
} from "./service.ts";

const KEY = "test-webhook-encryption-key";

async function setup(contentType = "application/json") {
  const handle = makeEnv();
  (handle.env as unknown as Record<string, unknown>).WEBHOOK_SECRET_KEY = KEY;
  const principalId = await seedPrincipal(handle.db, "sub-alice");
  const repo = await seedFullRepo(handle, {
    ownerLogin: "alice",
    ownerType: "user",
    ownerPrincipalId: principalId,
    name: "web",
    visibility: "private",
  });
  const hookId = handle.db.id();
  const now = handle.db.now();
  await handle.db.run(
    `INSERT INTO webhooks
       (id, repo_id, url, content_type, secret_enc, events, active, ssl_verify, created_at, updated_at)
     VALUES (?, ?, 'https://hook.example/events', ?, ?, '["push"]', 1, 1, ?, ?)`,
    [hookId, repo.repoId, contentType, await encryptSecret("s3cr3t", KEY), now, now],
  );
  const hook = await handle.db.queryOne<WebhookRow>(
    `SELECT * FROM webhooks WHERE id = ?`,
    [hookId],
  );
  return { ...handle, repo, hook: hook! };
}

describe("durable webhook outbox", () => {
  test("a failed delivery is retried from R2 with the same delivery identity", async () => {
    const handle = await setup();
    const bodies: string[] = [];
    const first = await dispatchWebhook(
      handle.db,
      handle.repo.repoId,
      "push",
      { ref: "refs/heads/main" },
      {
        encryptionKey: KEY,
        bucket: handle.bucket,
        fetchImpl: (async (_input, init) => {
          bodies.push(String(init?.body));
          return new Response("retry", { status: 503 });
        }) as typeof fetch,
      },
    );
    expect(first).toHaveLength(1);
    expect(first[0].status).toBe("failed");

    await handle.db.run(
      `UPDATE webhook_deliveries SET next_attempt_at = 0 WHERE id = ?`,
      [first[0].deliveryId],
    );
    const retried = await processDueWebhookDeliveries(handle.db, {
      encryptionKey: KEY,
      bucket: handle.bucket,
      fetchImpl: (async (_input, init) => {
        bodies.push(String(init?.body));
        return new Response("ok", { status: 204 });
      }) as typeof fetch,
    });

    expect(retried).toEqual([
      {
        deliveryId: first[0].deliveryId,
        webhookId: handle.hook.id,
        status: "success",
        responseStatus: 204,
      },
    ]);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
    const row = await handle.db.queryOne<{
      status: string;
      attempt: number;
      claim_token: string | null;
      next_attempt_at: number | null;
    }>(`SELECT status, attempt, claim_token, next_attempt_at FROM webhook_deliveries WHERE id = ?`, [
      first[0].deliveryId,
    ]);
    expect(row).toEqual({
      status: "success",
      attempt: 2,
      claim_token: null,
      next_attempt_at: null,
    });
  });

  test("concurrent drains claim a due delivery only once", async () => {
    const handle = await setup();
    const first = await dispatchWebhook(
      handle.db,
      handle.repo.repoId,
      "push",
      {},
      {
        encryptionKey: KEY,
        bucket: handle.bucket,
        fetchImpl: (async () => new Response("retry", { status: 503 })) as typeof fetch,
      },
    );
    await handle.db.run(
      `UPDATE webhook_deliveries SET next_attempt_at = 0 WHERE id = ?`,
      [first[0].deliveryId],
    );
    let sends = 0;
    const deps = {
      encryptionKey: KEY,
      bucket: handle.bucket,
      fetchImpl: (async () => {
        sends += 1;
        await Bun.sleep(5);
        return new Response("ok");
      }) as typeof fetch,
    };
    await Promise.all([
      processDueWebhookDeliveries(handle.db, deps),
      processDueWebhookDeliveries(handle.db, deps),
    ]);
    expect(sends).toBe(1);
  });

  test("form webhooks encode payload consistently before signing", async () => {
    const handle = await setup("application/x-www-form-urlencoded");
    let sentBody = "";
    let sentHeaders = new Headers();
    const result = await dispatchWebhook(
      handle.db,
      handle.repo.repoId,
      "push",
      { ref: "main" },
      {
        encryptionKey: KEY,
        bucket: handle.bucket,
        fetchImpl: (async (_input, init) => {
          sentBody = String(init?.body);
          sentHeaders = new Headers(init?.headers);
          return new Response("ok");
        }) as typeof fetch,
      },
    );
    expect(result[0].status).toBe("success");
    expect(sentHeaders.get("content-type")).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(sentBody.startsWith("payload=")).toBe(true);
    const decoded = JSON.parse(
      decodeURIComponent(sentBody.slice("payload=".length)),
    );
    expect(decoded).toMatchObject({
      event: "push",
      repoId: handle.repo.repoId,
      payload: { ref: "main" },
    });
    expect(sentHeaders.get(SIGNATURE_HEADER)).toBe(
      `sha256=${await signPayload(sentBody, "s3cr3t")}`,
    );
  });

  test("a stalled receiver is aborted at the configured timeout", async () => {
    const handle = await setup();
    const started = performance.now();
    const result = await dispatchWebhook(
      handle.db,
      handle.repo.repoId,
      "push",
      {},
      {
        encryptionKey: KEY,
        bucket: handle.bucket,
        deliveryTimeoutMs: 10,
        fetchImpl: (async (_input, init) => {
          await new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(init.signal?.reason),
              { once: true },
            );
          });
          return new Response("unreachable");
        }) as typeof fetch,
      },
    );
    expect(performance.now() - started).toBeLessThan(500);
    expect(result[0].status).toBe("failed");
    const row = await handle.db.queryOne<{ error: string }>(
      `SELECT error FROM webhook_deliveries WHERE id = ?`,
      [result[0].deliveryId],
    );
    expect(row?.error).toBe("delivery timed out");
  });

  test("the scheduled listener owns a bounded drain through waitUntil", async () => {
    const handle = await setup();
    const first = await dispatchWebhook(
      handle.db,
      handle.repo.repoId,
      "push",
      {},
      {
        encryptionKey: KEY,
        bucket: handle.bucket,
        fetchImpl: (async () => new Response("retry", { status: 503 })) as typeof fetch,
      },
    );
    await handle.db.run(
      `UPDATE webhook_deliveries SET next_attempt_at = 0 WHERE id = ?`,
      [first[0].deliveryId],
    );

    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("ok")) as typeof fetch;
    try {
      const ctx = strictExecutionContext();
      await createGitWorker().scheduled(
        { scheduledTime: Date.now(), cron: "* * * * *" },
        handle.env,
        ctx,
      );
      expect(ctx.registered).toBe(1);
      ctx.endInvocation();
      await ctx.drain();
    } finally {
      globalThis.fetch = previousFetch;
    }
    const row = await handle.db.queryOne<{ status: string; attempt: number }>(
      `SELECT status, attempt FROM webhook_deliveries WHERE id = ?`,
      [first[0].deliveryId],
    );
    expect(row).toEqual({ status: "success", attempt: 2 });
  });
});
