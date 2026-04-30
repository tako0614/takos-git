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

Deno.test("source resolver resolves refs from configured bare repository root", async () => {
  await withBareRepository(async (fixture) => {
    const originalRoot = Deno.env.get("TAKOS_GIT_REPOSITORY_ROOT");
    Deno.env.set("TAKOS_GIT_REPOSITORY_ROOT", fixture.root);
    try {
      const response = await signedResolveRequest({
        repositoryId: fixture.repositoryId,
        sourceRef: "main",
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.deepEqual(body, {
        repositoryId: fixture.repositoryId,
        sourceRef: "main",
        resolvedCommit: fixture.commit,
        resolvedRef: "refs/heads/main",
      });
    } finally {
      restoreEnv("TAKOS_GIT_REPOSITORY_ROOT", originalRoot);
    }
  });
});

Deno.test("refs endpoint lists refs from configured bare repository root", async () => {
  await withBareRepository(async (fixture) => {
    const originalRoot = Deno.env.get("TAKOS_GIT_REPOSITORY_ROOT");
    Deno.env.set("TAKOS_GIT_REPOSITORY_ROOT", fixture.root);
    try {
      const response = await signedRequest({
        method: "GET",
        path: TAKOS_GIT_INTERNAL_PATHS.repositoryRefs(fixture.repositoryId),
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.deepEqual(body, {
        repositoryId: fixture.repositoryId,
        refs: [{ name: "refs/heads/main", target: fixture.commit }],
      });
    } finally {
      restoreEnv("TAKOS_GIT_REPOSITORY_ROOT", originalRoot);
    }
  });
});

Deno.test("object endpoint reads Git objects from configured bare repository root", async () => {
  await withBareRepository(async (fixture) => {
    const originalRoot = Deno.env.get("TAKOS_GIT_REPOSITORY_ROOT");
    Deno.env.set("TAKOS_GIT_REPOSITORY_ROOT", fixture.root);
    try {
      const response = await signedRequest({
        method: "GET",
        path: TAKOS_GIT_INTERNAL_PATHS.object(
          fixture.repositoryId,
          fixture.blob,
        ),
      });

      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-takos-git-object-id"), fixture.blob);
      assert.equal(response.headers.get("x-takos-git-object-type"), "blob");
      assert.equal(await response.text(), "hello from takos-git\n");
    } finally {
      restoreEnv("TAKOS_GIT_REPOSITORY_ROOT", originalRoot);
    }
  });
});

Deno.test("smart HTTP supports clone and push against configured bare repository root", async () => {
  await withBareRepository(async (fixture) => {
    const originalRoot = Deno.env.get("TAKOS_GIT_REPOSITORY_ROOT");
    Deno.env.set("TAKOS_GIT_REPOSITORY_ROOT", fixture.root);
    const server = Deno.serve({
      hostname: "127.0.0.1",
      port: 0,
      onListen() {},
    }, app.fetch);
    try {
      const cloneDir = await Deno.makeTempDir();
      try {
        const addr = server.addr as Deno.NetAddr;
        const remoteUrl =
          `http://127.0.0.1:${addr.port}/${fixture.repositoryId}.git`;
        await git(["clone", remoteUrl, cloneDir]);
        await git(["-C", cloneDir, "config", "user.email", "test@example.com"]);
        await git(["-C", cloneDir, "config", "user.name", "Takos Test"]);
        await Deno.writeTextFile(`${cloneDir}/SECOND.md`, "second\n");
        await git(["-C", cloneDir, "add", "SECOND.md"]);
        await git(["-C", cloneDir, "commit", "-m", "second"]);
        await git(["-C", cloneDir, "push", "origin", "main"]);

        const pushed = await git([
          "--git-dir",
          `${fixture.root}/${fixture.repositoryId}.git`,
          "rev-parse",
          "refs/heads/main",
        ]);
        assert.notEqual(pushed.trim(), fixture.commit);
      } finally {
        await Deno.remove(cloneDir, { recursive: true });
      }
    } finally {
      await server.shutdown();
      restoreEnv("TAKOS_GIT_REPOSITORY_ROOT", originalRoot);
    }
  });
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
    caller: "unknown-service",
  });
  const body = await response.json();

  assert.equal(response.status, 401);
  assert.deepEqual(body, { error: "invalid internal caller" });
});

Deno.test("source resolver accepts takos-paas internal caller", async () => {
  const sourceRef = "0123456789abcdef0123456789abcdef01234567";
  const response = await signedResolveRequest({
    repositoryId: "repo_1",
    sourceRef,
    caller: "takos-paas",
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    repositoryId: "repo_1",
    sourceRef,
    resolvedCommit: sourceRef,
  });
});

Deno.test("source resolver rejects wrong internal audience", async () => {
  const response = await signedResolveRequest({
    repositoryId: "repo_1",
    sourceRef: "0123456789abcdef0123456789abcdef01234567",
    audience: "takos-paas",
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
  return await signedRequest({
    method: "POST",
    path: TAKOS_GIT_INTERNAL_PATHS.resolveSource,
    caller: input.caller,
    audience: input.audience,
    body: JSON.stringify({
      ...(input.includeBodyActor ? { actor } : {}),
      repositoryId: input.repositoryId,
      sourceRef: input.sourceRef,
    }),
    timestamp: input.timestamp,
  });
}

async function signedRequest(input: {
  readonly method: string;
  readonly path: string;
  readonly body?: string;
  readonly timestamp?: string;
  readonly caller?: string;
  readonly audience?: string;
}): Promise<Response> {
  const originalSecret = Deno.env.get("TAKOS_INTERNAL_SERVICE_SECRET");
  const originalCallers = Deno.env.get("TAKOS_GIT_INTERNAL_CALLERS");
  Deno.env.set("TAKOS_INTERNAL_SERVICE_SECRET", "test-secret");
  Deno.env.set("TAKOS_GIT_INTERNAL_CALLERS", "takos-app,takos-paas");
  try {
    const body = input.body ?? "";
    const signed = await signInternalRequest({
      method: input.method,
      path: input.path,
      body,
      timestamp: input.timestamp ?? new Date().toISOString(),
      secret: "test-secret",
      actor,
      caller: input.caller ?? "takos-app",
      audience: input.audience ?? "takos-git",
    });
    return await app.request(input.path, {
      method: input.method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...signed.headers,
      },
      ...(body ? { body } : {}),
    });
  } finally {
    restoreEnv("TAKOS_INTERNAL_SERVICE_SECRET", originalSecret);
    restoreEnv("TAKOS_GIT_INTERNAL_CALLERS", originalCallers);
  }
}

async function withBareRepository(
  fn: (fixture: {
    root: string;
    repositoryId: string;
    commit: string;
    blob: string;
  }) => Promise<void>,
) {
  const root = await Deno.makeTempDir();
  try {
    const repositoryId = "repo_fixture";
    const barePath = `${root}/${repositoryId}.git`;
    const workPath = `${root}/work`;
    await git(["init", "--bare", barePath]);
    await git(["init", workPath]);
    await git(["-C", workPath, "config", "user.email", "test@example.com"]);
    await git(["-C", workPath, "config", "user.name", "Takos Test"]);
    await Deno.writeTextFile(
      `${workPath}/README.md`,
      "hello from takos-git\n",
    );
    await git(["-C", workPath, "add", "README.md"]);
    await git(["-C", workPath, "commit", "-m", "initial"]);
    await git(["-C", workPath, "branch", "-M", "main"]);
    await git(["-C", workPath, "remote", "add", "origin", barePath]);
    await git(["-C", workPath, "push", "origin", "main"]);
    await git([
      "--git-dir",
      barePath,
      "symbolic-ref",
      "HEAD",
      "refs/heads/main",
    ]);
    const commit = await git(["-C", workPath, "rev-parse", "HEAD"]);
    const blob = await git(["-C", workPath, "rev-parse", "HEAD:README.md"]);
    await fn({
      root,
      repositoryId,
      commit: commit.trim(),
      blob: blob.trim(),
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

async function git(args: string[]): Promise<string> {
  const output = await new Deno.Command("git", {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw new Error(new TextDecoder().decode(output.stderr));
  }
  return new TextDecoder().decode(output.stdout);
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) Deno.env.delete(key);
  else Deno.env.set(key, value);
}
