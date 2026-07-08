import { describe, expect, test } from "bun:test";

import worker, { type Env } from "./worker.ts";
import { MemoryBucket } from "./test-bucket.ts";
import { seedRepo } from "./seed.ts";
import { mintGitToken, type GitTokenPayload } from "./git-token.ts";
import { concatBytes } from "./git/sha1.ts";
import { PKT_FLUSH, pktLineString } from "./git/pack-common.ts";

const KEY = "worker-test-git-key-abcdef";
const REPO = "acme/widgets";

async function token(over: Partial<GitTokenPayload> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return mintGitToken(KEY, {
    v: 1,
    ws: "space_x",
    sub: "inst_x",
    pfx: REPO,
    cap: ["r"],
    aud: "takos.git.hosting",
    iat: now,
    exp: now + 3600,
    ...over,
  });
}

function req(method: string, path: string, opts: { token?: string; body?: Uint8Array } = {}): Request {
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
  const env: Env = { BUCKET: bucket, GIT_TOKEN_SIGNING_KEY: KEY };
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

  test("info/refs requires a token", async () => {
    const { env } = await setup();
    const res = await worker.fetch(
      req("GET", `/git/${REPO}.git/info/refs?service=git-upload-pack`),
      env,
    );
    expect(res.status).toBe(401);
  });

  test("advertises refs for the seeded repo", async () => {
    const { env, seeded } = await setup();
    const res = await worker.fetch(
      req("GET", `/git/${REPO}.git/info/refs?service=git-upload-pack`, { token: await token() }),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement");
    const text = await res.text();
    expect(text).toContain("refs/heads/main");
    expect(text).toContain(seeded.commitSha);
  });

  test("rejects a token scoped to a different repo", async () => {
    const { env } = await setup();
    const res = await worker.fetch(
      req("GET", `/git/${REPO}.git/info/refs?service=git-upload-pack`, {
        token: await token({ pfx: "someone/else" }),
      }),
      env,
    );
    expect(res.status).toBe(403);
  });

  test("upload-pack returns a packfile for an advertised want", async () => {
    const { env, seeded } = await setup();
    const body = concatBytes(
      pktLineString(`want ${seeded.commitSha}\n`),
      PKT_FLUSH,
      pktLineString("done\n"),
    );
    const res = await worker.fetch(
      req("POST", `/git/${REPO}.git/git-upload-pack`, { token: await token(), body }),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-git-upload-pack-result");
    const bytes = new Uint8Array(await res.arrayBuffer());
    // "0008NAK\n" then a PACK header.
    const head = new TextDecoder().decode(bytes.slice(0, 12));
    expect(head).toContain("NAK");
    expect(head).toContain("PACK");
  });

  test("rejects a want that is not an advertised tip (IDOR guard)", async () => {
    const { env } = await setup();
    const body = concatBytes(pktLineString(`want ${"a".repeat(40)}\n`), PKT_FLUSH, pktLineString("done\n"));
    const res = await worker.fetch(
      req("POST", `/git/${REPO}.git/git-upload-pack`, { token: await token(), body }),
      env,
    );
    expect(res.status).toBe(400);
  });

  test("push (receive-pack) is disabled", async () => {
    const { env } = await setup();
    const res = await worker.fetch(
      req("POST", `/git/${REPO}.git/git-receive-pack`, { token: await token() }),
      env,
    );
    expect(res.status).toBe(403);
  });
});
