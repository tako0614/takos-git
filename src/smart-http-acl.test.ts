/**
 * Per-repo ACL on the Git smart-HTTP surface (worker.ts + smart-http.ts).
 *
 * These prove the D1-backed layer that runs AFTER the exact smart_http scope
 * gate: a private repo is a 404 to a stranger (non-disclosure) but clonable by a
 * collaborator, a push needs the writer role even with a write-scoped token, and a
 * protected branch rejects a non-permitted direct push BEFORE the R2 CAS. The
 * DB-less scope-only path is covered by `worker.test.ts` / `git-clone.test.ts`.
 */

import { describe, expect, test } from "bun:test";

import { createGitWorker } from "./worker.ts";
import { concatBytes } from "./git/sha1.ts";
import { PKT_FLUSH, pktLineString } from "./git/pack-common.ts";
import {
  makeEnv,
  seedFullRepo,
  seedPrincipal,
  TEST_APP_URL,
  TEST_CAPSULE,
  TEST_WORKSPACE,
  type TestEnvHandle,
} from "./features/repos/testkit.ts";
import type { DbClient } from "./db/client.ts";

// token → the (subject, scope) the smart-HTTP userinfo mock proves for the /git
// audience. Scope and identity vary independently so we can present a write-scoped
// token backed by a reader principal (scope gate passes, role gate must deny).
interface SmartToken {
  readonly subject: string;
  readonly scope:
    | "source.git.smart_http.read"
    | "source.git.smart_http.write";
}

function smartHttpUserInfo(tokens: Record<string, SmartToken>) {
  return async (_input: RequestInfo | URL, init?: RequestInit) => {
    const token = new Headers(init?.headers)
      .get("authorization")
      ?.replace(/^Bearer\s+/u, "");
    const entry = token ? tokens[token] : undefined;
    if (!entry) return new Response("no", { status: 401 });
    return Response.json({
      token_use: "interface_oauth",
      sub: entry.subject,
      aud: `${TEST_APP_URL}/git`,
      scope: entry.scope,
      takosumi: {
        workspace_id: TEST_WORKSPACE,
        capsule_id: TEST_CAPSULE,
        interface_id: "interface_git_http",
        interface_binding_id: `binding_${entry.subject}`,
        interface_resolved_revision: 3,
      },
    });
  };
}

const TOKENS: Record<string, SmartToken> = {
  // stranger with no grant, read scope
  taksrv_stranger: {
    subject: "sub-stranger",
    scope: "source.git.smart_http.read",
  },
  // reader collaborator, read scope (clone)
  taksrv_reader: { subject: "sub-reader", scope: "source.git.smart_http.read" },
  // reader collaborator carrying a WRITE-scoped token (push must still deny)
  taksrv_reader_w: {
    subject: "sub-reader",
    scope: "source.git.smart_http.write",
  },
  // writer collaborator, write scope (push)
  taksrv_writer_w: {
    subject: "sub-writer",
    scope: "source.git.smart_http.write",
  },
};

const worker = createGitWorker(smartHttpUserInfo(TOKENS));

async function grantCollaborator(
  db: DbClient,
  repoId: string,
  subject: string,
  role: "reader" | "writer" | "maintainer" | "owner",
): Promise<void> {
  const principalId = await seedPrincipal(db, subject, "service_account");
  await db.run(
    `INSERT INTO repo_collaborators (repo_id, principal_id, role, created_at) VALUES (?, ?, ?, ?)`,
    [repoId, principalId, role, db.now()],
  );
}

function gitReq(path: string, token: string, body?: Uint8Array): Request {
  return new Request(`${TEST_APP_URL}${path}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${token}` },
    ...(body ? { body } : {}),
  });
}

/** A private `acme/secret` repo with a reader + writer collaborator seeded. */
async function seedPrivateRepo(): Promise<{
  handle: TestEnvHandle;
  commitSha: string;
}> {
  const handle = makeEnv();
  const seeded = await seedFullRepo(handle, {
    ownerLogin: "acme",
    ownerType: "org",
    name: "secret",
    visibility: "private",
  });
  await grantCollaborator(handle.db, seeded.repoId, "sub-reader", "reader");
  await grantCollaborator(handle.db, seeded.repoId, "sub-writer", "writer");
  return { handle, commitSha: seeded.commitSha };
}

const UPLOAD_REFS =
  "/git/acme/secret.git/info/refs?service=git-upload-pack";
const RECEIVE_REFS =
  "/git/acme/secret.git/info/refs?service=git-receive-pack";

