/**
 * takos-git — standalone git hosting service.
 *
 * Serves git Smart HTTP (`git clone` / `fetch` / `push`) from an R2 object
 * store. Git sends an invocation-only Interface OAuth bearer as the HTTP
 * Basic password (username ignored, matching the GitHub PAT convention).
 *
 *   GET  /healthz
 *   GET  /icons/takos-git.svg                                (launcher tile icon)
 *   GET  /git/<repo>.git/info/refs?service=git-upload-pack   (verb: r)
 *   POST /git/<repo>.git/git-upload-pack                     (verb: r)
 *   POST /git/<repo>.git/git-receive-pack                    (verb: w)
 *   POST /mcp                                                (direct bearer or Interface OAuth)
 */

import type { ObjectStoreBinding } from "./git/types.ts";
import {
  handleInfoRefs,
  handleReceivePack,
  handleUploadPack,
  type GitService,
} from "./smart-http.ts";
import { isValidRepoName, repoExists } from "./git/refs-store.ts";
import { handleMcp } from "./mcp.ts";
import { handleForgeApi } from "./forge-api.ts";
import {
  hasValidInterfaceOAuthConfiguration,
  verifyInterfaceOAuthCredential,
} from "./interface-oauth-auth.ts";
import { routes } from "./router.ts";
import { hasEmbeddedSpa, serveEmbeddedAsset } from "./spa-assets.ts";
import { createDbClient, type D1Database } from "./db/index.ts";
import { authorizeRepo, upsertPrincipal } from "./auth/acl.ts";
import {
  ACTION_REQUIRED_SCOPE,
  type AuthContext,
  type RepoAction,
} from "./contract/v1.ts";
import type { DurableObjectNamespace } from "./features/actions/runner/cf-types.ts";
// Side-effect: registers the /api/v1/ping route into the global registry. Later
// features add themselves the same way — one import line here, no control flow.
import "./routes/ping.ts";
// Feature registration: each feature exports a `registerXRoutes(registry)`; the
// worker adds one import + one call. Phase-3b features follow this exact pattern.
import { registerRepoRoutes } from "./features/repos/index.ts";
import { registerIssuesRoutes } from "./features/issues/index.ts";
import { registerPullRoutes } from "./features/pulls/routes.ts";
import { registerReleaseRoutes } from "./features/releases/routes.ts";
import { registerForkRoutes } from "./features/forks/index.ts";
import { registerWebhookRoutes } from "./features/webhooks/routes.ts";
import { registerChecksRoutes } from "./features/checks/routes.ts";
import {
  onPushDiscoverWorkflows,
  registerActionsRoutes,
} from "./features/actions/index.ts";
import {
  handleInternalActionsRoute,
  handleWorkflowQueue,
  type MessageBatch,
  type RunTick,
} from "./features/actions/runner/index.ts";
import { installEventBridge } from "./features/event-bridge.ts";
import iconSvg from "../public/icons/takos-git.svg" with { type: "text" };

// Self-hosted Actions runner Durable Objects. Re-exported from the Worker entry
// so the `main.tf` migration `new_sqlite_classes = ["ActionsRunCoordinator",
// "ActionsJobRunner"]` resolves against the deployed bundle.
export {
  ActionsRunCoordinator,
  ActionsJobRunner,
} from "./features/actions/runner/index.ts";

registerRepoRoutes(routes);
// Phase-3b collaboration features, registered in dependency order.
registerIssuesRoutes(routes);
registerPullRoutes(routes);
registerReleaseRoutes(routes);
registerForkRoutes(routes);
registerWebhookRoutes(routes);
registerChecksRoutes(routes);
registerActionsRoutes(routes);

/** The native Cloudflare Workers static-assets binding (subset we use). */
export interface AssetFetcher {
  fetch(request: Request): Promise<Response>;
}

