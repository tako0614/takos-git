import { afterEach, expect, test } from "bun:test";
import { reposApi } from "../../../web/src/api/repos.ts";
import { ApiError } from "../../../web/src/api/client.ts";
import { RouteRegistry } from "../../router.ts";
import { putBlob, putCommit } from "../../git/object-store.ts";
import { buildTreeFromPaths } from "../../git/tree-ops.ts";
import { repositoryObjectStore } from "../../git/repo-object-store.ts";
import { writeRepoRefs } from "../../git/refs-store.ts";
import { registerRepoRoutes } from "./routes.ts";
import { makeEnv, seedFullRepo, type TestEnvHandle } from "./testkit.ts";

const originalFetch = globalThis.fetch;
const handles: TestEnvHandle[] = [];
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const h of handles.splice(0)) h.fake.db.close();
});

async function fixture(visibility: "public" | "private" = "public") {
  const h = makeEnv(); handles.push(h);
  const base = await seedFullRepo(h, { ownerLogin: "acme", name: "web", visibility, file: "file.txt", content: "base\n", message: "base" });
  const objects = repositoryObjectStore(h.env.BUCKET, base.storageKey);
  const sig = { name: "Fixture", email: "fixture@example.test", timestamp: 1700000000, tzOffset: "+0000" };
  async function commit(content: string, parents: string[], message: string): Promise<string> {
    const blob = await putBlob(objects, new TextEncoder().encode(content));
    const tree = await buildTreeFromPaths(objects, [{ path: "file.txt", sha: blob, mode: "100644" }]);
    return putCommit(objects, { tree, parents, author: sig, committer: sig, message });
  }
  const topic = await commit("topic\n", [base.commitSha], "topic");
  const sibling = await commit("sibling\n", [base.commitSha], "sibling");
  const orphan = await commit("unrelated\n", [], "unrelated");
  await writeRepoRefs(h.env.BUCKET, base.storageKey, { defaultBranch: "main", refs: [
    { name: "refs/heads/main", sha: base.commitSha }, { name: "refs/heads/topic", sha: topic },
    { name: "refs/heads/feature/topic", sha: topic }, { name: "refs/heads/sibling", sha: sibling }, { name: "refs/heads/orphan", sha: orphan },
  ] });
  const reg = new RouteRegistry(); registerRepoRoutes(reg);
  const requests: { method: string; path: string; authorization: boolean; body: BodyInit | null | undefined }[] = [];
  const responses: { status: number; body: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "https://git.example");
    expect(url.origin).toBe("https://git.example");
    requests.push({ method: init?.method ?? "GET", path: url.pathname, authorization: new Headers(init?.headers).has("authorization"), body: init?.body });
    const response = await reg.handle({ request: new Request(url, init), env: h.env });
    if (!response) throw new Error("Actual owning compare route did not match " + url.pathname);
    responses.push({ status: response.status, body: await response.clone().json() as Record<string, unknown> });
    return response;
  }) as typeof fetch;
  return { base: base.commitSha, requests, responses };
}

for (const [spec, status, ahead, behind, files] of [
  ["main...topic", "ahead", 1, 0, 1],
  ["topic...main", "behind", 0, 1, 0],
  ["main...main", "identical", 0, 0, 0],
  ["sibling...topic", "diverged", 1, 1, 1],
] as const) test(`actual compare client preserves ${status} counts and the Worker diff`, async () => {
  const f = await fixture(); const data = await reposApi.compare("acme", "web", spec);
  const wire = f.responses[0]!; expect(wire.status).toBe(200);
  expect(wire.body).toMatchObject({ status, aheadBy: ahead, behindBy: behind });
  expect(data).toMatchObject({ status, ahead, behind });
  expect(data.diff.base).toBe(f.base); expect(data.diff.files).toEqual(wire.body.files); expect(data.diff.files).toHaveLength(files);
  if (files) expect(data.diff.files[0]!.hunks![0]!.lines.some(line => line.content === "topic")).toBe(true);
  expect(f.requests).toEqual([{ method: "GET", path: `/api/v1/repos/acme/web/compare/${spec}`, authorization: false, body: undefined }]);
});

test("unrelated histories retain the actual base fallback without inventing a merge base", async () => {
  const f = await fixture(); const data = await reposApi.compare("acme", "web", "main...orphan");
  expect(f.responses[0]!.status).toBe(200); expect(f.responses[0]!.body.hasMergeBase).toBe(false);
  expect(data.mergeBaseSha).toBeNull(); expect(data.diff.base).toBe(f.base);
  expect(data.diff.files).toEqual(f.responses[0]!.body.files);
  expect(data.diff.files[0]!.hunks![0]!.lines.some(line => line.content === "unrelated")).toBe(true);
});

test("a slash in a real branch name stays one literal compare route segment", async () => {
  const f = await fixture(); const data = await reposApi.compare("acme", "web", "main...feature/topic");
  expect(data).toMatchObject({ status: "ahead", ahead: 1, behind: 0 });
  expect(data.diff.files).toEqual(f.responses[0]!.body.files);
  expect(f.requests[0]!.path).toBe("/api/v1/repos/acme/web/compare/main...feature%2Ftopic");
});

for (const [spec, status] of [["missing...topic", 404], ["main", 400]] as const) test(`actual ${status} compare refusal keeps its API error and has no write`, async () => {
  const f = await fixture(); let failure: unknown;
  try { await reposApi.compare("acme", "web", spec); } catch (err) { failure = err; }
  expect(failure).toBeInstanceOf(ApiError); expect((failure as ApiError).status).toBe(status);
  expect(f.responses[0]!.status).toBe(status); expect(f.requests).toHaveLength(1); expect(f.requests[0]!.method).toBe("GET");
});

test("a private repo remains hidden from an anonymous compare client", async () => {
  const f = await fixture("private");
  await expect(reposApi.compare("acme", "web", "main...topic")).rejects.toMatchObject({ status: 404 });
  expect(f.responses[0]!.status).toBe(404); expect(f.requests).toHaveLength(1); expect(f.requests[0]!.method).toBe("GET");
});
