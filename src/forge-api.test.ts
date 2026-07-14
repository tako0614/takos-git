import { describe, expect, test } from "bun:test";

import { handleForgeApi, type ForgeApiEnv } from "./forge-api.ts";
import { seedRepo } from "./seed.ts";
import { MemoryBucket } from "./test-bucket.ts";
import { putBlob, putCommit } from "./git/object-store.ts";
import { buildTreeFromPaths } from "./git/tree-ops.ts";
import { writeRepoRefs } from "./git/refs-store.ts";
import { repositoryObjectStore } from "./git/repo-object-store.ts";
import type { ObjectStoreBinding } from "./git/types.ts";

const HOSTING_TOKEN = "taksrv_hosting_read";
const GIT_TOKEN = "taksrv_git_read";
const REPO = "acme/widgets";

function request(path: string, token?: string): Request {
  return new Request(`https://git.example${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

async function setup() {
  const bucket = new MemoryBucket();
  const seeded = await seedRepo(bucket, {
    repo: REPO,
    fileName: "README.md",
    content: "# Widgets\n\nA repository browser fixture.\n",
    message: "Add README\n",
  });
  const env: ForgeApiEnv = {
    BUCKET: bucket,
    APP_URL: "https://git.example",
    OIDC_ISSUER_URL: "https://accounts.example",
    APP_WORKSPACE_ID: "workspace_a",
    APP_CAPSULE_ID: "capsule_git",
  };
  const userInfoFetch = async (
    _input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const token = new Headers(init?.headers)
      .get("authorization")
      ?.replace(/^Bearer\s+/u, "");
    return Response.json({
      token_use: "interface_oauth",
      sub: "principal_1",
      aud:
        token === HOSTING_TOKEN
          ? "https://git.example/api/v1"
          : "https://git.example/git",
      scope:
        token === HOSTING_TOKEN
          ? "source.git.hosting.read"
          : "source.git.smart_http.read",
      takosumi: {
        workspace_id: "workspace_a",
        capsule_id: "capsule_git",
        interface_id: "interface_git_hosting",
        interface_binding_id: "binding_1",
        interface_resolved_revision: 1,
      },
    });
  };
  return { env, seeded, userInfoFetch };
}

async function call(path: string, token = HOSTING_TOKEN): Promise<Response> {
  const { env, userInfoFetch } = await setup();
  const response = await handleForgeApi(
    request(path, token),
    env,
    userInfoFetch,
  );
  if (!response) throw new Error(`route was not handled: ${path}`);
  return response;
}

describe("takos-git hosting read API", () => {
  test("requires a hosting-scoped Interface credential", async () => {
    const { env, userInfoFetch } = await setup();
    const missing = await handleForgeApi(
      request("/api/v1/repos"),
      env,
      userInfoFetch,
    );
    expect(missing?.status).toBe(401);

    const gitOnly = await handleForgeApi(
      request("/api/v1/repos", GIT_TOKEN),
      env,
      userInfoFetch,
    );
    expect(gitOnly?.status).toBe(401);
  });

  test("lists repositories without exposing R2 keys", async () => {
    const response = await call("/api/v1/repos");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      repositories: [
        {
          name: REPO,
          cloneUrl: `https://git.example/git/${REPO}.git`,
        },
      ],
      nextCursor: null,
    });
  });

  test("returns repository and branch summaries", async () => {
    const info = await call(`/api/v1/repos/${REPO}`);
    expect(info.status).toBe(200);
    expect(await info.json()).toMatchObject({
      repository: {
        name: REPO,
        defaultBranch: "main",
        branchCount: 1,
      },
    });

    const branches = await call(`/api/v1/repos/${REPO}/branches`);
    expect(await branches.json()).toMatchObject({
      repository: REPO,
      branches: [{ name: "main", default: true }],
    });
  });

  test("reads commit history, directory entries, and UTF-8 blobs", async () => {
    const { seeded } = await setup();
    const commits = await call(`/api/v1/repos/${REPO}/commits?ref=main`);
    expect(await commits.json()).toMatchObject({
      repository: REPO,
      branch: "main",
      commits: [
        {
          sha: seeded.commitSha,
          message: "Add README\n",
          author: { name: "Takos Git" },
        },
      ],
    });

    const tree = await call(`/api/v1/repos/${REPO}/tree?ref=main`);
    expect(await tree.json()).toMatchObject({
      repository: REPO,
      path: "",
      entries: [{ name: "README.md", kind: "blob" }],
    });

    const blob = await call(
      `/api/v1/repos/${REPO}/blob?ref=main&path=README.md`,
    );
    expect(await blob.json()).toMatchObject({
      repository: REPO,
      path: "README.md",
      encoding: "utf-8",
      content: "# Widgets\n\nA repository browser fixture.\n",
    });
  });

  test("does not resolve arbitrary raw object ids as browse refs", async () => {
    const { seeded } = await setup();
    const response = await call(
      `/api/v1/repos/${REPO}/tree?ref=${seeded.commitSha}`,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "branch_not_found" });
  });

  test("bounds blob decompression before returning browser content", async () => {
    const { env, userInfoFetch } = await setup();
    await seedRepo(env.BUCKET, {
      repo: "acme/large",
      fileName: "large.txt",
      content: new Uint8Array(1024 * 1024 + 1).fill(0x61),
    });
    const response = await handleForgeApi(
      request(
        "/api/v1/repos/acme/large/blob?ref=main&path=large.txt",
        HOSTING_TOKEN,
      ),
      env,
      userInfoFetch,
    );
    expect(response?.status).toBe(413);
    expect(await response?.json()).toEqual({
      error: "blob_too_large",
      maxBytes: 1024 * 1024,
    });
  });

  test("base64-encodes invalid UTF-8 beyond the initial binary sample", async () => {
    const { env, userInfoFetch } = await setup();
    const content = new Uint8Array(8 * 1024 + 2).fill(0x61);
    content[content.length - 1] = 0xff;
    await seedRepo(env.BUCKET, {
      repo: "acme/binary",
      fileName: "fixture.bin",
      content,
    });
    const response = await handleForgeApi(
      request(
        "/api/v1/repos/acme/binary/blob?ref=main&path=fixture.bin",
        HOSTING_TOKEN,
      ),
      env,
      userInfoFetch,
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      encoding: "base64",
      size: content.byteLength,
    });
  });
});

