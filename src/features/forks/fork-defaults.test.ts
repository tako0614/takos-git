import { describe, expect, test } from "bun:test";

import { SCOPES, type RepositoryDto } from "../../contract/v1.ts";
import { readRepoRefs, writeRepoRefs } from "../../git/refs-store.ts";
import type { ObjectStoreBinding } from "../../git/types.ts";
import { RouteRegistry } from "../../router.ts";
import { registerRepoRoutes } from "../repos/routes.ts";
import { interfaceUserInfoFetch, jsonRequest, makeEnv, seedFullRepo } from "../repos/testkit.ts";
import { registerForkRoutes } from "./routes.ts";

const ROOT = "upstream/web", FORK = "devuser/web";
const userInfo = interfaceUserInfoFetch({
  taksrv_fork_defaults: { subject: "fork-defaults-owner", scope: SCOPES.hostingRead },
  taksrv_fork_outsider: { subject: "fork-defaults-outsider", scope: SCOPES.hostingRead },
});

async function fixture() {
  const handle = makeEnv(), registry = new RouteRegistry();
  registerRepoRoutes(registry); registerForkRoutes(registry);
  const source = await seedFullRepo(handle, { ownerLogin: "upstream", name: "web", visibility: "public" });
  const refs = await readRepoRefs(handle.bucket, ROOT);
  await writeRepoRefs(handle.bucket, ROOT, {
    ...refs, refs: [...refs.refs, { name: "refs/heads/next", sha: source.commitSha }],
  });
  // Model a retained advisory projection, not a newly acknowledged setting.
  await handle.db.run("UPDATE repositories SET default_branch = 'missing' WHERE id = ?", [source.repoId]);
  const request = async (method: string, path: string, body?: unknown, token = "taksrv_fork_defaults") => {
    const response = await registry.handle({ request: jsonRequest(method, path, body, token), env: handle.env, interfaceUserInfoFetch: userInfo });
    if (!response) throw Error("missing repository route");
    return response;
  };
  const create = (name = "web") => request("POST", `/api/v1/repos/${ROOT}/forks`, { owner: "devuser", name });
  const dto = async (repo: string) => {
    const response = await request("GET", `/api/v1/repos/${repo}`);
    expect(response.status).toBe(200);
    return (await response.json() as { repository: RepositoryDto }).repository;
  };
  const defaults = () => handle.db.query("SELECT storage_key,default_branch FROM repositories ORDER BY storage_key", []);
  const refsBytes = () => [...handle.bucket.store].filter(([key]) => key.startsWith("git/v2/refs/")).map(([key, value]) => [key, [...value]]);
  const traceReads = (deny: string) => {
    const reads: string[] = [], raw = handle.bucket;
    const bucket: ObjectStoreBinding = {
      get: async key => { reads.push(key); if (key === `git/v2/refs/${deny}.json`) throw Error("denied repository refs must not be read"); return raw.get(key); },
      head: key => raw.head(key), put: (key, value, options) => raw.put(key, value, options),
      delete: key => raw.delete(key), list: options => raw.list(options),
    };
    handle.env.BUCKET = bucket;
    return reads;
  };
  return { handle, request, create, dto, defaults, refsBytes, traceReads };
}

