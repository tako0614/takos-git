import { describe, expect, test } from "bun:test";

import { RouteRegistry, type RouterEnv } from "../../router.ts";
import { registerReleaseRoutes } from "./routes.ts";
import {
  get,
  interfaceUserInfoFetch,
  jsonRequest,
  makeEnv,
  seedFullRepo,
  seedPrincipal,
  type TestEnvHandle,
} from "../repos/testkit.ts";
import type { OAuthFetch } from "../../browser-auth.ts";

const tokens = interfaceUserInfoFetch({
  taksrv_alice_w: { scope: "source.git.hosting.write", subject: "sub-alice" },
  taksrv_alice_r: { scope: "source.git.hosting.read", subject: "sub-alice" },
  taksrv_bob_r: { scope: "source.git.hosting.read", subject: "sub-bob" },
  taksrv_bob_w: { scope: "source.git.hosting.write", subject: "sub-bob" },
});

function router(): RouteRegistry {
  const reg = new RouteRegistry();
  registerReleaseRoutes(reg);
  return reg;
}

async function dispatch(
  reg: RouteRegistry,
  request: Request,
  env: RouterEnv,
  fetchMock: OAuthFetch = tokens,
): Promise<Response> {
  const res = await reg.handle({ request, env, interfaceUserInfoFetch: fetchMock });
  if (!res) throw new Error(`route not handled: ${request.method} ${request.url}`);
  return res;
}

/** Seed a public repo owned by principal `sub-alice`, returning the commit sha. */
async function seedOwned(
  handle: TestEnvHandle,
  visibility: "public" | "private" = "public",
): Promise<string> {
  const alice = await seedPrincipal(handle.db, "sub-alice");
  const seeded = await seedFullRepo(handle, {
    ownerLogin: "alice",
    ownerType: "user",
    ownerPrincipalId: alice,
    name: "web",
    visibility,
    file: "README.md",
    content: "# hi\n",
  });
  return seeded.commitSha;
}

const RR = "/api/v1/repos/alice/web";

