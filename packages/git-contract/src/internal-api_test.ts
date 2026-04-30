import assert from "node:assert/strict";
import {
  encodeActorContext,
  signInternalRequest,
  TAKOS_GIT_INTERNAL_PATHS,
  TAKOS_INTERNAL_ACTOR_DIGEST_HEADER,
  TAKOS_INTERNAL_ACTOR_HEADER,
  TAKOS_INTERNAL_AUDIENCE_HEADER,
  TAKOS_INTERNAL_BODY_DIGEST_HEADER,
  TAKOS_INTERNAL_CALLER_HEADER,
  TAKOS_INTERNAL_NONCE_HEADER,
  TAKOS_INTERNAL_REQUEST_ID_HEADER,
  TAKOS_INTERNAL_SIGNATURE_HEADER,
  TAKOS_INTERNAL_TIMESTAMP_HEADER,
  type TakosActorContext,
  verifySignedInternalRequestFromHeaders,
} from "./internal-api.ts";

const actor: TakosActorContext = {
  actorAccountId: "acct_owner",
  roles: ["owner"],
  requestId: "req_v2",
  spaceId: "space_1",
};

Deno.test("signInternalRequest emits v2 headers and verifies bound context", async () => {
  const body = '{"repositoryId":"repo_1"}';
  const signed = await signInternalRequest({
    method: "post",
    path: TAKOS_GIT_INTERNAL_PATHS.repositories,
    body,
    timestamp: "2026-04-30T00:00:00.000Z",
    nonce: "nonce_1",
    caller: "takos-app",
    audience: "takos-git",
    actor,
    secret: "test-secret",
  });

  assert.equal(signed.headers[TAKOS_INTERNAL_REQUEST_ID_HEADER], "req_v2");
  assert.equal(signed.headers[TAKOS_INTERNAL_NONCE_HEADER], "nonce_1");
  assert.equal(signed.headers[TAKOS_INTERNAL_CALLER_HEADER], "takos-app");
  assert.equal(signed.headers[TAKOS_INTERNAL_AUDIENCE_HEADER], "takos-git");
  assert.equal(
    signed.headers[TAKOS_INTERNAL_ACTOR_HEADER],
    encodeActorContext(actor),
  );
  assert.match(
    signed.headers[TAKOS_INTERNAL_ACTOR_DIGEST_HEADER],
    /^[0-9a-f]{64}$/,
  );
  assert.match(
    signed.headers[TAKOS_INTERNAL_BODY_DIGEST_HEADER],
    /^[0-9a-f]{64}$/,
  );
  assert.match(
    signed.headers[TAKOS_INTERNAL_SIGNATURE_HEADER],
    /^[0-9a-f]{64}$/,
  );
  assert.equal(
    signed.headers[TAKOS_INTERNAL_TIMESTAMP_HEADER],
    "2026-04-30T00:00:00.000Z",
  );

  assert.equal(
    await verifySignedInternalRequestFromHeaders({
      method: "POST",
      path: TAKOS_GIT_INTERNAL_PATHS.repositories,
      body,
      secret: "test-secret",
      headers: new Headers(signed.headers),
      expectedCaller: "takos-app",
      expectedAudience: "takos-git",
      now: () => new Date("2026-04-30T00:01:00.000Z"),
    }),
    true,
  );
});

Deno.test("verifySignedInternalRequestFromHeaders rejects tampered actor and stale timestamp", async () => {
  const body = "{}";
  const signed = await signInternalRequest({
    method: "GET",
    path: TAKOS_GIT_INTERNAL_PATHS.repositories,
    body,
    timestamp: "2026-04-30T00:00:00.000Z",
    actor,
    secret: "test-secret",
  });

  const tampered = new Headers(signed.headers);
  tampered.set(
    TAKOS_INTERNAL_ACTOR_HEADER,
    encodeActorContext({ ...actor, actorAccountId: "acct_attacker" }),
  );
  assert.equal(
    await verifySignedInternalRequestFromHeaders({
      method: "GET",
      path: TAKOS_GIT_INTERNAL_PATHS.repositories,
      body,
      secret: "test-secret",
      headers: tampered,
      now: () => new Date("2026-04-30T00:01:00.000Z"),
    }),
    false,
  );

  assert.equal(
    await verifySignedInternalRequestFromHeaders({
      method: "GET",
      path: TAKOS_GIT_INTERNAL_PATHS.repositories,
      body,
      secret: "test-secret",
      headers: new Headers(signed.headers),
      now: () => new Date("2026-04-30T00:06:00.000Z"),
    }),
    false,
  );
});
