import assert from "node:assert/strict";
import app from "./index.ts";
import {
  signInternalRequest,
  TAKOS_GIT_INTERNAL_PATHS,
  type TakosActorContext,
} from "takos-git-contract";

const actor: TakosActorContext = {
  actorAccountId: "acct_1",
  roles: ["owner"],
  requestId: "req_1",
  spaceId: "space_1",
};

Deno.test("source resolver accepts literal 40-hex commit ids", async () => {
  const sourceRef = "0123456789abcdef0123456789abcdef01234567";
  const response = await signedResolveRequest({
    repositoryId: "repo_1",
    sourceRef,
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    repositoryId: "repo_1",
    sourceRef,
    resolvedCommit: sourceRef,
  });
});

Deno.test("source resolver request body does not carry actor context", async () => {
  const sourceRef = "0123456789abcdef0123456789abcdef01234567";
  const response = await signedResolveRequest({
    repositoryId: "repo_1",
    sourceRef,
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    repositoryId: "repo_1",
    sourceRef,
    resolvedCommit: sourceRef,
  });
});

Deno.test("source resolver rejects actor context in request body", async () => {
  const response = await signedResolveRequest({
    repositoryId: "repo_1",
    sourceRef: "0123456789abcdef0123456789abcdef01234567",
    includeBodyActor: true,
  });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.deepEqual(body, {
    error:
      "repositoryId and sourceRef are required; actor context must be provided by signed internal headers",
    code: "invalid_source_resolution_request",
  });
});

Deno.test("source resolver accepts literal 64-hex commit ids", async () => {
  const sourceRef =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const response = await signedResolveRequest({
    repositoryId: "repo_1",
    sourceRef,
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    repositoryId: "repo_1",
    sourceRef,
    resolvedCommit: sourceRef,
  });
});

Deno.test("source resolver rejects branch or tag refs as unresolved", async () => {
  for (const sourceRef of ["main", "v1.0.0"]) {
    const response = await signedResolveRequest({
      repositoryId: "repo_1",
      sourceRef,
    });
    const body = await response.json();

    assert.equal(response.status, 422);
    assert.deepEqual(body, {
      error: "real ref resolution is not implemented/configured for takos-git",
      code: "git_ref_resolution_not_configured",
      repositoryId: "repo_1",
      sourceRef,
    });
  }
});

Deno.test("source resolver still requires internal signature auth", async () => {
  const originalSecret = Deno.env.get("TAKOS_INTERNAL_SERVICE_SECRET");
  Deno.env.set("TAKOS_INTERNAL_SERVICE_SECRET", "test-secret");
  try {
    const response = await app.request(TAKOS_GIT_INTERNAL_PATHS.resolveSource, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repositoryId: "repo_1",
        sourceRef: "0123456789abcdef0123456789abcdef01234567",
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 401);
    assert.deepEqual(body, { error: "missing internal signature" });
  } finally {
    restoreEnv("TAKOS_INTERNAL_SERVICE_SECRET", originalSecret);
  }
});

Deno.test("source resolver rejects stale signed internal requests", async () => {
  const response = await signedResolveRequest({
    repositoryId: "repo_1",
    sourceRef: "0123456789abcdef0123456789abcdef01234567",
    timestamp: "2000-01-01T00:00:00.000Z",
  });
  const body = await response.json();

  assert.equal(response.status, 401);
  assert.deepEqual(body, { error: "invalid internal signature" });
});

Deno.test("source resolver rejects wrong internal caller", async () => {
  const response = await signedResolveRequest({
    repositoryId: "repo_1",
    sourceRef: "0123456789abcdef0123456789abcdef01234567",
    caller: "takos-runtime",
  });
  const body = await response.json();

  assert.equal(response.status, 401);
  assert.deepEqual(body, { error: "invalid internal caller" });
});

Deno.test("source resolver rejects wrong internal audience", async () => {
  const response = await signedResolveRequest({
    repositoryId: "repo_1",
    sourceRef: "0123456789abcdef0123456789abcdef01234567",
    audience: "takos-deploy",
  });
  const body = await response.json();

  assert.equal(response.status, 401);
  assert.deepEqual(body, { error: "invalid internal signature" });
});

async function signedResolveRequest(input: {
  readonly repositoryId: string;
  readonly sourceRef: string;
  readonly timestamp?: string;
  readonly caller?: string;
  readonly audience?: string;
  readonly includeBodyActor?: boolean;
}): Promise<Response> {
  const originalSecret = Deno.env.get("TAKOS_INTERNAL_SERVICE_SECRET");
  const originalCallers = Deno.env.get("TAKOS_GIT_INTERNAL_CALLERS");
  Deno.env.set("TAKOS_INTERNAL_SERVICE_SECRET", "test-secret");
  Deno.env.set("TAKOS_GIT_INTERNAL_CALLERS", "takos-app,takos-deploy");
  try {
    const body = JSON.stringify({
      ...(input.includeBodyActor ? { actor } : {}),
      repositoryId: input.repositoryId,
      sourceRef: input.sourceRef,
    });
    const signed = await signInternalRequest({
      method: "POST",
      path: TAKOS_GIT_INTERNAL_PATHS.resolveSource,
      body,
      timestamp: input.timestamp ?? new Date().toISOString(),
      secret: "test-secret",
      actor,
      caller: input.caller ?? "takos-app",
      audience: input.audience ?? "takos-git",
    });
    return await app.request(TAKOS_GIT_INTERNAL_PATHS.resolveSource, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...signed.headers,
      },
      body,
    });
  } finally {
    restoreEnv("TAKOS_INTERNAL_SERVICE_SECRET", originalSecret);
    restoreEnv("TAKOS_GIT_INTERNAL_CALLERS", originalCallers);
  }
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) Deno.env.delete(key);
  else Deno.env.set(key, value);
}
