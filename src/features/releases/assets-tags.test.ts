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
  TEST_APP_URL,
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

async function seedOwned(handle: TestEnvHandle): Promise<void> {
  const alice = await seedPrincipal(handle.db, "sub-alice");
  await seedFullRepo(handle, {
    ownerLogin: "alice",
    ownerType: "user",
    ownerPrincipalId: alice,
    name: "web",
    visibility: "public",
    file: "README.md",
    content: "# hi\n",
  });
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const RR = "/api/v1/repos/alice/web";

function multipartUpload(path: string, name: string, bytes: Uint8Array, token: string): Request {
  const form = new FormData();
  form.set("file", new File([bytes], name, { type: "application/octet-stream" }));
  return new Request(`${TEST_APP_URL}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
}

describe("release assets", () => {
  test("upload → list → download (checksum + bytes) → delete", async () => {
    const handle = makeEnv();
    const reg = router();
    await seedOwned(handle);
    await dispatch(reg, jsonRequest("POST", `${RR}/releases`, { tag: "v1", target: "main" }, "taksrv_alice_w"), handle.env);

    const bytes = new TextEncoder().encode("hello asset payload");
    const upload = await dispatch(
      reg,
      multipartUpload(`${RR}/releases/v1/assets`, "artifact.zip", bytes, "taksrv_alice_w"),
      handle.env,
    );
    expect(upload.status).toBe(201);
    const asset = (await upload.json()).asset;
    expect(asset).toMatchObject({ name: "artifact.zip", contentType: "application/zip", size: bytes.byteLength });
    expect(asset.checksumSha256).toBe(await sha256Hex(bytes));

    const list = await dispatch(reg, get(`${RR}/releases/v1/assets`, "taksrv_alice_r"), handle.env);
    expect((await list.json()).assets).toHaveLength(1);

    const download = await dispatch(reg, get(`${RR}/releases/v1/assets/${asset.id}/download`, "taksrv_bob_r"), handle.env);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/zip");
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);

    // download count incremented.
    const relist = await dispatch(reg, get(`${RR}/releases/v1/assets`, "taksrv_alice_r"), handle.env);
    expect((await relist.json()).assets[0].downloadCount).toBe(1);

    const del = await dispatch(reg, jsonRequest("DELETE", `${RR}/releases/assets/${asset.id}`, undefined, "taksrv_alice_w"), handle.env);
    expect(del.status).toBe(200);
    const gone = await dispatch(reg, get(`${RR}/releases/v1/assets`, "taksrv_alice_r"), handle.env);
    expect((await gone.json()).assets).toHaveLength(0);
  });

  test("duplicate asset name conflicts", async () => {
    const handle = makeEnv();
    const reg = router();
    await seedOwned(handle);
    await dispatch(reg, jsonRequest("POST", `${RR}/releases`, { tag: "v1", target: "main" }, "taksrv_alice_w"), handle.env);
    const bytes = new TextEncoder().encode("x");
    expect((await dispatch(reg, multipartUpload(`${RR}/releases/v1/assets`, "a.bin", bytes, "taksrv_alice_w"), handle.env)).status).toBe(201);
    expect((await dispatch(reg, multipartUpload(`${RR}/releases/v1/assets`, "a.bin", bytes, "taksrv_alice_w"), handle.env)).status).toBe(409);
  });

  test("reader cannot upload an asset", async () => {
    const handle = makeEnv();
    const reg = router();
    await seedOwned(handle);
    await dispatch(reg, jsonRequest("POST", `${RR}/releases`, { tag: "v1", target: "main" }, "taksrv_alice_w"), handle.env);
    const res = await dispatch(reg, multipartUpload(`${RR}/releases/v1/assets`, "a.bin", new TextEncoder().encode("x"), "taksrv_bob_w"), handle.env);
    expect(res.status).toBe(403);
  });
});

describe("git tags", () => {
  test("lightweight tag create + list + delete", async () => {
    const handle = makeEnv();
    const reg = router();
    await seedOwned(handle);

    const create = await dispatch(reg, jsonRequest("POST", `${RR}/tags`, { name: "rc1", target: "main" }, "taksrv_alice_w"), handle.env);
    expect(create.status).toBe(201);
    const tag = (await create.json()).tag;
    expect(tag).toMatchObject({ name: "rc1", annotated: false });
    expect(tag.commitSha).toBe(tag.sha); // lightweight: ref points straight at the commit

    const list = await dispatch(reg, get(`${RR}/tags`, "taksrv_alice_r"), handle.env);
    expect((await list.json()).tags.map((t: { name: string }) => t.name)).toContain("rc1");

    const del = await dispatch(reg, jsonRequest("DELETE", `${RR}/tags/rc1`, undefined, "taksrv_alice_w"), handle.env);
    expect(del.status).toBe(200);
    const after = await dispatch(reg, get(`${RR}/tags`, "taksrv_alice_r"), handle.env);
    expect((await after.json()).tags.map((t: { name: string }) => t.name)).not.toContain("rc1");
  });

  test("annotated tag stores a tag object + metadata, peels to the commit", async () => {
    const handle = makeEnv();
    const reg = router();
    await seedOwned(handle);

    const create = await dispatch(
      reg,
      jsonRequest("POST", `${RR}/tags`, { name: "v1.0", target: "main", message: "first cut", annotated: true }, "taksrv_alice_w"),
      handle.env,
    );
    expect(create.status).toBe(201);
    const tag = (await create.json()).tag;
    expect(tag.annotated).toBe(true);
    expect(tag.message).toBe("first cut");
    // ref points at the tag object, which peels to the commit (so they differ).
    expect(tag.sha).not.toBe(tag.commitSha);
    expect(tag.commitSha).toMatch(/^[0-9a-f]{40}$/u);

    const list = await dispatch(reg, get(`${RR}/tags`, "taksrv_alice_r"), handle.env);
    const listed = (await list.json()).tags.find((t: { name: string }) => t.name === "v1.0");
    expect(listed).toMatchObject({ annotated: true, message: "first cut", commitSha: tag.commitSha });
    expect(listed.tagger).not.toBeNull();
  });

  test("invalid target is rejected; duplicate tag conflicts; reader cannot create", async () => {
    const handle = makeEnv();
    const reg = router();
    await seedOwned(handle);
    expect((await dispatch(reg, jsonRequest("POST", `${RR}/tags`, { name: "z", target: "nope" }, "taksrv_alice_w"), handle.env)).status).toBe(422);
    expect((await dispatch(reg, jsonRequest("POST", `${RR}/tags`, { name: "z", target: "main" }, "taksrv_alice_w"), handle.env)).status).toBe(201);
    expect((await dispatch(reg, jsonRequest("POST", `${RR}/tags`, { name: "z", target: "main" }, "taksrv_alice_w"), handle.env)).status).toBe(409);
    expect((await dispatch(reg, jsonRequest("POST", `${RR}/tags`, { name: "y", target: "main" }, "taksrv_bob_w"), handle.env)).status).toBe(403);
  });
});
