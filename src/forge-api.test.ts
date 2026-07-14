import { describe, expect, test } from "bun:test";

import { handleForgeApi, type ForgeApiEnv } from "./forge-api.ts";
import { MemoryBucket } from "./test-bucket.ts";

function env(): ForgeApiEnv {
  return { BUCKET: new MemoryBucket() };
}

function request(path: string, method = "GET"): Request {
  return new Request(`https://git.example${path}`, { method });
}

describe("forge-api (slim: browser-auth passthrough + /api/v1 tail)", () => {
  test("serves the browser session endpoint", async () => {
    const res = await handleForgeApi(request("/api/auth/session"), env());
    expect(res?.status).toBe(200);
    expect(await res?.json()).toMatchObject({ authenticated: false });
  });

  test("returns null for non-API paths (worker continues to git dispatch)", async () => {
    const res = await handleForgeApi(request("/git/acme/web.git/info/refs"), env());
    expect(res).toBeNull();
  });

  test("an unmatched /api/v1 path returns a JSON 404 in the standard envelope", async () => {
    const res = await handleForgeApi(request("/api/v1/repos/acme/web/unknown"), env());
    expect(res?.status).toBe(404);
    expect(await res?.json()).toMatchObject({ error: { code: "not_found" } });
  });
});
