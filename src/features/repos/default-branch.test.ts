import { describe, expect, test } from "bun:test";

import { RouteRegistry } from "../../router.ts";
import { MemoryBucket } from "../../test-bucket.ts";
import { seedRepo } from "../../seed.ts";
import { handleInfoRefs, handleReceivePack } from "../../smart-http.ts";
import { concatBytes } from "../../git/sha1.ts";
import { PKT_FLUSH, pktLineString } from "../../git/pack-common.ts";
import { readRepoRefsSnapshot, writeRepoRefs } from "../../git/refs-store.ts";
import { registerRepoRoutes } from "./routes.ts";
import { get, interfaceUserInfoFetch, jsonRequest, makeEnv } from "./testkit.ts";

const REPO = "alice/defaults";
const URL = `/api/v1/repos/${REPO}`;
const ADMIN = "taksrv_default_admin", READ = "taksrv_default_read";
const tokens = interfaceUserInfoFetch({
  [ADMIN]: { scope: "source.git.hosting.admin", subject: "default-owner" },
  [READ]: { scope: "source.git.hosting.read", subject: "default-owner" },
  taksrv_default_create: { scope: "source.git.hosting.write", subject: "default-owner" },
});

class ObservedBucket extends MemoryBucket {
  beforeRefsPut?: () => void | Promise<void>;
  afterRefsPut?: () => void | Promise<void>;

  override async put(...args: Parameters<MemoryBucket["put"]>) {
    if (args[0].startsWith("git/v2/refs/") && this.beforeRefsPut) {
      const observe = this.beforeRefsPut;
      this.beforeRefsPut = undefined;
      await observe();
    }
    const result = await super.put(...args);
    if (result && args[0].startsWith("git/v2/refs/") && this.afterRefsPut) {
      const observe = this.afterRefsPut;
      this.afterRefsPut = undefined;
      await observe();
    }
    return result;
  }
}

async function fixture(empty = false) {
  const handle = makeEnv(), bucket = new ObservedBucket();
  const env = { ...handle.env, BUCKET: bucket };
  const registry = new RouteRegistry();
  registerRepoRoutes(registry);
  const dispatch = async (request: Request) => {
    const response = await registry.handle({ request, env, interfaceUserInfoFetch: tokens });
    if (!response) throw Error("route not handled");
    return response;
  };
  const created = await dispatch(jsonRequest("POST", "/api/v1/repos", {
    owner: "alice", name: "defaults", defaultBranch: "main",
  }, "taksrv_default_create"));
  expect(created.status).toBe(201);
  const patch = (body: Record<string, unknown>, token = ADMIN) =>
    dispatch(jsonRequest("PATCH", URL, body, token));
  const metadata = () => handle.db.queryOne<{ default_branch: string; description: string | null }>(
    "SELECT default_branch,description FROM repositories WHERE storage_key=?", [REPO],
  );
  if (!empty) {
    const main = await seedRepo(bucket, { repo: REPO, content: "main body\n" });
    const next = await seedRepo(bucket, { repo: REPO, branch: "next", content: "next body\n" });
    await writeRepoRefs(bucket, REPO, { defaultBranch: "main", refs: [
      { name: "refs/heads/main", sha: main.commitSha },
      { name: "refs/heads/next", sha: next.commitSha },
    ] });
  }
  return { ...handle, env, bucket, dispatch, patch, metadata };
}

function stored(bucket: MemoryBucket) {
  return [...bucket.store].map(([key, bytes]) => [key, [...bytes], bucket.etags.get(key)]);
}

async function defaults(fx: Awaited<ReturnType<typeof fixture>>, branch: string) {
  const detail = await fx.dispatch(get(URL, READ));
  expect(detail.status).toBe(200);
  expect((await detail.json()).repository.defaultBranch).toBe(branch);
  const list = await fx.dispatch(get("/api/v1/repos", READ));
  expect(list.status).toBe(200);
  expect((await list.json()).repositories[0].defaultBranch).toBe(branch);
  const code = await fx.dispatch(get(`${URL}/commits?limit=1`, READ));
  expect(code.status).toBe(200);
  expect((await code.json()).branch).toBe(branch);
}

