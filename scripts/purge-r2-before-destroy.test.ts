import { describe, expect, test } from "bun:test";

import { purgeR2BucketBeforeDestroy } from "./purge-r2-before-destroy.ts";

const ENV = {
  CLOUDFLARE_API_TOKEN: "provider-secret",
  CLOUDFLARE_ACCOUNT_ID: "account-123",
  TAKOS_GIT_R2_BUCKET_NAME: "git-e2e-objects",
  TAKOS_GIT_WORKERS_SUBDOMAIN: "example",
} as const;

describe("R2 pre-destroy adapter", () => {
  test("binds, empties, and removes the temporary cleaner", async () => {
    const requests: Array<{ url: string; method: string; init?: RequestInit }> =
      [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({ url, method, init });
      if (url.endsWith("/purge")) {
        return Response.json({ ok: true, deleted: 23 });
      }
      return Response.json({ success: true, result: {} });
    };

    const result = await purgeR2BucketBeforeDestroy(
      ENV,
      fetchImpl,
      async () => undefined,
    );

    expect(result).toEqual({
      kind: "takos-git.r2-pre-destroy@v1",
      status: "succeeded",
      bucketName: "git-e2e-objects",
      deleted: 23,
      cleanerRemoved: true,
    });
    expect(requests.map(({ method }) => method)).toEqual([
      "PUT",
      "POST",
      "POST",
      "DELETE",
    ]);
    const upload = requests[0]?.init?.body;
    expect(upload).toBeInstanceOf(FormData);
    const metadata = JSON.parse(
      await ((upload as FormData).get("metadata") as Blob).text(),
    );
    expect(metadata.bindings).toEqual([
      {
        type: "r2_bucket",
        name: "BUCKET",
        bucket_name: "git-e2e-objects",
      },
    ]);
    const source = await (
      (upload as FormData).get("worker.mjs") as Blob
    ).text();
    expect(source).toContain("EXPECTED_TOKEN_SHA256");
    expect(source).not.toContain("provider-secret");
    expect(JSON.stringify(result)).not.toContain("provider-secret");
  });

  test("removes the cleaner when purge execution fails", async () => {
    const methods: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const method = init?.method ?? "GET";
      methods.push(method);
      if (String(input).endsWith("/purge")) {
        return new Response("not ready", { status: 503 });
      }
      return Response.json({ success: true, result: {} });
    };

    expect(
      purgeR2BucketBeforeDestroy(ENV, fetchImpl, async () => undefined),
    ).rejects.toThrow("did not become ready");
    expect(methods.at(-1)).toBe("DELETE");
  });

  test("fails when the temporary cleaner cannot be removed", async () => {
    const fetchImpl: typeof fetch = async (input, init) => {
      if (init?.method === "DELETE") {
        return Response.json(
          { success: false, errors: [{ message: "delete denied" }] },
          { status: 403 },
        );
      }
      if (String(input).endsWith("/purge")) {
        return Response.json({ ok: true, deleted: 1 });
      }
      return Response.json({ success: true, result: {} });
    };

    expect(
      purgeR2BucketBeforeDestroy(ENV, fetchImpl, async () => undefined),
    ).rejects.toThrow("cleaner removal failed");
  });
});
