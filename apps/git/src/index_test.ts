import assert from "node:assert/strict";
import app from "./index.ts";
import {
  TAKOS_GIT_CAPABILITIES,
  TAKOS_GIT_INTERNAL_PATHS,
  type TakosActorContext,
} from "takos-git-contract";
import { signTakosInternalRequest } from "takos-paas-contract/internal-rpc";

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

Deno.test("repository metadata creation does not create an on-disk bare repository", async () => {
  const root = await Deno.makeTempDir();
  const originalRoot = Deno.env.get("TAKOS_GIT_REPOSITORY_ROOT");
  Deno.env.set("TAKOS_GIT_REPOSITORY_ROOT", root);
  try {
    const repositoryId = `metadata-${crypto.randomUUID()}`;
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const create = await signedRequest({
      method: "POST",
      path: TAKOS_GIT_INTERNAL_PATHS.repositories,
      body: JSON.stringify({
        id: repositoryId,
        name: "Metadata Only",
        ownerAccountId: "acct_1",
        refs: { main: commit },
      }),
    });

    assert.equal(create.status, 201);
    await assert.rejects(
      () => Deno.stat(`${root}/${repositoryId}.git`),
      Deno.errors.NotFound,
    );

    const refs = await signedRequest({
      method: "GET",
      path: TAKOS_GIT_INTERNAL_PATHS.repositoryRefs(repositoryId),
    });
    assert.equal(refs.status, 404);
    assert.deepEqual(await refs.json(), {
      error: "repository not found",
      code: "git_repository_not_found",
      repositoryId,
    });

    const resolved = await signedResolveRequest({
      repositoryId,
      sourceRef: "main",
    });
    assert.equal(resolved.status, 404);
    assert.deepEqual(await resolved.json(), {
      error: "repository not found",
      code: "git_repository_not_found",
      repositoryId,
    });
  } finally {
    restoreEnv("TAKOS_GIT_REPOSITORY_ROOT", originalRoot);
    await Deno.remove(root, { recursive: true });
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

Deno.test("source resolver verifies literal commits against configured bare repository root", async () => {
  await withBareRepository(async (fixture) => {
    const originalRoot = Deno.env.get("TAKOS_GIT_REPOSITORY_ROOT");
    Deno.env.set("TAKOS_GIT_REPOSITORY_ROOT", fixture.root);
    try {
      const response = await signedResolveRequest({
        repositoryId: fixture.repositoryId,
        sourceRef: fixture.commit,
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.deepEqual(body, {
        repositoryId: fixture.repositoryId,
        sourceRef: fixture.commit,
        resolvedCommit: fixture.commit,
      });
    } finally {
      restoreEnv("TAKOS_GIT_REPOSITORY_ROOT", originalRoot);
    }
  });
});

Deno.test("source resolver rejects missing literal commits when repository root is configured", async () => {
  await withBareRepository(async (fixture) => {
    const originalRoot = Deno.env.get("TAKOS_GIT_REPOSITORY_ROOT");
    Deno.env.set("TAKOS_GIT_REPOSITORY_ROOT", fixture.root);
    try {
      const missingCommit = "f".repeat(40);
      const response = await signedResolveRequest({
        repositoryId: fixture.repositoryId,
        sourceRef: missingCommit,
      });
      const body = await response.json();

      assert.equal(response.status, 422);
      assert.deepEqual(body, {
        error: "literal commit id was not found in repository",
        code: "git_commit_not_found",
        repositoryId: fixture.repositoryId,
        objectId: missingCommit,
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

Deno.test("object endpoint returns git cat-file pretty output from configured bare repository root", async () => {
  await withBareRepository(async (fixture) => {
    const originalRoot = Deno.env.get("TAKOS_GIT_REPOSITORY_ROOT");
    Deno.env.set("TAKOS_GIT_REPOSITORY_ROOT", fixture.root);
    try {
      const response = await signedRequest({
        method: "GET",
        path: TAKOS_GIT_INTERNAL_PATHS.object(
          fixture.repositoryId,
          fixture.commit,
        ),
      });

      assert.equal(response.status, 200);
      assert.equal(
        response.headers.get("x-takos-git-object-id"),
        fixture.commit,
      );
      assert.equal(response.headers.get("x-takos-git-object-type"), "commit");
      assert.equal(
        response.headers.get("x-takos-git-object-format"),
        "git-cat-file-pretty",
      );
      const text = await response.text();
      assert.match(text, /^tree [0-9a-f]{40}$/m);
      assert.match(text, /^author Takos Test <test@example\.com> /m);
      assert.match(text, /\n\ninitial\n$/);
    } finally {
      restoreEnv("TAKOS_GIT_REPOSITORY_ROOT", originalRoot);
    }
  });
});

Deno.test("smart HTTP rejects unauthenticated clone/fetch discovery", async () => {
  await withBareRepository(async (fixture) => {
    const originalRoot = Deno.env.get("TAKOS_GIT_REPOSITORY_ROOT");
    const originalSecret = Deno.env.get("TAKOS_INTERNAL_SERVICE_SECRET");
    Deno.env.set("TAKOS_GIT_REPOSITORY_ROOT", fixture.root);
    Deno.env.set("TAKOS_INTERNAL_SERVICE_SECRET", "test-secret");
    try {
      const response = await app.request(
        `/${fixture.repositoryId}.git/info/refs?service=git-upload-pack`,
      );
      const body = await response.json();

      assert.equal(response.status, 401);
      assert.deepEqual(body, { error: "missing internal signature" });
    } finally {
      restoreEnv("TAKOS_GIT_REPOSITORY_ROOT", originalRoot);
      restoreEnv("TAKOS_INTERNAL_SERVICE_SECRET", originalSecret);
    }
  });
});

Deno.test("smart HTTP rejects unauthenticated push endpoint", async () => {
  await withBareRepository(async (fixture) => {
    const originalRoot = Deno.env.get("TAKOS_GIT_REPOSITORY_ROOT");
    const originalSecret = Deno.env.get("TAKOS_INTERNAL_SERVICE_SECRET");
    Deno.env.set("TAKOS_GIT_REPOSITORY_ROOT", fixture.root);
    Deno.env.set("TAKOS_INTERNAL_SERVICE_SECRET", "test-secret");
    try {
      const response = await app.request(
        `/${fixture.repositoryId}.git/git-receive-pack`,
        {
          method: "POST",
          headers: {
            "content-type": "application/x-git-receive-pack-request",
          },
          body: "",
        },
      );
      const body = await response.json();

      assert.equal(response.status, 401);
      assert.deepEqual(body, { error: "missing internal signature" });
    } finally {
      restoreEnv("TAKOS_GIT_REPOSITORY_ROOT", originalRoot);
      restoreEnv("TAKOS_INTERNAL_SERVICE_SECRET", originalSecret);
    }
  });
});

Deno.test("smart HTTP serves signed clone/fetch discovery", async () => {
  await withBareRepository(async (fixture) => {
    const originalRoot = Deno.env.get("TAKOS_GIT_REPOSITORY_ROOT");
    Deno.env.set("TAKOS_GIT_REPOSITORY_ROOT", fixture.root);
    try {
      const path = `/${fixture.repositoryId}.git/info/refs`;
      const response = await signedRequest({
        method: "GET",
        path,
        requestPath: `${path}?service=git-upload-pack`,
      });
      const body = await response.text();

      assert.equal(response.status, 200);
      assert.match(
        response.headers.get("content-type") ?? "",
        /^application\/x-git-upload-pack-advertisement/,
      );
      assert.match(body, /# service=git-upload-pack/);
    } finally {
      restoreEnv("TAKOS_GIT_REPOSITORY_ROOT", originalRoot);
    }
  });
});

Deno.test("smart HTTP rejects normal git clients because they cannot sign internal requests", async () => {
  await withBareRepository(async (fixture) => {
    const originalRoot = Deno.env.get("TAKOS_GIT_REPOSITORY_ROOT");
    const originalSecret = Deno.env.get("TAKOS_INTERNAL_SERVICE_SECRET");
    Deno.env.set("TAKOS_GIT_REPOSITORY_ROOT", fixture.root);
    Deno.env.set("TAKOS_INTERNAL_SERVICE_SECRET", "test-secret");
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
        const clone = await gitOutput(["clone", remoteUrl, cloneDir]);

        assert.equal(clone.success, false);
        assert.match(
          `${clone.stdout}\n${clone.stderr}`,
          /Authentication failed|The requested URL returned error: 401|could not read Username/,
        );
      } finally {
        await Deno.remove(cloneDir, { recursive: true });
      }
    } finally {
      await server.shutdown();
      restoreEnv("TAKOS_GIT_REPOSITORY_ROOT", originalRoot);
      restoreEnv("TAKOS_INTERNAL_SERVICE_SECRET", originalSecret);
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
    capabilities: [TAKOS_GIT_CAPABILITIES.refResolve],
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
  readonly requestPath?: string;
  readonly body?: string;
  readonly timestamp?: string;
  readonly caller?: string;
  readonly audience?: string;
  readonly capabilities?: readonly string[];
}): Promise<Response> {
  const originalSecret = Deno.env.get("TAKOS_INTERNAL_SERVICE_SECRET");
  const originalCallers = Deno.env.get("TAKOS_GIT_INTERNAL_CALLERS");
  Deno.env.set("TAKOS_INTERNAL_SERVICE_SECRET", "test-secret");
  Deno.env.set("TAKOS_GIT_INTERNAL_CALLERS", "takos-app,takos-paas");
  try {
    const body = input.body ?? "";
    const requestPath = input.requestPath ?? input.path;
    const requestUrl = new URL(requestPath, "https://git.internal");
    const signed = await signTakosInternalRequest({
      method: input.method,
      path: requestUrl.pathname,
      query: requestUrl.search,
      body,
      timestamp: input.timestamp ?? new Date().toISOString(),
      secret: "test-secret",
      actor,
      caller: input.caller ?? "takos-app",
      audience: input.audience ?? "takos-git",
      capabilities: input.capabilities ??
        defaultCapabilities(input.method, input.path),
    });
    return await app.request(requestPath, {
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

function defaultCapabilities(method: string, path: string): readonly string[] {
  const verb = method.toUpperCase();
  if (path.includes("/git-receive-pack")) {
    return [TAKOS_GIT_CAPABILITIES.repoWrite];
  }
  if (path.includes("/git-upload-pack") || path.includes(".git")) {
    return [TAKOS_GIT_CAPABILITIES.repoRead];
  }
  if (path.startsWith("/internal/objects/")) {
    return [TAKOS_GIT_CAPABILITIES.objectRead];
  }
  if (path === TAKOS_GIT_INTERNAL_PATHS.resolveSource) {
    return [TAKOS_GIT_CAPABILITIES.refResolve];
  }
  if (path.includes("/refs") || verb === "GET") {
    return [TAKOS_GIT_CAPABILITIES.repoRead];
  }
  return [TAKOS_GIT_CAPABILITIES.repoWrite];
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
  const output = await gitOutput(args);
  if (!output.success) {
    throw new Error(output.stderr);
  }
  return output.stdout;
}

async function gitOutput(
  args: string[],
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const output = await new Deno.Command("git", {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    success: output.success,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) Deno.env.delete(key);
  else Deno.env.set(key, value);
}
