import { describe, expect, test } from "bun:test";

import { RouteRegistry, type RouterEnv } from "../../router.ts";
import { repoExists } from "../../git/refs-store.ts";
import { repositoryQuarantineKey } from "../../git/repository-deletion.ts";
import type { ObjectStoreBinding } from "../../git/types.ts";
import { repositoryObjectStore } from "../../git/repo-object-store.ts";
import { MemoryBucket } from "../../test-bucket.ts";
import {
  get,
  interfaceUserInfoFetch,
  jsonRequest,
  makeEnv,
} from "./testkit.ts";
import { registerRepoRoutes } from "./routes.ts";
import { processRepositoryDeletionQueue } from "./repositories.ts";

const tokens = interfaceUserInfoFetch({
  taksrv_alice_w: {
    scope: "source.git.hosting.write",
    subject: "sub-alice",
  },
  taksrv_alice_a: {
    scope: "source.git.hosting.admin",
    subject: "sub-alice",
  },
  taksrv_alice_r: {
    scope: "source.git.hosting.read",
    subject: "sub-alice",
  },
});

function router(): RouteRegistry {
  const registry = new RouteRegistry();
  registerRepoRoutes(registry);
  return registry;
}

async function dispatch(
  registry: RouteRegistry,
  request: Request,
  env: RouterEnv,
): Promise<Response> {
  const response = await registry.handle({
    request,
    env,
    interfaceUserInfoFetch: tokens,
  });
  if (!response) throw new Error("route was not handled");
  return response;
}