export interface Env {
  BUCKET: ObjectStoreBinding;
  /** D1 metadata plane. Undefined until the operator enables it (main.tf gate). */
  DB?: D1Database;
  /** Built SPA static assets. Undefined when enable_web is false / in tests. */
  ASSETS?: AssetFetcher;
  PUBLISHED_MCP_AUTH_TOKEN?: string;
  APP_URL?: string;
  OIDC_ISSUER_URL?: string;
  OIDC_CLIENT_ID?: string;
  OIDC_CLIENT_SECRET?: string;
  APP_SESSION_SECRET?: string;
  APP_WORKSPACE_ID?: string;
  APP_CAPSULE_ID?: string;

  // --- Self-hosted Actions runner bindings (main.tf `enable_actions`) ---
  // All optional/undefined when Actions is off; the control plane degrades to
  // "runs stay queued" and Phase 5b fills the execution fabric behind them.
  /** Actions run/job/step/secret D1 (shares the collaboration-core DB). */
  ACTIONS_DB?: D1Database;
  /** Run-tick queue → Phase-5b coordinator DO. Absent ⇒ runs stay `queued`. */
  WORKFLOW_QUEUE?: { send(message: { runId: string; repoId: string }): Promise<void> };
  /** Logs + artifacts bucket, distinct from the authoritative git BUCKET. */
  R2_ACTIONS?: ObjectStoreBinding;
  /** AES key material for Actions secret encryption at rest. */
  ACTIONS_SECRETS_KEY?: string;
  /** HMAC key for the run-scoped /internal/actions/* routes (Phase 5b). */
  ACTIONS_RUNNER_SECRET?: string;
  /** Run-coordinator Durable Object namespace (Phase 5b). */
  ACTIONS_RUN?: DurableObjectNamespace;
  /** Per-job Container Durable Object namespace (Phase 5b). */
  ACTIONS_JOB?: DurableObjectNamespace;
}

// Tightened from the inline console's `script-src 'unsafe-inline'`: Vite emits
// external, content-hashed JS, so scripts drop to 'self'. style-src keeps
// 'unsafe-inline' for the ported views' dynamic inline styles (tightened later).
const SPA_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self' data:; connect-src 'self'; " +
  "base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