// --- Phase 2 read endpoints: commit detail, compare, blame, file history ---

const RICH_REPO = "acme/proj";
const SIG = {
  name: "Takos Git",
  email: "git@takos.test",
  timestamp: 1_700_000_000,
  tzOffset: "+0000",
};

async function makeCommit(
  store: ObjectStoreBinding,
  files: Record<string, string>,
  parents: string[],
): Promise<string> {
  const entries: Array<{ path: string; sha: string }> = [];
  for (const [path, content] of Object.entries(files)) {
    const sha = await putBlob(store, new TextEncoder().encode(content));
    entries.push({ path, sha });
  }
  const tree = await buildTreeFromPaths(store, entries);
  return putCommit(store, {
    tree,
    parents,
    author: SIG,
    committer: SIG,
    message: "c\n",
  });
}

function richUserInfoFetch(input: RequestInfo | URL, init?: RequestInit) {
  const token = new Headers(init?.headers)
    .get("authorization")
    ?.replace(/^Bearer\s+/u, "");
  return Promise.resolve(
    Response.json({
      token_use: "interface_oauth",
      sub: "principal_1",
      aud:
        token === HOSTING_TOKEN
          ? "https://git.example/api/v1"
          : "https://git.example/git",
      scope:
        token === HOSTING_TOKEN
          ? "source.git.hosting.read"
          : "source.git.smart_http.read",
      takosumi: {
        workspace_id: "workspace_a",
        capsule_id: "capsule_git",
        interface_id: "interface_git_hosting",
        interface_binding_id: "binding_1",
        interface_resolved_revision: 1,
      },
    }),
  );
}

// main:    c1 -> c2 (README modified)
// feature: c1 -> c3 (adds feature.txt)
async function richSetup() {
  const bucket = new MemoryBucket();
  const store = repositoryObjectStore(bucket, RICH_REPO);
  const c1 = await makeCommit(
    store,
    { "README.md": "v1\ncommon", "docs/guide.md": "g" },
    [],
  );
  const c2 = await makeCommit(
    store,
    { "README.md": "v1-changed\ncommon", "docs/guide.md": "g" },
    [c1],
  );
  const c3 = await makeCommit(
    store,
    { "README.md": "v1\ncommon", "docs/guide.md": "g", "feature.txt": "feat" },
    [c1],
  );
  await writeRepoRefs(bucket, RICH_REPO, {
    refs: [
      { name: "refs/heads/main", sha: c2 },
      { name: "refs/heads/feature", sha: c3 },
    ],
    defaultBranch: "main",
  });
  const env: ForgeApiEnv = {
    BUCKET: bucket,
    APP_URL: "https://git.example",
    OIDC_ISSUER_URL: "https://accounts.example",
    APP_WORKSPACE_ID: "workspace_a",
    APP_CAPSULE_ID: "capsule_git",
  };
  return { env, c1, c2, c3 };
}

