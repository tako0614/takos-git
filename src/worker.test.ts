import { describe, expect, test } from "bun:test";

import { createGitWorker, type AssetFetcher, type Env } from "./worker.ts";
import { MemoryBucket } from "./test-bucket.ts";
import { seedRepo } from "./seed.ts";
import { concatBytes } from "./git/sha1.ts";
import { PKT_FLUSH, pktLineString } from "./git/pack-common.ts";
import { createDbClient } from "./db/client.ts";
import { createFakeD1 } from "./db/fake.ts";
import { migrationSql } from "./db/migration-sql.ts";

const REPO = "acme/widgets";
const READ_TOKEN = "taksrv_git_read";
const WRITE_TOKEN = "taksrv_git_write";
const HOSTING_TOKEN = "taksrv_hosting_read";
const WRONG_CAPSULE_TOKEN = "taksrv_git_wrong_capsule";

const worker = createGitWorker(async (_input, init) => {
  const authorization = new Headers(init?.headers).get("authorization") ?? "";
  const token = authorization.replace(/^Bearer\s+/u, "");
  const scope =
    token === WRITE_TOKEN
      ? "source.git.smart_http.write"
      : token === HOSTING_TOKEN
        ? "source.git.hosting.read"
        : "source.git.smart_http.read";
  return Response.json({
    token_use: "interface_oauth",
    sub: "principal_git",
    aud:
      token === HOSTING_TOKEN
        ? "https://git.example/api/v1"
        : "https://git.example/git",
    scope,
    takosumi: {
      workspace_id: "workspace_a",
      capsule_id:
        token === WRONG_CAPSULE_TOKEN ? "capsule_other" : "capsule_git",
      interface_id: "interface_git_http",
      interface_binding_id: "binding_a",
      interface_resolved_revision: 8,
    },
  });
});

function req(
  method: string,
  path: string,
  opts: { token?: string; body?: Uint8Array } = {},
): Request {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  return new Request(`https://git.example${path}`, {
    method,
    headers,
    ...(opts.body ? { body: opts.body } : {}),
  });
}

async function setup() {
  const bucket = new MemoryBucket();
  const seeded = await seedRepo(bucket, { repo: REPO, content: "hi\n" });
  const env: Env = {
    BUCKET: bucket,
    APP_URL: "https://git.example",
    OIDC_ISSUER_URL: "https://accounts.example",
    APP_WORKSPACE_ID: "workspace_a",
    APP_CAPSULE_ID: "capsule_git",
  };
  return { env, seeded };
}