/** Clone an ASSETS response and stamp the app's centralized CSP + cache policy. */
function withAppSecurityHeaders(response: Response, pathname: string): Response {
  const headers = new Headers(response.headers);
  headers.set("content-security-policy", SPA_CSP);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  if (/^\/assets\//u.test(pathname)) {
    // Vite hashes these filenames — safe to cache forever.
    headers.set("cache-control", "public, max-age=31536000, immutable");
  } else if (!headers.has("cache-control")) {
    headers.set("cache-control", "no-cache");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Serve the built SPA: from the `env.ASSETS` binding when present (dev harness /
 * a static-assets deploy), else from the SPA embedded in the Worker bundle at
 * build time (the self-contained install artifact). 404 when neither is present.
 */
async function staticFallback(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (request.method === "GET" || request.method === "HEAD") {
    if (env.ASSETS) {
      return withAppSecurityHeaders(
        await env.ASSETS.fetch(request),
        url.pathname,
      );
    }
    const embedded = serveEmbeddedAsset(url.pathname);
    if (embedded) return withAppSecurityHeaders(embedded, url.pathname);
  }
  return json({ error: "not_found" }, 404);
}

const GIT_PREFIX = "/git/";
const MAX_RECEIVE_PACK_BYTES = 64 * 1024 * 1024;
// The launcher tile icon referenced by the Takosumi-side UI Interface document.
// The dashboard resolves this path against the Worker's public URL, so the
// Worker must serve the asset itself — this single-file Worker ships no static-
// asset bucket.
const ICON_PATH = "/icons/takos-git.svg";

function svgAsset(body: string): Response {
  return new Response(body, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, max-age=86400",
    },
  });
}

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
      "content-security-policy":
        "default-src 'none'; connect-src 'self'; img-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
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
    main { width: min(1040px, calc(100% - 32px)); margin: 32px auto; display: grid; gap: 18px; }
    header { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; }
    header > div { display: grid; gap: 6px; }
    h1 { margin: 0; font-size: 28px; line-height: 1.15; }
    h2 { margin: 0; font-size: 16px; }
    p { margin: 0; color: color-mix(in srgb, CanvasText 70%, transparent); }
    section { border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 8px; padding: 16px; display: grid; gap: 14px; }
    .grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 14px; }
    label { display: grid; gap: 6px; font-size: 13px; font-weight: 600; }
    input { width: 100%; box-sizing: border-box; border: 1px solid color-mix(in srgb, CanvasText 22%, transparent); border-radius: 6px; padding: 10px 11px; background: Canvas; color: CanvasText; font: inherit; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; }
    button, .button { border: 1px solid color-mix(in srgb, CanvasText 22%, transparent); border-radius: 6px; padding: 9px 12px; background: color-mix(in srgb, CanvasText 8%, Canvas); color: CanvasText; font: inherit; cursor: pointer; text-decoration: none; }
    button.primary, .button.primary { background: CanvasText; color: Canvas; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    pre { margin: 0; overflow: auto; border-radius: 6px; padding: 12px; background: color-mix(in srgb, CanvasText 8%, Canvas); min-height: 88px; font-size: 13px; line-height: 1.45; }
    .muted { font-size: 13px; color: color-mix(in srgb, CanvasText 62%, transparent); }
    .session { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 8px; font-size: 13px; }
    [hidden] { display: none !important; }
    @media (max-width: 720px) { main { width: min(100% - 20px, 1040px); margin: 18px auto; } header { display: grid; } .session { justify-content: flex-start; } .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Takos Git</h1>
        <p>Collaborative Git hosting for this Workspace.</p>
      </div>
      <div class="session">
        <span id="session">Checking sign-in…</span>
        <a id="login" class="button primary" href="/api/auth/login?return_to=/" hidden>Sign in</a>
        <button id="logout" type="button" hidden>Sign out</button>
      </div>
    </header>
    <section>
      <h2>Repository browser</h2>
      <div class="grid">
        <label>Repository
          <input id="repo" value="example/repo" placeholder="owner/repository">
        </label>
        <label>File path
          <input id="path" value="README.md" placeholder="path/to/file.ts">
        </label>
      </div>
      <div class="actions">
        <button id="list" class="primary">List repositories</button>
        <button id="info">Repository overview</button>
        <button id="branches">Branches</button>
        <button id="commits">Commits</button>
        <button id="tree">Files</button>
        <button id="blob">Open file</button>
      </div>
      <p class="muted">Browser sessions use Takosumi Accounts OIDC and are limited to this installed Workspace.</p>
    </section>
    <section>
      <h2>Git CLI</h2>
      <label>Short-lived Interface credential
        <input id="token" type="password" autocomplete="off" placeholder="taksrv_… (optional for the signed-in browser)">
      </label>
      <div class="actions">
        <button id="health">Check service</button>
        <button id="refs">Check Smart HTTP refs</button>
        <button id="clone">Show clone command</button>
      </div>
      <p class="muted">Clone, fetch, and push use short-lived Interface credentials minted for this Workspace.</p>
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
    async function apiGet(path) {
      const response = await fetch(path, {
        credentials: "same-origin",
        headers: tokenHeaders(),
      });
      const text = await response.text();
      let body = text;
      try { body = JSON.parse(text); } catch {}
      print({ status: response.status, ok: response.ok, body });
      return { response, body };
    }
    async function loadSession() {
      try {
        const response = await fetch("/api/auth/session", { credentials: "same-origin" });
        const body = await response.json();
        if (body.authenticated) {
          byId("session").textContent = body.user.name || body.user.email || "Signed in";
          byId("logout").hidden = false;
        } else {
          byId("session").textContent = body.configured ? "Not signed in" : "OIDC not configured";
          byId("login").hidden = !body.configured;
        }
      } catch {
        byId("session").textContent = "Sign-in status unavailable";
      }
    }
    byId("logout").addEventListener("click", async () => {
      await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
      window.location.reload();
    });
    byId("list").addEventListener("click", async () => {
      const result = await apiGet("/api/v1/repos");
      const first = result.body && result.body.repositories && result.body.repositories[0];
      if (first && first.name) byId("repo").value = first.name;
    });
    byId("info").addEventListener("click", async () => {
      const repo = repoPath();
      if (!repo) return print("Repository is required.");
      await apiGet("/api/v1/repos/" + repoUrlPart(repo));
    });
    byId("branches").addEventListener("click", async () => {
      const repo = repoPath();
      if (!repo) return print("Repository is required.");
      await apiGet("/api/v1/repos/" + repoUrlPart(repo) + "/branches");
    });
    byId("commits").addEventListener("click", async () => {
      const repo = repoPath();
      if (!repo) return print("Repository is required.");
      await apiGet("/api/v1/repos/" + repoUrlPart(repo) + "/commits");
    });
    byId("tree").addEventListener("click", async () => {
      const repo = repoPath();
      if (!repo) return print("Repository is required.");
      await apiGet("/api/v1/repos/" + repoUrlPart(repo) + "/tree");
    });
    byId("blob").addEventListener("click", async () => {
      const repo = repoPath();
      const path = byId("path").value.trim();
      if (!repo || !path) return print("Repository and file path are required.");
      await apiGet("/api/v1/repos/" + repoUrlPart(repo) + "/blob?path=" + encodeURIComponent(path));
    });
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
    loadSession();
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

function interfaceResourceUri(
  request: Request,
  env: Env,
  path: string,
): string {
  const requestUrl = new URL(request.url);
  const base = env.APP_URL?.trim() || requestUrl.origin;
  try {
    return new URL(path, `${base.replace(/\/$/u, "")}/`).href;
  } catch {
    return "";
  }
}

/** Parse `/git/<repo>/<suffix>` where <repo> may contain one `/` and an optional `.git`. */
function parseGitPath(
  pathname: string,
): { repo: string; suffix: string } | null {
  if (!pathname.startsWith(GIT_PREFIX)) return null;
  for (const suffix of [
    "/info/refs",
    "/git-upload-pack",
    "/git-receive-pack",
  ]) {
    if (pathname.endsWith(suffix)) {
      const repoRaw = pathname.slice(GIT_PREFIX.length, -suffix.length);
      const repo = repoRaw.replace(/\.git$/, "");
      return { repo, suffix };
    }
  }
  return null;
}

/** The proven interface credential fields the smart-HTTP ACL consumes. */
interface SmartHttpCredential {
  readonly subject: string;
  readonly scope: string;
  readonly interfaceBindingId: string;
}

/** A resolved smart-HTTP repo authorization: a deny Response, or the per-ref gate. */
type SmartHttpGate =
  | Response
  | { readonly authorizeRef: (refName: string) => Promise<boolean> };

/**
 * Per-repo authorization for the Git smart-HTTP surface, layered AFTER the exact
 * smart_http scope verify (which already ran in {@link fetchHandler}) and ONLY
 * when the D1 metadata plane is present. Resolves the interface credential's
 * subject into an app-local `service_account` principal, then runs the fail-closed
 * repo ACL: a private repo the caller cannot read → 404 (non-disclosure), an
 * insufficient role → 403. Returns a per-ref gate the receive-pack path calls to
 * enforce branch protection on each advanced ref BEFORE the R2 CAS.
 */
async function authorizeSmartHttpRepo(
  dbBinding: D1Database,
  credential: SmartHttpCredential,
  repoPath: string,
  service: GitService,
): Promise<SmartHttpGate> {
  const db = createDbClient(dbBinding);
  // The R2 storage key is `owner/name`; split on the first slash. A bare
  // single-segment path has no owner row and fails closed as not_found below.
  const slash = repoPath.indexOf("/");
  const owner = slash === -1 ? "" : repoPath.slice(0, slash);
  const name = slash === -1 ? repoPath : repoPath.slice(slash + 1);
  const action: RepoAction =
    service === "git-receive-pack" ? "contents.write" : "contents.read";
  const principal = await upsertPrincipal(db, {
    subject: credential.subject,
    kind: "service_account",
    bindingId: credential.interfaceBindingId,
  });
  // The authoritative scope ceiling for THIS surface already ran in fetchHandler
  // (the exact source.git.smart_http.{read,write} verify). authorizeRepo's
  // interface ceiling speaks the hosting-scope vocabulary, so seed the ctx with
  // the action's required scope to make that (already-satisfied) ceiling a no-op
  // and let the ACL contribute role + visibility + branch protection.
  const ctx: AuthContext = {
    principal,
    channel: "interface",
    scopes: new Set([credential.scope, ACTION_REQUIRED_SCOPE[action]]),
  };
  const decision = await authorizeRepo(db, ctx, owner, name, action, {
    ref: "*",
  });
  if (!decision.allow) {
    return json({ error: decision.reason }, decision.status);
  }
  return {
    // Per-ref branch protection at receive-pack time: re-run the ACL with the
    // concrete ref so a protected branch rejects a non-permitted direct push.
    authorizeRef: async (refName: string) =>
      (
        await authorizeRepo(db, ctx, owner, name, "contents.write", {
          ref: refName,
        })
      ).allow,
  };
}

export type InterfaceUserInfoFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

async function fetchHandler(
  request: Request,
  env: Env,
  interfaceUserInfoFetch?: InterfaceUserInfoFetch,
): Promise<Response> {
  const url = new URL(request.url);
  // Bridge issues/pulls domain events to webhook delivery. Cheap + idempotent;
  // env bindings are stable per isolate, so re-installing each request is safe.
  installEventBridge(env);

  if (request.method === "GET" && url.pathname === "/healthz") {
    return json({ status: "ok", service: "takos-git" }, 200);
  }
  if (request.method === "GET" && url.pathname === ICON_PATH) {
    return svgAsset(iconSvg);
  }
  // Self-hosted Actions runner callback surface. A SEPARATE HMAC trust boundary
  // (ACTIONS_RUNNER_SECRET), dispatched here BEFORE the router so it is never
  // reachable via /api/v1, /git/, or /mcp. Returns null when the path is not an
  // /internal/actions/* route, so existing dispatch is untouched; fail-closed.
  const internalActions = await handleInternalActionsRoute(request, env, url);
  if (internalActions) return internalActions;
  // The built SPA owns "/" whenever it is available (ASSETS binding OR embedded in
  // the Worker bundle); the inline console is only the minimal fallback for a
  // deploy that shipped no web build at all.
  if (
    request.method === "GET" &&
    !env.ASSETS &&
    !hasEmbeddedSpa() &&
    (url.pathname === "/" || url.pathname === "/ui")
  ) {
    return html(gitConsoleHtml(url.origin));
  }
  if (url.pathname === "/mcp") {
    return handleMcp(request, env, interfaceUserInfoFetch);
  }

  // Table-driven route registry (currently the trivial /api/v1/ping). Returns a
  // Response for a registered+authorized route, or null when no route matches so
  // dispatch continues below — a matched route is NEVER served without its auth.
  const routed = await routes.handle({
    request,
    env,
    url,
    ...(interfaceUserInfoFetch ? { interfaceUserInfoFetch } : {}),
  });
  if (routed) return routed;

  const forgeResponse = await handleForgeApi(
    request,
    env,
    interfaceUserInfoFetch,
  );
  if (forgeResponse) return forgeResponse;

  const route = parseGitPath(url.pathname);
  if (!route) return staticFallback(request, env, url);
  if (!route.repo || !isValidRepoName(route.repo)) {
    return json({ error: "invalid_repository" }, 404);
  }

  let service: GitService;
  if (route.suffix === "/info/refs") {
    if (request.method !== "GET")
      return json({ error: "method_not_allowed" }, 405);
    const requestedService = url.searchParams.get("service");
    if (
      requestedService !== "git-upload-pack" &&
      requestedService !== "git-receive-pack"
    ) {
      return json({ error: "service_required" }, 400);
    }
    service = requestedService;
  } else if (route.suffix === "/git-upload-pack") {
    if (request.method !== "POST")
      return json({ error: "method_not_allowed" }, 405);
    service = "git-upload-pack";
  } else {
    if (request.method !== "POST")
      return json({ error: "method_not_allowed" }, 405);
    service = "git-receive-pack";
  }

  // --- authenticate through an exact InterfaceBinding permission ---
  const token = tokenFromRequest(request);
  if (!token) return unauthorized();
  const expectedPermission =
    service === "git-receive-pack"
      ? "source.git.smart_http.write"
      : "source.git.smart_http.read";
  const audience = interfaceResourceUri(request, env, "/git");
  if (
    !hasValidInterfaceOAuthConfiguration({
      issuerUrl: env.OIDC_ISSUER_URL,
      audience,
      workspaceId: env.APP_WORKSPACE_ID,
      capsuleId: env.APP_CAPSULE_ID,
    })
  ) {
    return json({ error: "interface_oauth_unconfigured" }, 503);
  }
  const credential = await verifyInterfaceOAuthCredential(
    request,
    token,
    expectedPermission,
    {
      issuerUrl: env.OIDC_ISSUER_URL,
      expectedAudience: audience,
      expectedWorkspaceId: env.APP_WORKSPACE_ID,
      expectedCapsuleId: env.APP_CAPSULE_ID,
      ...(interfaceUserInfoFetch ? { fetchImpl: interfaceUserInfoFetch } : {}),
    },
  );
  if (!credential.ok) return unauthorized();

  // Per-repo ACL, layered AFTER the exact-scope gate and ONLY when the D1
  // metadata plane is present (D1-optional graceful degradation). Without DB this
  // is skipped entirely, leaving exactly the scope-only behavior the DB-less E2E
  // relies on. The per-ref gate enforces branch protection inside receive-pack.
  let authorizeRef: ((refName: string) => Promise<boolean>) | undefined;
  if (env.DB) {
    const gate = await authorizeSmartHttpRepo(
      env.DB,
      credential,
      route.repo,
      service,
    );
    if (gate instanceof Response) return gate;
    authorizeRef = gate.authorizeRef;
  }
  if (!(await repoExists(env.BUCKET, route.repo))) {
    return json({ error: "repository_not_found" }, 404);
  }

  if (route.suffix === "/info/refs") {
    return handleInfoRefs(env.BUCKET, route.repo, service);
  }
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (
    service === "git-receive-pack" &&
    contentLength > MAX_RECEIVE_PACK_BYTES
  ) {
    return json({ error: "receive_pack_too_large" }, 413);
  }
  const body = new Uint8Array(await request.arrayBuffer());
  if (service === "git-receive-pack") {
    if (body.length > MAX_RECEIVE_PACK_BYTES) {
      return json({ error: "receive_pack_too_large" }, 413);
    }
    // Best-effort Actions discovery after a successful push. Only wired when the
    // metadata plane is configured, so the clone/push path (and its E2E) is
    // untouched when Actions/D1 are off; the hook itself is D1-guarded + caught.
    const onApplied = env.DB
      ? (updates: readonly { name: string; oldSha: string; newSha: string }[]) =>
          onPushDiscoverWorkflows(env, route.repo, updates)
      : undefined;
    return handleReceivePack(env.BUCKET, route.repo, body, {
      ...(onApplied ? { onApplied } : {}),
      ...(authorizeRef ? { authorizeRef } : {}),
    });
  }
  return handleUploadPack(env.BUCKET, route.repo, body);
}

export function createGitWorker(
  interfaceUserInfoFetch?: InterfaceUserInfoFetch,
): {
  fetch(request: Request, env: Env): Promise<Response>;
  queue(batch: MessageBatch<RunTick>, env: Env): Promise<void>;
} {
  return {
    fetch: (request, env) => fetchHandler(request, env, interfaceUserInfoFetch),
    // Actions run-tick consumer (WORKFLOW_QUEUE → coordinator DO). A no-op when
    // the coordinator namespace is unbound; never touches the fetch path.
    queue: (batch, env) => handleWorkflowQueue(batch, env),
  };
}

export default createGitWorker();
