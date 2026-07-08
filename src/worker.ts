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

function html(body: string): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function gitConsoleHtml(origin: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Takos Git</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: Canvas; color: CanvasText; }
    main { width: min(920px, calc(100% - 32px)); margin: 32px auto; display: grid; gap: 18px; }
    header { display: grid; gap: 6px; }
    h1 { margin: 0; font-size: 28px; line-height: 1.15; }
    p { margin: 0; color: color-mix(in srgb, CanvasText 70%, transparent); }
    section { border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 8px; padding: 16px; display: grid; gap: 14px; }
    label { display: grid; gap: 6px; font-size: 13px; font-weight: 600; }
    input { width: 100%; box-sizing: border-box; border: 1px solid color-mix(in srgb, CanvasText 22%, transparent); border-radius: 6px; padding: 10px 11px; background: Canvas; color: CanvasText; font: inherit; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; }
    button { border: 1px solid color-mix(in srgb, CanvasText 22%, transparent); border-radius: 6px; padding: 9px 12px; background: color-mix(in srgb, CanvasText 8%, Canvas); color: CanvasText; font: inherit; cursor: pointer; }
    button.primary { background: CanvasText; color: Canvas; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    pre { margin: 0; overflow: auto; border-radius: 6px; padding: 12px; background: color-mix(in srgb, CanvasText 8%, Canvas); min-height: 88px; font-size: 13px; line-height: 1.45; }
    .muted { font-size: 13px; color: color-mix(in srgb, CanvasText 62%, transparent); }
    @media (max-width: 720px) { main { width: min(100% - 20px, 920px); margin: 18px auto; } }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Takos Git</h1>
      <p>Read-only Git Smart HTTP endpoint for this Capsule.</p>
    </header>
    <section>
      <label>Repository
        <input id="repo" value="example/repo" placeholder="owner/repository">
      </label>
      <label>Access token
        <input id="token" type="password" autocomplete="off" placeholder="Scoped clone token minted by Takosumi">
      </label>
      <div class="actions">
        <button id="health">Check service</button>
        <button id="refs" class="primary">Check refs</button>
        <button id="clone">Show clone command</button>
      </div>
      <p class="muted">Push is disabled in this service version. Use Takosumi-managed import or release flows to write repositories.</p>
    </section>
    <section>
      <pre id="result">Base URL: ${origin}/git</pre>
    </section>
  </main>
  <script>
    const byId = (id) => document.getElementById(id);
    const result = byId("result");
    function repoPath() {
      return byId("repo").value.trim().replace(/^\\/+|\\/+$/g, "");
    }
    function repoUrlPart(repo) {
      return repo.split("/").map(encodeURIComponent).join("/");
    }
    function tokenHeaders() {
      const token = byId("token").value.trim();
      return token ? { authorization: "Bearer " + token } : {};
    }
    function print(value) {
      result.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    }
    byId("health").addEventListener("click", async () => {
      const response = await fetch("/healthz");
      const text = await response.text();
      let body = text;
      try { body = JSON.parse(text); } catch {}
      print({ status: response.status, ok: response.ok, body });
    });
    byId("refs").addEventListener("click", async () => {
      const repo = repoPath();
      if (!repo) return print("Repository is required.");
      const response = await fetch("/git/" + repoUrlPart(repo) + ".git/info/refs?service=git-upload-pack", {
        headers: tokenHeaders(),
      });
      print({ status: response.status, ok: response.ok, contentType: response.headers.get("content-type"), body: await response.text() });
    });
    byId("clone").addEventListener("click", () => {
      const repo = repoPath();
      if (!repo) return print("Repository is required.");
      const token = byId("token").value.trim();
      const auth = token ? "x:" + encodeURIComponent(token) + "@" : "";
      print("git -c protocol.version=1 clone " + window.location.protocol + "//" + auth + window.location.host + "/git/" + repoUrlPart(repo) + ".git");
    });
  </script>
</body>
</html>`;
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
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/ui")) {
      return html(gitConsoleHtml(url.origin));
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