describe("repository default branch is an authoritative refs setting", () => {
  test("settings ACK, metadata, code default and clone HEAD select the same existing branch", async () => {
    const fx = await fixture();
    const before = (await readRepoRefsSnapshot(fx.bucket, REPO))!;
    const response = await fx.patch({ defaultBranch: "next", description: "changed" });
    expect(response.status).toBe(200);
    expect((await response.json()).repository).toMatchObject({ defaultBranch: "next", description: "changed" });
    const after = (await readRepoRefsSnapshot(fx.bucket, REPO))!;
    expect(after.doc.defaultBranch).toBe("next");
    expect(after.doc.refs).toEqual(before.doc.refs);
    expect(after.etag).not.toBe(before.etag);
    expect(await fx.metadata()).toEqual({ default_branch: "next", description: "changed" });
    await defaults(fx, "next");
    const advertisement = await handleInfoRefs(fx.bucket, REPO, "git-upload-pack");
    expect(await advertisement.text()).toContain("symref=HEAD:refs/heads/next");
  });

  test("a missing branch rejects every requested settings change", async () => {
    const fx = await fixture();
    const before = stored(fx.bucket), metadata = await fx.metadata();
    const response = await fx.patch({ defaultBranch: "missing", description: "must not save" });
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("branch_not_found");
    expect(stored(fx.bucket)).toEqual(before);
    expect(await fx.metadata()).toEqual(metadata);
  });

  test("read scope cannot change the default or other metadata", async () => {
    const fx = await fixture();
    const before = stored(fx.bucket), metadata = await fx.metadata();
    const response = await fx.patch({ defaultBranch: "next", description: "denied" }, READ);
    expect(response.status).toBe(401);
    expect(stored(fx.bucket)).toEqual(before);
    expect(await fx.metadata()).toEqual(metadata);
  });

  test("a racing ref writer wins the CAS without a D1 settings update", async () => {
    const fx = await fixture();
    let concurrent: ReturnType<typeof stored> | undefined;
    fx.bucket.beforeRefsPut = async () => {
      const current = (await readRepoRefsSnapshot(fx.bucket, REPO))!;
      await writeRepoRefs(fx.bucket, REPO, {
        ...current.doc,
        refs: [...current.doc.refs, { name: "refs/heads/other", sha: current.doc.refs[0].sha }],
      }, current.etag);
      concurrent = stored(fx.bucket);
    };
    const response = await fx.patch({ defaultBranch: "next", description: "not committed" });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("ref_update_conflict");
    expect(concurrent).toBeDefined();
    expect(stored(fx.bucket)).toEqual(concurrent!);
    expect(await fx.metadata()).toEqual({ default_branch: "main", description: null });
  });

  test("a failed D1 projection reports pending, reads R2 and permits an explicit retry", async () => {
    const fx = await fixture();
    await fx.db.run("CREATE TRIGGER reject_default_projection BEFORE UPDATE OF default_branch ON repositories BEGIN SELECT RAISE(ABORT, 'projection unavailable'); END");
    const response = await fx.patch({ defaultBranch: "next" });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ repository: { defaultBranch: "next" }, metadata_pending: true });
    expect(await fx.metadata()).toEqual({ default_branch: "main", description: null });
    await defaults(fx, "next");
    await fx.db.run("DROP TRIGGER reject_default_projection");
    const retried = await fx.patch({ defaultBranch: "next" });
    expect(retried.status).toBe(200);
    expect((await retried.json()).metadata_pending).toBeUndefined();
    expect(await fx.metadata()).toEqual({ default_branch: "next", description: null });
  });

  test("lost R2 ACK never updates D1; actual reads and explicit retry recover", async () => {
    const fx = await fixture();
    const lost = Error("refs ACK lost");
    fx.bucket.afterRefsPut = () => { throw lost; };
    await expect(fx.patch({ defaultBranch: "next" })).rejects.toBe(lost);
    expect(await fx.metadata()).toEqual({ default_branch: "main", description: null });
    await defaults(fx, "next");
    expect((await fx.patch({ defaultBranch: "next" })).status).toBe(200);
    expect(await fx.metadata()).toEqual({ default_branch: "next", description: null });
  });

  test("a delayed older metadata projection cannot change newer authoritative readback", async () => {
    const fx = await fixture();
    fx.bucket.afterRefsPut = async () => {
      const later = await fx.patch({ defaultBranch: "main" });
      expect(later.status).toBe(200);
    };
    const earlier = await fx.patch({ defaultBranch: "next" });
    expect(earlier.status).toBe(200);
    expect((await earlier.json()).repository.defaultBranch).toBe("next");
    // The older D1 follow-up may finish last; R2 remains authoritative.
    expect(await fx.metadata()).toEqual({ default_branch: "next", description: null });
    await defaults(fx, "main");
  });

  test("deleting the selected branch uses the remaining default even with stale D1", async () => {
    const fx = await fixture();
    expect((await fx.patch({ defaultBranch: "next" })).status).toBe(200);
    const refs = (await readRepoRefsSnapshot(fx.bucket, REPO))!.doc;
    const sha = refs.refs.find(ref => ref.name === "refs/heads/next")!.sha;
    const deletion = await handleReceivePack(fx.bucket, REPO, concatBytes(
      pktLineString(`${sha} ${"0".repeat(40)} refs/heads/next\0report-status\n`), PKT_FLUSH,
    ));
    expect(await deletion.text()).toContain("ok refs/heads/next");
    expect(await fx.metadata()).toEqual({ default_branch: "next", description: null });
    await defaults(fx, "main");
    const updated = await fx.patch({ description: "metadata only" });
    expect(updated.status).toBe(200);
    expect((await updated.json()).repository).toMatchObject({ defaultBranch: "main", description: "metadata only" });
  });

  test("an empty repository retains its configured default in read DTOs", async () => {
    const fx = await fixture(true);
    const detail = await fx.dispatch(get(URL, READ));
    expect((await detail.json()).repository.defaultBranch).toBe("main");
    const list = await fx.dispatch(get("/api/v1/repos", READ));
    expect((await list.json()).repositories[0].defaultBranch).toBe("main");
    expect((await fx.patch({ defaultBranch: "missing" })).status).toBe(404);
  });
});
