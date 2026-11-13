import { describe, expect, test } from "bun:test";

import { SCOPES } from "../../contract/v1.ts";
import { getCommitData, getObject, putCommit } from "../../git/object-store.ts";
import { readRepoRefs, writeRepoRefs } from "../../git/refs-store.ts";
import { repositoryObjectStore } from "../../git/repo-object-store.ts";
import { createSingleFileTree } from "../../git/tree-ops.ts";
import type { ObjectStoreBinding } from "../../git/types.ts";
import { RouteRegistry } from "../../router.ts";
import { interfaceUserInfoFetch, jsonRequest, makeEnv, seedFullRepo } from "../repos/testkit.ts";
import { writeAnnotatedTag } from "../releases/git-tags.ts";
import { registerForkRoutes } from "./routes.ts";

const SOURCE = "upstream/web", FORK = "devuser/web";
const signature = { name: "Fixture", email: "fixture@example.test", timestamp: 1_700_000_000, tzOffset: "+0000" };
const userInfo = interfaceUserInfoFetch({
  taksrv_fork_snapshot: { subject: "fork-snapshot-reader", scope: SCOPES.hostingRead },
});

async function fixture() {
  const handle = makeEnv(), registry = new RouteRegistry();
  registerForkRoutes(registry);
  const source = await seedFullRepo(handle, { ownerLogin: "upstream", name: "web", visibility: "public" });
  const commit = async (body: string, parents: string[] = []) => {
    const store = repositoryObjectStore(handle.bucket, SOURCE);
    const tree = await createSingleFileTree(store, "README.md", new TextEncoder().encode(body));
    return putCommit(store, { tree, parents, author: signature, committer: signature, message: body });
  };
  const create = async () => {
    const response = await registry.handle({
      request: jsonRequest("POST", `/api/v1/repos/${SOURCE}/forks`, { owner: "devuser" }, "taksrv_fork_snapshot"),
      env: handle.env, interfaceUserInfoFetch: userInfo,
    });
    if (!response) throw Error("missing initial-fork route");
    return response;
  };
  return { handle, source, commit, create };
}

describe("initial fork object/ref snapshot", () => {
  test("keeps the selected source snapshot when its refs advance during object copy", async () => {
    const f = await fixture(), raw = f.handle.bucket;
    const selected = await readRepoRefs(raw, SOURCE);
    let moved = false, laterCommit = "";
    const bucket: ObjectStoreBinding = {
      get: key => raw.get(key), head: key => raw.head(key),
      put: async (key, body, options) => {
        if (!moved && key.startsWith(`git/v3/repos/${FORK}/`)) {
          moved = true;
          laterCommit = await f.commit("later source change", [f.source.commitSha]);
          await writeRepoRefs(raw, SOURCE, {
            refs: [{ name: "refs/heads/next", sha: laterCommit }], defaultBranch: "next",
          });
        }
        return raw.put(key, body, options);
      },
      delete: key => raw.delete(key), list: options => raw.list(options),
    };
    f.handle.env.BUCKET = bucket;
    const response = await f.create();
    expect(response.status).toBe(201);
    expect(moved).toBe(true);
    expect((await response.json()).repository.defaultBranch).toBe("main");
    expect(await readRepoRefs(raw, FORK)).toEqual(selected);
    expect((await readRepoRefs(raw, SOURCE)).defaultBranch).toBe("next");
    const forkObjects = repositoryObjectStore(raw, FORK);
    expect(await getCommitData(forkObjects, f.source.commitSha)).not.toBeNull();
    expect(await getCommitData(forkObjects, laterCommit)).toBeNull();
    const fork = await f.handle.db.queryOne<{ id: string }>("SELECT id FROM repositories WHERE storage_key = ?", [FORK]);
    expect(await f.handle.db.query("SELECT name, target_sha, is_default FROM ref_index WHERE repo_id = ?", [fork!.id]))
      .toEqual([{ name: "refs/heads/main", target_sha: f.source.commitSha, is_default: 1 }]);
  });

  test("copies an advertised annotated-tag closure and excludes unrelated objects", async () => {
    const f = await fixture();
    const tagged = await f.commit("tagged history", [f.source.commitSha]);
    const unrelated = await f.commit("unselected history");
    const sourceObjects = repositoryObjectStore(f.handle.bucket, SOURCE);
    const tag = await writeAnnotatedTag(sourceObjects, {
      targetSha: tagged, targetType: "commit", tagName: "release-candidate",
      tagger: signature, message: "selected tag",
    });
    const selected = { refs: [{ name: "refs/tags/release-candidate", sha: tag }], defaultBranch: null };
    await writeRepoRefs(f.handle.bucket, SOURCE, selected);
    const response = await f.create();
    expect(response.status).toBe(201);
    expect((await readRepoRefs(f.handle.bucket, FORK)).refs).toEqual(selected.refs);
    const forkObjects = repositoryObjectStore(f.handle.bucket, FORK);
    expect((await getObject(forkObjects, tag))?.type).toBe("tag");
    const commit = await getCommitData(forkObjects, tagged);
    expect(commit).not.toBeNull();
    expect(await getObject(forkObjects, commit!.tree)).not.toBeNull();
    expect(await getCommitData(forkObjects, f.source.commitSha)).not.toBeNull();
    expect(await getCommitData(forkObjects, unrelated)).toBeNull();
    expect(await getCommitData(sourceObjects, unrelated)).not.toBeNull();
  });
});
