import { expect, test } from "bun:test";
import { createGitWorker } from "./worker.ts";
import { MemoryBucket } from "./test-bucket.ts";
import { seedRepo } from "./seed.ts";

const bindings = {
  OIDC_ISSUER_URL: "https://accounts.example",
  OIDC_CLIENT_ID: "synthetic-git-client",
  OIDC_REDIRECT_URI: "https://git-host.example/api/auth/callback",
  APP_SESSION_SECRET: "synthetic-session-secret-long-enough-for-tests",
  APP_CAPSULE_ID: "capsule_git",
  APP_WORKSPACE_ID: "workspace_a",
};

test("registered runtime origin reaches the real Smart HTTP consumer on its matching public Host", async () => {
  const bucket = new MemoryBucket();
  await seedRepo(bucket, { repo: "acme/widgets", content: "initial source\n" });
  let userInfoCalls = 0;
  const worker = createGitWorker(async () => {
    userInfoCalls++;
    return Response.json({
      token_use: "interface_oauth", sub: "principal_git", aud: "https://git-host.example/git",
      scope: "source.git.smart_http.read",
      takosumi: { workspace_id: "workspace_a", capsule_id: "capsule_git", interface_id: "interface_git_http", interface_binding_id: "binding_a", interface_resolved_revision: 8 },
    });
  });
  const response = await worker.fetch(new Request(
    "https://git-host.example/git/acme/widgets.git/info/refs?service=git-upload-pack",
    { headers: { authorization: "Bearer taksrv_fixture_invocation" } },
  ), { ...bindings, BUCKET: bucket });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement");
  expect(userInfoCalls).toBe(1);
});

test("invalid registered delivery rejects before issuer or object effects", async () => {
  const bucket = new MemoryBucket();
  let userInfoCalls = 0;
  const worker = createGitWorker(async () => { userInfoCalls++; throw Error("must not dispatch"); });
  const before = await bucket.list();
  const response = await worker.fetch(new Request(
    "https://git-host.example/git/acme/widgets.git/info/refs?service=git-upload-pack",
    { headers: { authorization: "Bearer taksrv_fixture_invocation" } },
  ), { ...bindings, OIDC_REDIRECT_URI: " ", APP_URL: "https://git-host.example", BUCKET: bucket });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "registered_callback_invalid" });
  expect(userInfoCalls).toBe(0);
  expect(await bucket.list()).toEqual(before);
});


test("registered callback does not authorize invocation through a foreign request Host", async () => {
  let calls = 0;
  const worker = createGitWorker(async () => { calls++; throw Error("must not dispatch"); });
  const response = await worker.fetch(new Request(
    "https://internal-worker.example/git/acme/widgets.git/info/refs?service=git-upload-pack",
    { headers: { authorization: "Bearer taksrv_fixture_invocation" } },
  ), { ...bindings, BUCKET: new MemoryBucket() });
  expect(response.status).toBe(401);
  expect(calls).toBe(0);
});
