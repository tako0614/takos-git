import { describe, expect, test } from "bun:test";

import { RouteRegistry, routes, type Route, type RouterEnv } from "./router.ts";
import { createDbClient } from "./db/client.ts";
import { createFakeD1, type FakeD1 } from "./db/fake.ts";
import { migrationSql } from "./db/migration-sql.ts";
import { MemoryBucket } from "./test-bucket.ts";
// Side-effect import: registers /api/v1/ping into the global registry, exactly as
// the worker does. Enumerating `routes` below therefore sees the real surface.
import "./routes/ping.ts";

const OK: Route["handler"] = () => new Response("ok", { status: 200 });

function req(method: string, path: string): Request {
  return new Request(`https://git.example${path}`, { method });
}

async function seedPublicRepo(): Promise<{ env: RouterEnv; db: FakeD1 }> {
  const db = createFakeD1(migrationSql);
  const client = createDbClient(db);
  const ownerId = client.id();
  const now = client.now();
  await client.run(
    `INSERT INTO owners (id, login, type, principal_id, created_at, updated_at)
     VALUES (?, 'acme', 'org', NULL, ?, ?)`,
    [ownerId, now, now],
  );
  await client.run(
    `INSERT INTO repositories (id, owner_id, name, storage_key, visibility, default_branch, created_at, updated_at)
     VALUES (?, ?, 'web', 'acme/web', 'public', 'main', ?, ?)`,
    [client.id(), ownerId, now, now],
  );
  return { env: { BUCKET: new MemoryBucket(), DB: db }, db };
}

describe("route registry — default-deny annotation invariant (meta-test)", () => {
  test("every registered route declares an auth mechanism, and non-public routes a required role", () => {
    const list = routes.list();
    expect(list.length).toBeGreaterThan(0);
    for (const route of list) {
      expect(["public", "browser", "interface"]).toContain(route.auth);
      if (route.auth !== "public") {
        expect(route.requiredRole).toBeDefined();
      }
    }
  });

  test("the global surface exposes the trivial ping route", () => {
    const ping = routes.list().find((r) => r.path === "/api/v1/ping");
    expect(ping).toBeDefined();
    expect(ping?.auth).toBe("public");
    expect(ping?.method).toBe("GET");
  });

  test("registering a non-public route without a required role throws (fails closed at registration)", () => {
    const reg = new RouteRegistry();
    expect(() =>
      reg.register({
        method: "GET",
        path: "/api/v1/leak",
        auth: "browser",
        handler: OK,
      }),
    ).toThrow(/requiredRole/u);
  });

  test("registering an interface route without a scope or action throws", () => {
    const reg = new RouteRegistry();
    expect(() =>
      reg.register({
        method: "POST",
        path: "/api/v1/thing",
        auth: "interface",
        requiredRole: "writer",
        handler: OK,
      }),
    ).toThrow(/scope/u);
  });
});

describe("route registry — dispatch", () => {
  test("dispatches the public ping route", async () => {
    const reg = new RouteRegistry();
    reg.register({
      method: "GET",
      path: "/api/v1/ping",
      auth: "public",
      handler: () => Response.json({ ok: true }),
    });
    const res = await reg.handle({
      request: req("GET", "/api/v1/ping"),
      env: { BUCKET: new MemoryBucket() },
    });
    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual({ ok: true });
  });

  test("returns null when no route path matches (worker continues)", async () => {
    const reg = new RouteRegistry();
    reg.register({
      method: "GET",
      path: "/api/v1/ping",
      auth: "public",
      handler: OK,
    });
    const res = await reg.handle({
      request: req("GET", "/api/v1/repos"),
      env: { BUCKET: new MemoryBucket() },
    });
    expect(res).toBeNull();
  });

  test("405 when the path matches but the method does not", async () => {
    const reg = new RouteRegistry();
    reg.register({
      method: "GET",
      path: "/api/v1/ping",
      auth: "public",
      handler: OK,
    });
    const res = await reg.handle({
      request: req("POST", "/api/v1/ping"),
      env: { BUCKET: new MemoryBucket() },
    });
    expect(res?.status).toBe(405);
    expect(res?.headers.get("allow")).toContain("GET");
  });
});

describe("route registry — ACL default-deny at dispatch (meta-test)", () => {
  test("a role-less identity hitting a protected route gets 403", async () => {
    const { env } = await seedPublicRepo();
    const reg = new RouteRegistry();
    // A protected, repo-scoped write route. Anonymous has only the public reader
    // floor, so the write action must be denied — never served open.
    reg.register({
      method: "GET",
      path: "/api/v1/repos/:owner/:repo/gate",
      auth: "public",
      action: "contents.write",
      requiredRole: "writer",
      handler: () => new Response("SHOULD NOT REACH", { status: 200 }),
    });
    const res = await reg.handle({
      request: req("GET", "/api/v1/repos/acme/web/gate"),
      env,
    });
    expect(res?.status).toBe(403);
    expect(await res?.json()).toMatchObject({ error: { code: "forbidden" } });
  });

  test("a protected route on a repo the identity cannot see gets 404 (non-disclosure)", async () => {
    const { env } = await seedPublicRepo();
    const reg = new RouteRegistry();
    reg.register({
      method: "GET",
      path: "/api/v1/repos/:owner/:repo/gate",
      auth: "public",
      action: "contents.read",
      requiredRole: "reader",
      handler: OK,
    });
    const res = await reg.handle({
      request: req("GET", "/api/v1/repos/acme/missing/gate"),
      env,
    });
    expect(res?.status).toBe(404);
  });
});
