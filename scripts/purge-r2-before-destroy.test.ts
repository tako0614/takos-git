import { describe, expect, test } from "bun:test";

import {
  purgeR2BeforeDestroy,
  r2CleanerWorkerSource,
  type PurgeFetch,
} from "./purge-r2-before-destroy.ts";

const ENV = {
  CLOUDFLARE_API_TOKEN: "provider-secret",
  TAKOS_GIT_CLOUDFLARE_API_MODE: "direct",
  TAKOSUMI_OUTPUTS_JSON: JSON.stringify({
    cloudflare_account_id: { value: "account-123" },
    object_bucket_name: { value: "git-e2e-objects" },
    actions_logs_bucket_name: { value: "git-e2e-actions" },
  }),
} as const;

function api(payload: Record<string, unknown> = {}): Response {
  return Response.json({ success: true, ...payload });
}

describe("R2 pre-destroy adapter", () => {
  test("reads allowlisted outputs, purges both buckets in bounded pages, and removes every cleaner", async () => {
    const uploads: FormData[] = [];
    const deletedScripts: string[] = [];
    const pageByWorker = new Map<string, number>();
    const bucketByWorker = new Map<string, string>();
    const fetchImpl: PurgeFetch = async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      const method = init?.method ?? "GET";
      if (url.endsWith("/workers/subdomain") && method === "GET") {
        return api({ result: { subdomain: "fixture" } });
      }
      if (url.includes("/workers/scripts/") && method === "PUT") {
        const upload = init?.body as FormData;
        uploads.push(upload);
        const metadata = JSON.parse(
          await (upload.get("metadata") as Blob).text(),
        ) as { bindings: Array<{ bucket_name: string }> };
        bucketByWorker.set(
          url.slice(url.lastIndexOf("/") + 1),
          metadata.bindings[0]?.bucket_name ?? "",
        );
        return api();
      }
      if (url.endsWith("/subdomain") && method === "POST") return api();
      if (url.endsWith(".workers.dev/purge") && method === "POST") {
        const page = pageByWorker.get(url) ?? 0;
        pageByWorker.set(url, page + 1);
        const workerName = new URL(url).hostname.split(".")[0] ?? "";
        if (bucketByWorker.get(workerName) === "git-e2e-objects") {
          return Response.json(
            page === 0
              ? { ok: true, deleted: 1_000, done: false }
              : { ok: true, deleted: 0, done: true },
          );
        }
        return Response.json(
          page === 0
            ? { ok: true, deleted: 4, done: false }
            : { ok: true, deleted: 0, done: true },
        );
      }
      if (method === "DELETE") {
        deletedScripts.push(url);
        return api();
      }
      return new Response("unexpected", { status: 500 });
    };

    const result = await purgeR2BeforeDestroy(
      ENV,
      fetchImpl,
      async () => undefined,
    );

    expect(result.status).toBe("succeeded");
    expect(result.buckets.map(({ bucketName }) => bucketName)).toEqual([
      "git-e2e-objects",
      "git-e2e-actions",
    ]);
    expect(result.deleted).toBe(1_004);
    expect(result.cleanersRemoved).toBe(true);
    expect(uploads).toHaveLength(2);
    expect(deletedScripts).toHaveLength(2);
    const uploadedBucketNames: string[] = [];
    for (const upload of uploads) {
      const metadata = JSON.parse(
        await (upload.get("metadata") as Blob).text(),
      ) as { bindings: Array<{ bucket_name: string }> };
      uploadedBucketNames.push(metadata.bindings[0]?.bucket_name ?? "");
      const source = await (upload.get("worker.mjs") as Blob).text();
      expect(source).toContain("EXPECTED_TOKEN_SHA256");
      expect(source).toContain("env.BUCKET.list({limit:1000})");
      expect(source).not.toContain("for(;;)");
      expect(source).not.toContain("provider-secret");
    }
    expect(uploadedBucketNames).toEqual([
      "git-e2e-objects",
      "git-e2e-actions",
    ]);
    expect(JSON.stringify(result)).not.toContain("provider-secret");
    expect(JSON.stringify(result)).not.toContain("authorization");
  });

  test("always removes the deterministic cleaner when the upload response is lost", async () => {
    let removed = false;
    const fetchImpl: PurgeFetch = async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      const method = init?.method ?? "GET";
      if (url.endsWith("/workers/subdomain") && method === "GET") {
        return api({ result: { subdomain: "fixture" } });
      }
      if (method === "PUT") throw new Error("upload response lost");
      if (method === "DELETE") {
        removed = true;
        return api();
      }
      return new Response("unexpected", { status: 500 });
    };

    await expect(
      purgeR2BeforeDestroy(
        {
          CLOUDFLARE_API_TOKEN: "provider-secret",
          CLOUDFLARE_ACCOUNT_ID: "account-123",
          TAKOS_GIT_CLOUDFLARE_API_MODE: "direct",
          TAKOS_GIT_R2_BUCKET_NAME: "git-e2e-objects",
        },
        fetchImpl,
        async () => undefined,
      ),
    ).rejects.toThrow("upload response lost");
    expect(removed).toBe(true);
  });

  test("removes the cleaner after bounded readiness retries fail", async () => {
    let purgeAttempts = 0;
    let removed = false;
    const fetchImpl: PurgeFetch = async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      const method = init?.method ?? "GET";
      if (url.endsWith("/workers/subdomain") && method === "GET") {
        return api({ result: { subdomain: "fixture" } });
      }
      if (url.endsWith(".workers.dev/purge")) {
        purgeAttempts += 1;
        return new Response("not ready", { status: 503 });
      }
      if (method === "DELETE") {
        removed = true;
        return api();
      }
      return api();
    };

    await expect(
      purgeR2BeforeDestroy(
        {
          CLOUDFLARE_API_TOKEN: "provider-secret",
          CLOUDFLARE_ACCOUNT_ID: "account-123",
          TAKOS_GIT_CLOUDFLARE_API_MODE: "direct",
          TAKOS_GIT_R2_BUCKET_NAME: "git-e2e-objects",
        },
        fetchImpl,
        async () => undefined,
      ),
    ).rejects.toThrow("did not become ready");
    expect(purgeAttempts).toBe(10);
    expect(removed).toBe(true);
  });

  test("rejects missing object output before any provider call", async () => {
    let called = false;
    await expect(
      purgeR2BeforeDestroy(
        {
          CLOUDFLARE_API_TOKEN: "provider-secret",
          CLOUDFLARE_ACCOUNT_ID: "account-123",
          TAKOSUMI_OUTPUTS_JSON: JSON.stringify({
            actions_logs_bucket_name: { value: "git-e2e-actions" },
          }),
        },
        async () => {
          called = true;
          return api();
        },
      ),
    ).rejects.toThrow("object_bucket_name output is required");
    expect(called).toBe(false);
  });

  test("uses the delivered managed provider base and provider-returned cleaner origin", async () => {
    const urls: string[] = [];
    const fetchImpl: PurgeFetch = async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      urls.push(url);
      const method = init?.method ?? "GET";
      if (url.endsWith("/subdomain") && method === "POST") {
        return api({
          result: {
            enabled: true,
            previews_enabled: false,
            hostname: "git-cleaner.app.takos.jp",
          },
        });
      }
      if (url === "https://git-cleaner.app.takos.jp/purge") {
        return Response.json({ ok: true, deleted: 0, done: true });
      }
      return api();
    };

    const result = await purgeR2BeforeDestroy(
      {
        CLOUDFLARE_API_TOKEN: "compat-provider-secret",
        TAKOSUMI_OUTPUTS_JSON: JSON.stringify({
          cloudflare_account_id: { value: "virtual-account" },
          object_bucket_name: { value: "git-e2e-objects" },
        }),
        TAKOSUMI_PROVIDER_CONFIGS_JSON: JSON.stringify({
          "cloudflare/cloudflare": {
            base_url: "https://app.takosumi.test/compat/cloudflare/client/v4",
          },
        }),
      },
      fetchImpl,
      async () => undefined,
    );

    expect(result.status).toBe("succeeded");
    expect(urls).toContain("https://git-cleaner.app.takos.jp/purge");
    const apiUrls = urls.filter((url) =>
      url.includes("/accounts/virtual-account/"),
    );
    expect(apiUrls.length).toBeGreaterThan(0);
    expect(
      apiUrls.every((url) =>
        url.startsWith(
          "https://app.takosumi.test/compat/cloudflare/client/v4/",
        ),
      ),
    ).toBe(true);
    expect(urls.some((url) => url.includes("api.cloudflare.com"))).toBe(false);
    expect(urls.some((url) => url.includes("workers/subdomain"))).toBe(false);
  });

  test("never sends a provider token when execution context has no API base", async () => {
    let called = false;
    await expect(
      purgeR2BeforeDestroy(
        {
          CLOUDFLARE_API_TOKEN: "compat-provider-secret",
          TAKOSUMI_OUTPUTS_JSON: JSON.stringify({
            cloudflare_account_id: { value: "virtual-account" },
            object_bucket_name: { value: "git-e2e-objects" },
          }),
        },
        async () => {
          called = true;
          return api();
        },
      ),
    ).rejects.toThrow("Cloudflare API base is unresolved");
    expect(called).toBe(false);
  });

  test("rejects secret-bearing provider config before any provider call", async () => {
    let called = false;
    await expect(
      purgeR2BeforeDestroy(
        {
          CLOUDFLARE_API_TOKEN: "compat-provider-secret",
          TAKOSUMI_OUTPUTS_JSON: JSON.stringify({
            cloudflare_account_id: { value: "virtual-account" },
            object_bucket_name: { value: "git-e2e-objects" },
          }),
          TAKOSUMI_PROVIDER_CONFIGS_JSON: JSON.stringify({
            "cloudflare/cloudflare": {
              base_url: "https://app.takosumi.test/compat/cloudflare/client/v4",
              api_token: "must-not-be-delivered-here",
            },
          }),
        },
        async () => {
          called = true;
          return api();
        },
      ),
    ).rejects.toThrow("must contain only non-secret provider configuration");
    expect(called).toBe(false);
  });

  test("managed cleanup fails closed and removes the cleaner when no invocation origin is returned", async () => {
    let removed = false;
    const fetchImpl: PurgeFetch = async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      const method = init?.method ?? "GET";
      if (method === "DELETE") {
        removed = true;
        return api();
      }
      return api();
    };
    await expect(
      purgeR2BeforeDestroy(
        {
          CLOUDFLARE_API_TOKEN: "compat-provider-secret",
          TAKOSUMI_OUTPUTS_JSON: JSON.stringify({
            cloudflare_account_id: { value: "virtual-account" },
            object_bucket_name: { value: "git-e2e-objects" },
          }),
          TAKOSUMI_PROVIDER_CONFIGS_JSON: JSON.stringify({
            "cloudflare/cloudflare": {
              base_url: "https://app.takosumi.test/compat/cloudflare/client/v4",
            },
          }),
        },
        fetchImpl,
        async () => undefined,
      ),
    ).rejects.toThrow("did not return the temporary cleaner invocation origin");
    expect(removed).toBe(true);
  });

  test("generated cleaner contains only a token hash and performs one page per invocation", () => {
    const source = r2CleanerWorkerSource("a".repeat(64));
    expect(source).toContain(`EXPECTED_TOKEN_SHA256=${JSON.stringify("a".repeat(64))}`);
    expect(source).toContain("env.BUCKET.list({limit:1000})");
    expect(source).not.toContain("while(");
    expect(source).not.toContain("for(;;)");
  });
});
