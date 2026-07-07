/**
 * takos-git — standalone git hosting service.
 *
 * Serves read-only git Smart HTTP (`git clone` / `fetch`) from an R2 object
 * store, gated by scoped bearer tokens Takosumi mints at bind time. A token is
 * bounded to a repo prefix + verb set; git sends it as the HTTP Basic password
 * (username ignored, matching the GitHub PAT convention).
 *
 *   GET  /healthz
 *   GET  /git/<repo>.git/info/refs?service=git-upload-pack   (verb: r)
 *   POST /git/<repo>.git/git-upload-pack                     (verb: r)
 *   POST /git/<repo>.git/git-receive-pack                    -> 403 (push via API; P1 read-only)
 *
 * Push (receive-pack) is intentionally out of scope for P1.
 */

import type { ObjectStoreBinding } from "./git/types.ts";
import { gitTokenAllows, verifyGitToken } from "./git-token.ts";
import { handleInfoRefs, handleUploadPack } from "./smart-http.ts";
import { isValidRepoName } from "./git/refs-store.ts";

export interface Env {
  BUCKET: ObjectStoreBinding;
  GIT_TOKEN_SIGNING_KEY: string;
  APP_URL?: string;
}

const GIT_PREFIX = "/git/";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "git_unauthorized" }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "www-authenticate": 'Basic realm="Takos Git", charset="UTF-8"',
    },
  });
}

/** Extract the token git sends as the HTTP Basic password (or a Bearer header). */
function tokenFromRequest(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const [scheme, encoded] = header.split(" ", 2);
  if (!scheme || !encoded) return null;
  if (scheme.toLowerCase() === "bearer") return encoded;
  if (scheme.toLowerCase() !== "basic") return null;
  try {
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(encoded), (ch) => ch.charCodeAt(0)),
    );
    const colon = decoded.indexOf(":");
    return colon === -1 ? decoded : decoded.slice(colon + 1);
  } catch {
    return null;
  }
}

/** Parse `/git/<repo>/<suffix>` where <repo> may contain one `/` and an optional `.git`. */
function parseGitPath(pathname: string): { repo: string; suffix: string } | null {
  if (!pathname.startsWith(GIT_PREFIX)) return null;
  for (const suffix of ["/info/refs", "/git-upload-pack", "/git-receive-pack"]) {
    if (pathname.endsWith(suffix)) {
      const repoRaw = pathname.slice(GIT_PREFIX.length, -suffix.length);
      const repo = repoRaw.replace(/\.git$/, "");
      return { repo, suffix };
    }
  }
  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const nowSeconds = Math.floor(Date.now() / 1000);

    if (request.method === "GET" && url.pathname === "/healthz") {
      return json({ status: "ok", service: "takos-git" }, 200);
    }

    const route = parseGitPath(url.pathname);
    if (!route) return json({ error: "not_found" }, 404);
    if (!route.repo || !isValidRepoName(route.repo)) {
      return json({ error: "invalid_repository" }, 404);
    }

    if (route.suffix === "/git-receive-pack") {
      return json({ error: "git_push_disabled" }, 403);
    }
    if (
      route.suffix === "/info/refs" &&
      url.searchParams.get("service") === "git-receive-pack"
    ) {
      return json({ error: "git_push_disabled" }, 403);
    }
    if (route.suffix === "/info/refs") {
      const service = url.searchParams.get("service");
      if (service !== "git-upload-pack") {
        return json({ error: "service_required" }, 400);
      }
    }

    // --- authenticate (read/clone) ---
    const token = tokenFromRequest(request);
    if (!token) return unauthorized();
    if (!env.GIT_TOKEN_SIGNING_KEY) {
      return json({ error: "git_signing_key_unconfigured" }, 503);
    }
    const verified = await verifyGitToken(env.GIT_TOKEN_SIGNING_KEY, token, nowSeconds);
    if (!verified.ok) return unauthorized();
    if (!gitTokenAllows(verified.payload, "r", route.repo)) {
      return json({ error: "forbidden_repository" }, 403);
    }

    if (route.suffix === "/info/refs") {
      return handleInfoRefs(env.BUCKET, route.repo);
    }
    // /git-upload-pack
    const body = new Uint8Array(await request.arrayBuffer());
    return handleUploadPack(env.BUCKET, route.repo, body);
  },
};