describe("fork DTO defaults follow authoritative refs", () => {
  test("new fork acknowledgement agrees with its committed refs and ordinary detail", async () => {
    const f = await fixture(), response = await f.create();
    expect(response.status).toBe(201);
    const ack = (await response.json() as { repository: RepositoryDto }).repository;
    expect({ ack: ack.defaultBranch, refs: (await readRepoRefs(f.handle.bucket, FORK)).defaultBranch, detail: (await f.dto(FORK)).defaultBranch }).toEqual({ ack: "main", refs: "main", detail: "main" });
    expect(await f.defaults()).toEqual([
      { storage_key: FORK, default_branch: "missing" }, { storage_key: ROOT, default_branch: "missing" },
    ]);
  });

  test("create ACK retains its own commit without a new refs read after another writer wins", async () => {
    const f = await fixture(), raw = f.handle.bucket;
    let committed = false, blockedReads = 0;
    const bucket: ObjectStoreBinding = {
      get: key => {
        if (committed && key === `git/v2/refs/${FORK}.json`) { blockedReads++; throw Error("post-commit refs unavailable"); }
        return raw.get(key);
      },
      head: key => raw.head(key),
      put: async (key, value, options) => {
        const written = await raw.put(key, value, options);
        if (written && key === `git/v2/refs/${FORK}.json` && value instanceof Uint8Array) {
          const doc = JSON.parse(new TextDecoder().decode(value));
          if (!committed && doc.refs.length > 0) {
            committed = true;
            await writeRepoRefs(raw, FORK, { ...doc, defaultBranch: "next" });
          }
        }
        return written;
      },
      delete: key => raw.delete(key), list: options => raw.list(options),
    };
    f.handle.env.BUCKET = bucket;
    const response = await f.create();
    const ack = await response.json() as { repository: RepositoryDto };
    expect({ status: response.status, ack: ack.repository?.defaultBranch, current: (await readRepoRefs(raw, FORK)).defaultBranch, blockedReads }).toEqual({ status: 201, ack: "main", current: "next", blockedReads: 0 });
  });

  test("fork list and network use each readable repository's current refs without rewriting projections", async () => {
    const f = await fixture();
    expect((await f.create()).status).toBe(201);
    expect((await f.create("second")).status).toBe(201);
    const second = await readRepoRefs(f.handle.bucket, "devuser/second");
    await writeRepoRefs(f.handle.bucket, "devuser/second", { ...second, defaultBranch: "next" });
    const beforeDefaults = await f.defaults(), beforeRefs = f.refsBytes();
    const listed = await f.request("GET", `/api/v1/repos/${ROOT}/forks`);
    const network = await f.request("GET", `/api/v1/repos/${FORK}/network`);
    expect([listed.status, network.status]).toEqual([200, 200]);
    const list = await listed.json() as { forks: RepositoryDto[] };
    const net = await network.json() as { root: RepositoryDto; repositories: RepositoryDto[] };
    const byName = (items: RepositoryDto[]) => Object.fromEntries(items.map(r => [r.fullName, r.defaultBranch]));
    expect({ forks: byName(list.forks), root: net.root.defaultBranch, network: byName(net.repositories) }).toEqual({
      forks: { [FORK]: "main", "devuser/second": "next" }, root: "main",
      network: { [ROOT]: "main", [FORK]: "main", "devuser/second": "next" },
    });
    expect(await f.defaults()).toEqual(beforeDefaults);
    expect(f.refsBytes()).toEqual(beforeRefs);
  });

  test("never reads refs for unreadable fork children or an unreadable network root", async () => {
    const f = await fixture();
    expect((await f.create()).status).toBe(201);
    await f.handle.db.run("UPDATE repositories SET visibility='private' WHERE storage_key=?", [FORK]);
    const childReads = f.traceReads(FORK);
    const list = await f.request("GET", `/api/v1/repos/${ROOT}/forks`, undefined, "taksrv_fork_outsider");
    const network = await f.request("GET", `/api/v1/repos/${ROOT}/network`, undefined, "taksrv_fork_outsider");
    expect([list.status, network.status]).toEqual([200, 200]);
    expect((await list.json() as { forks: RepositoryDto[] }).forks).toEqual([]);
    expect((await network.json() as { repositories: RepositoryDto[] }).repositories.map(r => r.fullName)).toEqual([ROOT]);
    expect(childReads).not.toContain(`git/v2/refs/${FORK}.json`);

    await f.handle.db.run("UPDATE repositories SET visibility='public' WHERE storage_key=?", [FORK]);
    await f.handle.db.run("UPDATE repositories SET visibility='private' WHERE storage_key=?", [ROOT]);
    const rootReads = f.traceReads(ROOT);
    const response = await f.request("GET", `/api/v1/repos/${FORK}/network`, undefined, "taksrv_fork_outsider");
    expect(response.status).toBe(200);
    const body = await response.json() as { root: RepositoryDto | null; repositories: RepositoryDto[] };
    expect(body.root).toBeNull();
    expect(body.repositories.map(r => r.fullName)).toEqual([FORK]);
    expect(rootReads).not.toContain(`git/v2/refs/${ROOT}.json`);
  });

  test("network root and its member share one observed default when a later writer changes it", async () => {
    const f = await fixture();
    expect((await f.create()).status).toBe(201);
    const raw = f.handle.bucket;
    let changed = false;
    const bucket: ObjectStoreBinding = {
      get: async key => {
        const object = await raw.get(key);
        if (!changed && key === `git/v2/refs/${ROOT}.json`) {
          changed = true;
          await writeRepoRefs(raw, ROOT, { ...await readRepoRefs(raw, ROOT), defaultBranch: "next" });
        }
        return object;
      },
      head: key => raw.head(key), put: (key, value, options) => raw.put(key, value, options),
      delete: key => raw.delete(key), list: options => raw.list(options),
    };
    f.handle.env.BUCKET = bucket;
    const response = await f.request("GET", `/api/v1/repos/${FORK}/network`);
    expect(response.status).toBe(200);
    const body = await response.json() as { root: RepositoryDto; repositories: RepositoryDto[] };
    expect({ root: body.root.defaultBranch, member: body.repositories.find(r => r.fullName === ROOT)?.defaultBranch }).toEqual({ root: "main", member: "main" });
    expect((await readRepoRefs(raw, ROOT)).defaultBranch).toBe("next");
  });

  test("keeps the configured default for an empty repository and its fork", async () => {
    const f = await fixture();
    await writeRepoRefs(f.handle.bucket, ROOT, { refs: [], defaultBranch: null });
    await f.handle.db.run("UPDATE repositories SET default_branch='trunk' WHERE storage_key=?", [ROOT]);
    const response = await f.create();
    expect(response.status).toBe(201);
    expect((await response.json() as { repository: RepositoryDto }).repository.defaultBranch).toBe("trunk");
    const network = await f.request("GET", `/api/v1/repos/${FORK}/network`);
    expect(network.status).toBe(200);
    const body = await network.json() as { root: RepositoryDto; repositories: RepositoryDto[] };
    expect(body.root.defaultBranch).toBe("trunk");
    expect(body.repositories.map(r => r.defaultBranch)).toEqual(["trunk", "trunk"]);
  });
});