describe("releases CRUD", () => {
  test("create published release materializes the tag ref + emits release.published", async () => {
    const handle = makeEnv();
    const reg = router();
    const commit = await seedOwned(handle);

    const res = await dispatch(
      reg,
      jsonRequest("POST", `${RR}/releases`, { tag: "v1.0.0", target: "main", body: "notes" }, "taksrv_alice_w"),
      handle.env,
    );
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.release).toMatchObject({
      tag: "v1.0.0",
      targetSha: commit,
      isDraft: false,
      name: "v1.0.0",
      body: "notes",
    });
    expect(created.event).toMatchObject({ event: "release.published", repo: "alice/web" });

    // Tag ref now exists in the authoritative R2 refs doc.
    const tagList = await dispatch(reg, get(`${RR}/tags`, "taksrv_alice_r"), handle.env);
    const tags = (await tagList.json()).tags;
    expect(tags.map((t: { name: string }) => t.name)).toContain("v1.0.0");
  });

  test("duplicate tag conflicts", async () => {
    const handle = makeEnv();
    const reg = router();
    await seedOwned(handle);
    const body = { tag: "v1", target: "main" };
    expect((await dispatch(reg, jsonRequest("POST", `${RR}/releases`, body, "taksrv_alice_w"), handle.env)).status).toBe(201);
    const dup = await dispatch(reg, jsonRequest("POST", `${RR}/releases`, body, "taksrv_alice_w"), handle.env);
    expect(dup.status).toBe(409);
  });

  test("published release with neither existing tag nor target is rejected", async () => {
    const handle = makeEnv();
    const reg = router();
    await seedOwned(handle);
    const res = await dispatch(reg, jsonRequest("POST", `${RR}/releases`, { tag: "v9" }, "taksrv_alice_w"), handle.env);
    expect(res.status).toBe(422);
  });

  test("draft is created without a tag ref, then publish materializes it", async () => {
    const handle = makeEnv();
    const reg = router();
    await seedOwned(handle);

    const draft = await dispatch(
      reg,
      jsonRequest("POST", `${RR}/releases`, { tag: "v2", target: "main", is_draft: true }, "taksrv_alice_w"),
      handle.env,
    );
    expect(draft.status).toBe(201);
    expect((await draft.json()).event).toBeUndefined();

    // Tag ref absent while draft.
    let tags = (await (await dispatch(reg, get(`${RR}/tags`, "taksrv_alice_r"), handle.env)).json()).tags;
    expect(tags.map((t: { name: string }) => t.name)).not.toContain("v2");

    const publish = await dispatch(
      reg,
      jsonRequest("PATCH", `${RR}/releases/v2`, { is_draft: false }, "taksrv_alice_w"),
      handle.env,
    );
    expect(publish.status).toBe(200);
    const published = await publish.json();
    expect(published.release.isDraft).toBe(false);
    expect(published.release.publishedAt).not.toBeNull();
    expect(published.event).toMatchObject({ event: "release.published" });

    tags = (await (await dispatch(reg, get(`${RR}/tags`, "taksrv_alice_r"), handle.env)).json()).tags;
    expect(tags.map((t: { name: string }) => t.name)).toContain("v2");
  });

  test("draft release hidden from a reader, visible to writer; latest ignores drafts", async () => {
    const handle = makeEnv();
    const reg = router();
    await seedOwned(handle);
    await dispatch(reg, jsonRequest("POST", `${RR}/releases`, { tag: "d1", target: "main", is_draft: true }, "taksrv_alice_w"), handle.env);

    // reader cannot see the draft by tag.
    const asReader = await dispatch(reg, get(`${RR}/releases/d1`, "taksrv_bob_r"), handle.env);
    expect(asReader.status).toBe(404);
    // writer can.
    const asWriter = await dispatch(reg, get(`${RR}/releases/d1`, "taksrv_alice_r"), handle.env);
    expect(asWriter.status).toBe(200);

    // latest has no published release yet.
    const latest = await dispatch(reg, get(`${RR}/releases/latest`, "taksrv_alice_r"), handle.env);
    expect(latest.status).toBe(404);
  });

  test("edit and delete a release", async () => {
    const handle = makeEnv();
    const reg = router();
    await seedOwned(handle);
    await dispatch(reg, jsonRequest("POST", `${RR}/releases`, { tag: "v3", target: "main" }, "taksrv_alice_w"), handle.env);

    const patch = await dispatch(reg, jsonRequest("PATCH", `${RR}/releases/v3`, { name: "Third", is_prerelease: true }, "taksrv_alice_w"), handle.env);
    expect(patch.status).toBe(200);
    expect((await patch.json()).release).toMatchObject({ name: "Third", isPrerelease: true });

    const del = await dispatch(reg, jsonRequest("DELETE", `${RR}/releases/v3`, undefined, "taksrv_alice_w"), handle.env);
    expect(del.status).toBe(200);
    const gone = await dispatch(reg, get(`${RR}/releases/v3`, "taksrv_alice_r"), handle.env);
    expect(gone.status).toBe(404);
  });
});

describe("releases authorization", () => {
  test("anonymous can read a public repo's releases but cannot create", async () => {
    const handle = makeEnv();
    const reg = router();
    await seedOwned(handle);
    await dispatch(reg, jsonRequest("POST", `${RR}/releases`, { tag: "v1", target: "main" }, "taksrv_alice_w"), handle.env);

    const list = await dispatch(reg, get(`${RR}/releases`), handle.env);
    expect(list.status).toBe(200);
    expect((await list.json()).releases).toHaveLength(1);

    const create = await dispatch(reg, jsonRequest("POST", `${RR}/releases`, { tag: "x", target: "main" }), handle.env);
    expect(create.status).toBe(401);
  });

  test("a reader (insufficient role) gets 403 on create", async () => {
    const handle = makeEnv();
    const reg = router();
    await seedOwned(handle);
    const res = await dispatch(reg, jsonRequest("POST", `${RR}/releases`, { tag: "x", target: "main" }, "taksrv_bob_w"), handle.env);
    expect(res.status).toBe(403);
  });

  test("private repo returns 404 to anonymous (non-disclosure)", async () => {
    const handle = makeEnv();
    const reg = router();
    await seedOwned(handle, "private");
    const res = await dispatch(reg, get(`${RR}/releases`), handle.env);
    expect(res.status).toBe(404);
  });
});