describe("takos-git worker", () => {
  test("healthz needs no auth", async () => {
    const { env } = await setup();
    const res = await worker.fetch(req("GET", "/healthz"), env);
    expect(res.status).toBe(200);
  });

  test("root console needs no auth", async () => {
    const { env } = await setup();
    const res = await worker.fetch(req("GET", "/"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Takos Git");
  });

  test("/ui serves the same console surface", async () => {
    const { env } = await setup();
    const res = await worker.fetch(req("GET", "/ui"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Takos Git");
    expect(html).toContain("Show clone command");
  });

  test("routes the authenticated hosting API before Smart HTTP", async () => {
    const { env } = await setup();
    // The /api/v1 forge surface now lives on the router + D1 ACL. Seed a matching
    // public repo row so the list returns it (owner "acme", name "widgets").
    const fake = createFakeD1(migrationSql);
    const db = createDbClient(fake);
    const now = db.now();
    const ownerId = db.id();
    await db.run(
      `INSERT INTO owners (id, login, type, principal_id, created_at, updated_at)
       VALUES (?, 'acme', 'org', NULL, ?, ?)`,
      [ownerId, now, now],
    );
    await db.run(
      `INSERT INTO repositories (id, owner_id, name, storage_key, visibility, default_branch, created_at, updated_at)
       VALUES (?, ?, 'widgets', 'acme/widgets', 'public', 'main', ?, ?)`,
      [db.id(), ownerId, now, now],
    );
    const res = await worker.fetch(
      req("GET", "/api/v1/repos", { token: HOSTING_TOKEN }),
      { ...env, DB: fake },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      repositories: [{ fullName: REPO }],
    });
  });

  test("the /api/v1 forge surface is 503 without the metadata plane", async () => {
    const { env } = await setup();
    const res = await worker.fetch(
      req("GET", "/api/v1/repos", { token: HOSTING_TOKEN }),
      env,
    );
    expect(res.status).toBe(503);
  });

  test("serves the launcher tile icon it advertises", async () => {
    const { env } = await setup();
    const res = await worker.fetch(req("GET", "/icons/takos-git.svg"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/svg+xml");
    const body = await res.text();
    expect(body).toContain("<svg");
    // Drift guard: the served bytes must equal the repo-owned asset referenced
    // by the service-side InstallConfig launcher Interface document.
    const onDisk = await Bun.file(
      new URL("../public/icons/takos-git.svg", import.meta.url),
    ).text();
    expect(body).toBe(onDisk);
  });

  test("info/refs requires a token", async () => {
    const { env } = await setup();
    const res = await worker.fetch(
      req("GET", `/git/${REPO}.git/info/refs?service=git-upload-pack`),
      env,
    );
    expect(res.status).toBe(401);
  });

  test("authentication runs before repository existence checks", async () => {
    const { env } = await setup();
    const res = await worker.fetch(
      req("GET", "/git/acme/missing.git/info/refs?service=git-upload-pack"),
      env,
    );
    expect(res.status).toBe(401);
  });

  test("advertises refs for the seeded repo", async () => {
    const { env, seeded } = await setup();
    const res = await worker.fetch(
      req("GET", `/git/${REPO}.git/info/refs?service=git-upload-pack`, {
        token: READ_TOKEN,
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/x-git-upload-pack-advertisement",
    );
    const text = await res.text();
    expect(text).toContain("refs/heads/main");
    expect(text).toContain(seeded.commitSha);
  });

  test("rejects Interface evidence owned by another Capsule", async () => {
    const { env } = await setup();
    const res = await worker.fetch(
      req("GET", `/git/${REPO}.git/info/refs?service=git-upload-pack`, {
        token: WRONG_CAPSULE_TOKEN,
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  test("never derives Interface audience authority from the caller Host", async () => {
    const { env } = await setup();
    const res = await worker.fetch(
      new Request(
        `https://attacker.example/git/${REPO}.git/info/refs?service=git-upload-pack`,
        { headers: { authorization: `Bearer ${READ_TOKEN}` } },
      ),
      { ...env, APP_URL: undefined },
    );
    expect(res.status).toBe(503);
  });

  test("upload-pack returns a packfile for an advertised want", async () => {
    const { env, seeded } = await setup();
    const body = concatBytes(
      pktLineString(`want ${seeded.commitSha}\n`),
      PKT_FLUSH,
      pktLineString("done\n"),
    );
    const res = await worker.fetch(
      req("POST", `/git/${REPO}.git/git-upload-pack`, {
        token: READ_TOKEN,
        body,
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/x-git-upload-pack-result",
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    // "0008NAK\n" then a PACK header.
    const head = new TextDecoder().decode(bytes.slice(0, 12));
    expect(head).toContain("NAK");
    expect(head).toContain("PACK");
  });

  test("rejects a want that is not an advertised tip (IDOR guard)", async () => {
    const { env } = await setup();
    const body = concatBytes(
      pktLineString(`want ${"a".repeat(40)}\n`),
      PKT_FLUSH,
      pktLineString("done\n"),
    );
    const res = await worker.fetch(
      req("POST", `/git/${REPO}.git/git-upload-pack`, {
        token: READ_TOKEN,
        body,
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  test("push rejects a read-scoped Interface credential", async () => {
    const { env } = await setup();
    const res = await worker.fetch(
      req("POST", `/git/${REPO}.git/git-receive-pack`, { token: READ_TOKEN }),
      env,
    );
    expect(res.status).toBe(401);
  });

  test("receive-pack advertisement requires write scope", async () => {
    const { env, seeded } = await setup();
    const res = await worker.fetch(
      req("GET", `/git/${REPO}.git/info/refs?service=git-receive-pack`, {
        token: WRITE_TOKEN,
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/x-git-receive-pack-advertisement",
    );
    const text = await res.text();
    expect(text).toContain(seeded.commitSha);
    expect(text).toContain("report-status delete-refs ofs-delta atomic");
  });

  test("receive-pack rejects a token with the wrong Capsule owner", async () => {
    const { env } = await setup();
    const res = await worker.fetch(
      req("GET", `/git/${REPO}.git/info/refs?service=git-receive-pack`, {
        token: WRONG_CAPSULE_TOKEN,
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  test("receive-pack rejects malformed ref names without changing refs", async () => {
    const { env, seeded } = await setup();
    const body = concatBytes(
      pktLineString(
        `${seeded.commitSha} ${"b".repeat(40)} refs/heads/../escape\0report-status\n`,
      ),
      PKT_FLUSH,
    );
    const res = await worker.fetch(
      req("POST", `/git/${REPO}.git/git-receive-pack`, {
        token: WRITE_TOKEN,
        body,
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("invalid ref name");

    const refs = await worker.fetch(
      req("GET", `/git/${REPO}.git/info/refs?service=git-upload-pack`, {
        token: READ_TOKEN,
      }),
      env,
    );
    expect(await refs.text()).toContain(seeded.commitSha);
  });

  test("receive-pack rejects malformed pack data", async () => {
    const { env } = await setup();
    const body = concatBytes(
      pktLineString(
        `${"0".repeat(40)} ${"b".repeat(40)} refs/heads/topic\0report-status ofs-delta atomic\n`,
      ),
      PKT_FLUSH,
      new TextEncoder().encode("PACKbad"),
    );
    const res = await worker.fetch(
      req("POST", `/git/${REPO}.git/git-receive-pack`, {
        token: WRITE_TOKEN,
        body,
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("pack: shorter than 12-byte header");
  });

  test("dispatches /api/v1/ping through the route registry", async () => {
    const { env } = await setup();
    const res = await worker.fetch(req("GET", "/api/v1/ping"), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ service: "takos-git", ok: true });
  });

  test("a wrong method on a registered route is 405, not a fall-through", async () => {
    const { env } = await setup();
    const res = await worker.fetch(req("POST", "/api/v1/ping"), env);
    expect(res.status).toBe(405);
  });
});

describe("takos-git SPA asset serving + CSP", () => {
  const assets: AssetFetcher = {
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/assets/")) {
        return new Response("console.log(1)", {
          status: 200,
          headers: { "content-type": "application/javascript" },
        });
      }
      // not_found_handling = single-page-application → index.html for deep links.
      return new Response("<!doctype html><div id=root></div>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  };

  test("serves hashed assets with a hardened CSP and immutable cache", async () => {
    const { env } = await setup();
    const res = await worker.fetch(req("GET", "/assets/index-ab12cd34.js"), {
      ...env,
      ASSETS: assets,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    // The migration is a genuine hardening: no unsafe-inline scripts.
    expect(csp).not.toContain("script-src 'unsafe-inline'");
    expect(csp).not.toContain("'unsafe-inline'; script-src");
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  test("serves the SPA index for deep client-side links (no immutable cache)", async () => {
    const { env } = await setup();
    const res = await worker.fetch(req("GET", "/acme/web/pulls/3"), {
      ...env,
      ASSETS: assets,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toContain(
      "script-src 'self'",
    );
    expect(res.headers.get("cache-control") ?? "").not.toContain("immutable");
  });

  test("without an ASSETS binding, unmatched GETs are 404 (unchanged)", async () => {
    const { env } = await setup();
    const res = await worker.fetch(req("GET", "/acme/web/pulls/3"), env);
    expect(res.status).toBe(404);
  });
});