async function callWith(env: ForgeApiEnv, path: string): Promise<Response> {
  const response = await handleForgeApi(
    request(path, HOSTING_TOKEN),
    env,
    richUserInfoFetch,
  );
  if (!response) throw new Error(`route was not handled: ${path}`);
  return response;
}

async function richCall(path: string): Promise<Response> {
  const { env } = await richSetup();
  return callWith(env, path);
}

describe("takos-git commit/compare/blame/history read API", () => {
  test("commit detail returns the commit and its diff vs first parent", async () => {
    const { env, c1, c2 } = await richSetup();
    const response = await callWith(
      env,
      `/api/v1/repos/${RICH_REPO}/commits/${c2}`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      commit: { sha: string };
      diff: { base: string; files: Array<{ path: string; status: string }> };
    };
    expect(body.commit.sha).toBe(c2);
    expect(body.diff.base).toBe(c1);
    const readme = body.diff.files.find((f) => f.path === "README.md");
    expect(readme).toMatchObject({ status: "modified" });
  });

  test("commit detail rejects a malformed object id", async () => {
    const response = await richCall(`/api/v1/repos/${RICH_REPO}/commits/nothex`);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_object_id" });
  });

  test("commit detail 404s an unreachable (dangling) SHA", async () => {
    const dangling = "a".repeat(40);
    const response = await richCall(
      `/api/v1/repos/${RICH_REPO}/commits/${dangling}`,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "commit_not_found" });
  });

  test("compare reports ahead/behind and the merge-base diff", async () => {
    const { env, c1 } = await richSetup();
    const response = await callWith(
      env,
      `/api/v1/repos/${RICH_REPO}/compare/main...feature`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      base: string;
      head: string;
      mergeBaseSha: string;
      aheadBy: number;
      behindBy: number;
      status: string;
      files: Array<{ path: string; status: string }>;
    };
    expect(body.base).toBe("main");
    expect(body.head).toBe("feature");
    expect(body.mergeBaseSha).toBe(c1);
    expect(body.aheadBy).toBe(1);
    expect(body.behindBy).toBe(1);
    expect(body.status).toBe("diverged");
    expect(body.files.find((f) => f.path === "feature.txt")).toMatchObject({
      status: "added",
    });
    // README.md is identical between the merge base and head — no diff entry.
    expect(body.files.find((f) => f.path === "README.md")).toBeUndefined();
  });

  test("compare 404s an unknown ref (and never resolves a raw SHA)", async () => {
    const { c2 } = await richSetup();
    const unknown = await richCall(
      `/api/v1/repos/${RICH_REPO}/compare/main...nope`,
    );
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "ref_not_found" });

    const rawSha = await richCall(
      `/api/v1/repos/${RICH_REPO}/compare/${c2}...feature`,
    );
    expect(rawSha.status).toBe(404);
    expect(await rawSha.json()).toEqual({ error: "ref_not_found" });
  });

  test("blame attributes lines by branch name", async () => {
    const { env, c1, c2 } = await richSetup();
    const response = await callWith(
      env,
      `/api/v1/repos/${RICH_REPO}/blame?ref=main&path=README.md`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      lines: Array<{ content: string; commitSha: string }>;
    };
    expect(body.lines.map((l) => [l.content, l.commitSha])).toEqual([
      ["v1-changed", c2],
      ["common", c1],
    ]);
  });

  test("blame does not resolve a raw SHA as a ref", async () => {
    const { c2 } = await richSetup();
    const response = await richCall(
      `/api/v1/repos/${RICH_REPO}/blame?ref=${c2}&path=README.md`,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "ref_not_found" });
  });

  test("commit history filters by path", async () => {
    const { env, c1, c2 } = await richSetup();
    const response = await callWith(
      env,
      `/api/v1/repos/${RICH_REPO}/commits?ref=main&path=README.md`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      commits: Array<{ sha: string; pathStatus: string }>;
    };
    expect(body.commits.map((c) => c.sha)).toEqual([c2, c1]);
    expect(body.commits[0].pathStatus).toBe("modified");
    expect(body.commits[1].pathStatus).toBe("added");

    const guideResponse = await callWith(
      env,
      `/api/v1/repos/${RICH_REPO}/commits?ref=main&path=docs/guide.md`,
    );
    const guideBody = (await guideResponse.json()) as {
      commits: Array<{ sha: string }>;
    };
    expect(guideBody.commits.map((c) => c.sha)).toEqual([c1]);
  });
});