describe("repository deletion quarantine", () => {
  test("reserves the generation until tombstone cleanup completes", async () => {
    const handle = makeEnv();
    const registry = router();
    const create = () =>
      dispatch(
        registry,
        jsonRequest(
          "POST",
          "/api/v1/repos",
          { owner: "alice", name: "web", visibility: "private" },
          "taksrv_alice_w",
        ),
        handle.env,
      );

    expect((await create()).status).toBe(201);
    const original = await handle.db.queryOne<{
      id: string;
      generation: string;
      lifecycle_state: string;
    }>(
      `SELECT id, generation, lifecycle_state
       FROM repositories WHERE storage_key = 'alice/web'`,
    );
    expect(original?.lifecycle_state).toBe("active");
    await repositoryObjectStore(handle.bucket, "alice/web").put(
      "objects/aa/old",
      "old",
    );
    const releaseAssetKey = "release-assets/alice/web/release/asset/archive.zip";
    const webhookPayloadKey =
      `webhooks/v1/repos/${original?.id}/delivery.json`;
    const legacyWebhookPayloadKey = "webhooks/v1/deliveries/legacy.json";
    const actionsBucket = new MemoryBucket();
    await handle.bucket.put(releaseAssetKey, "release");
    await handle.bucket.put(webhookPayloadKey, "webhook");
    await handle.bucket.put(legacyWebhookPayloadKey, "legacy-webhook");
    await actionsBucket.put(`logs/${original?.id}/run/job.log`, "log");
    await actionsBucket.put(
      `artifacts/${original?.id}/run/archive.zip`,
      "artifact",
    );
    const hookId = handle.db.id();
    const now = handle.db.now();
    await handle.db.run(
      `INSERT INTO webhooks
         (id, repo_id, url, events, created_at, updated_at)
       VALUES (?, ?, 'https://hook.example/receive', '["push"]', ?, ?)`,
      [hookId, original?.id, now, now],
    );
    await handle.db.run(
      `INSERT INTO webhook_deliveries
         (id, webhook_id, event, payload_r2_key, status, attempt,
          created_at, updated_at)
       VALUES (?, ?, 'push', ?, 'success', 1, ?, ?)`,
      [handle.db.id(), hookId, legacyWebhookPayloadKey, now, now],
    );

    const removed = await dispatch(
      registry,
      jsonRequest(
        "DELETE",
        "/api/v1/repos/alice/web",
        undefined,
        "taksrv_alice_a",
      ),
      handle.env,
    );
    expect(removed.status).toBe(202);
    expect(await removed.json()).toMatchObject({
      deleted: true,
      cleanupPending: true,
      generation: original?.generation,
    });
    expect(await repoExists(handle.bucket, "alice/web")).toBe(false);
    expect(
      [...handle.bucket.store.keys()].some((key) =>
        key.startsWith(`git/v4/quarantine/${original?.generation}/`),
      ),
    ).toBe(true);
    // Physical bytes remain during the quarantine window.
    expect(
      [...handle.bucket.store.keys()].some((key) =>
        key.startsWith("git/v3/repos/alice/web/"),
      ),
    ).toBe(true);
    const tombstoned = await handle.db.queryOne<{
      lifecycle_state: string;
    }>(
      `SELECT lifecycle_state FROM repositories WHERE id = ?`,
      [original?.id],
    );
    expect(tombstoned?.lifecycle_state).toBe("deleting");
    expect(
      (
        await dispatch(
          registry,
          get("/api/v1/repos/alice/web", "taksrv_alice_r"),
          handle.env,
        )
      ).status,
    ).toBe(404);
    // The namespace is reserved until old bytes can no longer race a recreate.
    expect((await create()).status).toBe(409);

    const cleanup = await processRepositoryDeletionQueue(
      handle.db,
      handle.bucket,
      { now: Number.MAX_SAFE_INTEGER, actionsBucket },
    );
    expect(cleanup).toEqual({ cleaned: 1, failed: 0 });
    expect(
      await handle.db.queryOne(
        `SELECT id FROM repositories WHERE id = ?`,
        [original?.id],
      ),
    ).toBeNull();
    expect(
      [...handle.bucket.store.keys()].some((key) =>
        key.startsWith("git/v3/repos/alice/web/"),
      ),
    ).toBe(false);
    expect(handle.bucket.store.has(releaseAssetKey)).toBe(false);
    expect(handle.bucket.store.has(webhookPayloadKey)).toBe(false);
    expect(handle.bucket.store.has(legacyWebhookPayloadKey)).toBe(false);
    expect(
      [...actionsBucket.store.keys()].some((key) =>
        key.startsWith(`logs/${original?.id}/`),
      ),
    ).toBe(false);
    expect(
      [...actionsBucket.store.keys()].some((key) =>
        key.startsWith(`artifacts/${original?.id}/`),
      ),
    ).toBe(false);
    const ledger = await handle.db.queryOne<{
      status: string;
      completed_at: number | null;
    }>(
      `SELECT status, completed_at FROM repository_deletions WHERE generation = ?`,
      [original?.generation],
    );
    expect(ledger?.status).toBe("completed");
    expect(ledger?.completed_at).not.toBeNull();

    expect((await create()).status).toBe(201);
    const recreated = await handle.db.queryOne<{ generation: string }>(
      `SELECT generation FROM repositories WHERE storage_key = 'alice/web'`,
    );
    expect(recreated?.generation).not.toBe(original?.generation);
    expect(await repoExists(handle.bucket, "alice/web")).toBe(true);
  });

  test.each([1, 2])(
    "retries the final quarantine marker after metadata deletion (%i failures)",
    async (failureCount) => {
      const handle = makeEnv();
      const registry = router();
      const create = () => dispatch(
        registry,
        jsonRequest(
          "POST",
          "/api/v1/repos",
          { owner: "alice", name: "retry-marker", visibility: "private" },
          "taksrv_alice_w",
        ),
        handle.env,
      );
      expect((await create()).status).toBe(201);
      const original = await handle.db.queryOne<{
        id: string;
        generation: string;
      }>(
        `SELECT id, generation FROM repositories
         WHERE storage_key = 'alice/retry-marker'`,
      );
      if (!original) throw new Error("created repository missing");
      const markerKey = repositoryQuarantineKey(original.generation);
      await repositoryObjectStore(handle.bucket, "alice/retry-marker").put(
        "objects/aa/old",
        "old",
      );
      expect((await dispatch(
        registry,
        jsonRequest(
          "DELETE",
          "/api/v1/repos/alice/retry-marker",
          undefined,
          "taksrv_alice_a",
        ),
        handle.env,
      )).status).toBe(202);

      let failures = 0;
      const bucket: ObjectStoreBinding = {
        get: (key) => handle.bucket.get(key),
        head: (key) => handle.bucket.head(key),
        put: (key, value, options) => handle.bucket.put(key, value, options),
        list: (options) => handle.bucket.list(options),
        async delete(keys) {
          if (
            (Array.isArray(keys) ? keys : [keys]).includes(markerKey) &&
            failures < failureCount
          ) {
            failures += 1;
            throw new Error("marker removal unavailable");
          }
          await handle.bucket.delete(keys);
        },
      };
      for (let attempt = 0; attempt < failureCount; attempt += 1) {
        expect(await processRepositoryDeletionQueue(handle.db, bucket, {
          now: Number.MAX_SAFE_INTEGER,
        })).toEqual({ cleaned: 0, failed: 1 });
        // The first attempt already removed metadata; later failures still
        // need to retain the queue entry until the last R2 marker is gone.
        expect(await handle.db.queryOne(
          `SELECT id FROM repositories WHERE id = ?`,
          [original.id],
        )).toBeNull();
        expect(handle.bucket.store.has(markerKey)).toBe(true);
        expect(await handle.db.queryOne(
          `SELECT status, last_error FROM repository_deletions
           WHERE generation = ?`,
          [original.generation],
        )).toEqual({ status: "failed", last_error: "marker removal unavailable" });
      }
      expect(failures).toBe(failureCount);
      expect(await processRepositoryDeletionQueue(handle.db, bucket, {
        now: Number.MAX_SAFE_INTEGER,
      })).toEqual({ cleaned: 0, failed: 0 });
      expect(handle.bucket.store.has(markerKey)).toBe(false);
      const completed = await handle.db.queryOne<{
        status: string;
        last_error: string | null;
        completed_at: number | null;
      }>(
        `SELECT status, last_error, completed_at FROM repository_deletions
         WHERE generation = ?`,
        [original.generation],
      );
      expect(completed?.status).toBe("completed");
      expect(completed?.last_error).toBeNull();
      expect(completed?.completed_at).not.toBeNull();
      expect((await handle.bucket.list({
        prefix: "git/v3/repos/alice/retry-marker/",
      })).objects).toEqual([]);
      expect(await processRepositoryDeletionQueue(handle.db, bucket, {
        now: Number.MAX_SAFE_INTEGER,
      })).toEqual({ cleaned: 0, failed: 0 });
      expect((await create()).status).toBe(201);
    },
  );

  test("cleanup is idempotent after a completed generation", async () => {
    const handle = makeEnv();
    expect(
      await processRepositoryDeletionQueue(handle.db, handle.bucket, {
        now: Number.MAX_SAFE_INTEGER,
      }),
    ).toEqual({ cleaned: 0, failed: 0 });
  });
});