describe("smart-HTTP per-repo ACL", () => {
  test("private repo: clone (upload-pack) is 404 to a stranger", async () => {
    const { handle } = await seedPrivateRepo();
    const res = await worker.fetch(
      gitReq(UPLOAD_REFS, "taksrv_stranger"),
      handle.env,
    );
    // Non-disclosure: a private repo the caller cannot read is indistinguishable
    // from a missing one.
    expect(res.status).toBe(404);
  });

  test("private repo: clone (upload-pack) is allowed to a reader collaborator", async () => {
    const { handle, commitSha } = await seedPrivateRepo();
    const res = await worker.fetch(gitReq(UPLOAD_REFS, "taksrv_reader"), handle.env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/x-git-upload-pack-advertisement",
    );
    expect(await res.text()).toContain(commitSha);
  });

  test("push (receive-pack) is denied to a non-writer even with a write-scoped token", async () => {
    const { handle } = await seedPrivateRepo();
    // reader principal, WRITE scope → clears the exact smart_http.write scope gate
    // but the repo role gate (reader < writer) denies; private → 404.
    const res = await worker.fetch(
      gitReq(RECEIVE_REFS, "taksrv_reader_w"),
      handle.env,
    );
    expect(res.status).toBe(404);

    // Same identity CAN read (proves the deny is the role floor, not the token).
    const read = await worker.fetch(
      gitReq(UPLOAD_REFS, "taksrv_reader"),
      handle.env,
    );
    expect(read.status).toBe(200);
  });

  test("push (receive-pack) advertisement is allowed to a writer", async () => {
    const { handle } = await seedPrivateRepo();
    const res = await worker.fetch(
      gitReq(RECEIVE_REFS, "taksrv_writer_w"),
      handle.env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/x-git-receive-pack-advertisement",
    );
  });

  test("protected branch rejects a writer's direct push BEFORE the R2 CAS", async () => {
    const { handle, commitSha } = await seedPrivateRepo();
    const repoRow = await handle.db.queryOne<{ id: string }>(
      `SELECT id FROM repositories WHERE storage_key = ?`,
      ["acme/secret"],
    );
    // require_reviews > 0 on main ⇒ direct push must go through a PR, not the wire.
    await handle.db.run(
      `INSERT INTO branch_protection_rules (id, repo_id, pattern, required_reviews, enforce_admins, created_at, updated_at)
       VALUES (?, ?, 'main', 1, 0, ?, ?)`,
      [handle.db.id(), repoRow!.id, handle.db.now(), handle.db.now()],
    );

    const newSha = "b".repeat(40);
    const protectedPush = concatBytes(
      pktLineString(
        `${commitSha} ${newSha} refs/heads/main\0report-status\n`,
      ),
      PKT_FLUSH,
    );
    const res = await worker.fetch(
      gitReq(
        "/git/acme/secret.git/git-receive-pack",
        "taksrv_writer_w",
        protectedPush,
      ),
      handle.env,
    );
    expect(res.status).toBe(200); // smart-HTTP reports failures in-band
    const body = await res.text();
    expect(body).toContain("protected ref: refs/heads/main");

    // The refs-doc was never advanced — main still points at the seeded commit.
    const refs = await worker.fetch(gitReq(UPLOAD_REFS, "taksrv_reader"), handle.env);
    expect(await refs.text()).toContain(commitSha);
  });

  test("an UNprotected branch is not blocked by the protection gate for a writer", async () => {
    const { handle, commitSha } = await seedPrivateRepo();
    const repoRow = await handle.db.queryOne<{ id: string }>(
      `SELECT id FROM repositories WHERE storage_key = ?`,
      ["acme/secret"],
    );
    await handle.db.run(
      `INSERT INTO branch_protection_rules (id, repo_id, pattern, required_reviews, enforce_admins, created_at, updated_at)
       VALUES (?, ?, 'main', 1, 0, ?, ?)`,
      [handle.db.id(), repoRow!.id, handle.db.now(), handle.db.now()],
    );

    // A brand-new unprotected branch: the per-ref gate passes, so the push
    // proceeds to pack validation and fails there (no pack sent) — NOT with the
    // protected-ref reason. This proves the gate is per-ref, not a blanket deny.
    const feature = concatBytes(
      pktLineString(
        `${"0".repeat(40)} ${"c".repeat(40)} refs/heads/feature\0report-status\n`,
      ),
      PKT_FLUSH,
    );
    const res = await worker.fetch(
      gitReq("/git/acme/secret.git/git-receive-pack", "taksrv_writer_w", feature),
      handle.env,
    );
    const body = await res.text();
    expect(body).not.toContain("protected ref");
    expect(body).toContain("new ref target is missing");
  });
});
