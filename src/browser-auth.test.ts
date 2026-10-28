import { describe, expect, test } from "bun:test";

import {
  handleBrowserAuth,
  readBrowserSession,
  browserAuthConfigured,
  type BrowserAuthEnv,
  type OAuthFetch,
} from "./browser-auth.ts";

const ENV: BrowserAuthEnv = {
  APP_URL: "https://git.example",
  OIDC_ISSUER_URL: "https://accounts.example",
  OIDC_CLIENT_ID: "takos-git-client",
  OIDC_CLIENT_SECRET: "client-secret",
  APP_SESSION_SECRET: "session-secret-that-is-long-enough-for-tests",
  APP_WORKSPACE_ID: "workspace_a",
  APP_CAPSULE_ID: "capsule_git",
};

function cookieValue(response: Response, name: string): string {
  const header = response.headers.get("set-cookie") ?? "";
  const match = new RegExp(`${name}=([^;,]+)`).exec(header);
  if (!match?.[1]) throw new Error(`missing ${name} cookie: ${header}`);
  return match[1];
}

async function beginLogin(returnTo = "/repos", env: BrowserAuthEnv = ENV) {
  const response = await handleBrowserAuth(
    new Request(
      `https://git.example/api/auth/login?return_to=${encodeURIComponent(returnTo)}`,
    ),
    env,
  );
  if (!response) throw new Error("login route was not handled");
  const location = new URL(response.headers.get("location") ?? "");
  return {
    response,
    state: location.searchParams.get("state") ?? "",
    stateCookie: cookieValue(response, "takos_git_oauth_state"),
  };
}

function sessionRequest(cookie: string): Request {
  return new Request("https://git.example/api/auth/session", {
    headers: { cookie: `takos_git_session=${cookie}` },
  });
}

async function sessionInfo(cookie: string, fetchImpl: OAuthFetch, env: BrowserAuthEnv = ENV) {
  const response = await handleBrowserAuth(sessionRequest(cookie), env, fetchImpl);
  if (!response) throw new Error("session route was not handled");
  return response.json();
}

async function completeLogin(claims: unknown, env: BrowserAuthEnv = ENV) {
  const login = await beginLogin("/repos", env);
  const fetchImpl: OAuthFetch = async (input) =>
    new URL(input.toString()).pathname === "/oauth/token"
      ? Response.json({ access_token: "oauth-access" })
      : Response.json(claims);
  const response = await handleBrowserAuth(new Request(
    `https://git.example/api/auth/callback?code=code&state=${encodeURIComponent(login.state)}`,
    { headers: { cookie: `takos_git_oauth_state=${login.stateCookie}` } },
  ), env, fetchImpl);
  if (!response) throw new Error("callback was not handled");
  return { response, fetchImpl };
}

async function legacyCookie(session: unknown): Promise<string> {
  const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const payload = encode(new TextEncoder().encode(JSON.stringify(session)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(ENV.APP_SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`session.${payload}`));
  return `${payload}.${encode(new Uint8Array(signature))}`;
}

describe("takos-git browser auth", () => {
  test("starts an authorization-code + PKCE login", async () => {
    const login = await beginLogin();
    expect(login.response.status).toBe(302);
    const location = new URL(login.response.headers.get("location") ?? "");
    expect(
      location.href.startsWith("https://accounts.example/oauth/authorize"),
    ).toBe(true);
    expect(location.searchParams.get("client_id")).toBe("takos-git-client");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://git.example/api/auth/callback",
    );
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("code_challenge")?.length).toBeGreaterThan(
      20,
    );
  });

  test("exchanges the code and retains only the installed legacy Workspace", async () => {
    const login = await beginLogin();
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString());
      if (url.pathname === "/oauth/token") {
        expect(init?.method).toBe("POST");
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("code_verifier")?.length).toBeGreaterThan(20);
        expect(body.get("client_secret")).toBe("client-secret");
        return Response.json({ access_token: "oauth-access" });
      }
      if (url.pathname === "/oauth/userinfo") {
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer oauth-access",
        );
        return Response.json({
          sub: "principal_1",
          name: "Takos User",
          email: "user@example.com",
          workspace_memberships: [
            { workspace_id: "workspace_a" },
            { workspace_id: "workspace_other" },
          ],
        });
      }
      return new Response(null, { status: 404 });
    };
    const callback = await handleBrowserAuth(
      new Request(
        `https://git.example/api/auth/callback?code=code_1&state=${encodeURIComponent(login.state)}`,
        {
          headers: {
            cookie: `takos_git_oauth_state=${login.stateCookie}`,
          },
        },
      ),
      ENV,
      fetchImpl,
    );
    if (!callback) throw new Error("callback route was not handled");
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/repos");
    const sessionCookie = cookieValue(callback, "takos_git_session");
    const session = await readBrowserSession(
      new Request("https://git.example/api/v1/repos", {
        headers: { cookie: `takos_git_session=${sessionCookie}` },
      }),
      ENV,
      fetchImpl,
    );
    expect(session).toMatchObject({
      subject: "principal_1",
      name: "Takos User",
      email: "user@example.com",
      workspaceIds: ["workspace_a"],
    });
  });

  test("admits any account without Workspace membership or an app role", async () => {
    const { response, fetchImpl } = await completeLogin({ sub: "ordinary_user" });
    expect(response.status).toBe(302);
    const cookie = cookieValue(response, "takos_git_session");
    expect(await readBrowserSession(sessionRequest(cookie), ENV, fetchImpl)).toMatchObject({
      subject: "ordinary_user", workspaceIds: [], appRole: null,
    });
    expect(await sessionInfo(cookie, fetchImpl)).toMatchObject({
      authenticated: true, capsuleId: "capsule_git", appRole: null, canManageApp: false,
    });
  });

  test("supports Capsule-only configuration and the legacy Workspace configuration", () => {
    expect(browserAuthConfigured({ ...ENV, APP_WORKSPACE_ID: undefined })).toBe(true);
    expect(browserAuthConfigured({ ...ENV, APP_CAPSULE_ID: undefined })).toBe(true);
    expect(browserAuthConfigured({ ...ENV, APP_WORKSPACE_ID: undefined, APP_CAPSULE_ID: undefined })).toBe(false);
  });

  for (const role of ["owner", "member"]) {
    test(`reports current ${role} management access for the installed app`, async () => {
      const env = { ...ENV, APP_WORKSPACE_ID: undefined };
      const { response, fetchImpl } = await completeLogin({
        sub: "app_manager", takosumi: { capsule_id: "capsule_git", app_role: role },
      }, env);
      expect(response.status).toBe(302);
      const cookie = cookieValue(response, "takos_git_session");
      expect(cookie.startsWith("v2.")).toBe(true);
      expect(cookie).not.toContain("oauth-access");
      expect(await sessionInfo(cookie, fetchImpl, env)).toMatchObject({
        authenticated: true, appRole: role, canManageApp: true,
      });
    });
  }

  test("a matching capsule without a role remains an ordinary user", async () => {
    const { response, fetchImpl } = await completeLogin({
      sub: "ordinary_user", takosumi: { capsule_id: "capsule_git" },
    });
    expect(response.status).toBe(302);
    expect(await sessionInfo(cookieValue(response, "takos_git_session"), fetchImpl)).toMatchObject({
      authenticated: true, appRole: null, canManageApp: false,
    });
  });

  for (const appClaims of [
    { capsule_id: "foreign_capsule", app_role: "owner" },
    { capsule_id: "foreign_capsule" },
    { app_role: "owner" },
    { capsule_id: "capsule_git", app_role: "admin" },
    { capsule_id: "capsule_git", app_role: "" },
    { capsule_id: "capsule_git", app_role: null },
    { capsule_id: "capsule_git", app_role: {} },
  ]) {
    test(`rejects foreign or malformed app claims despite legacy membership: ${JSON.stringify(appClaims)}`, async () => {
      const { response } = await completeLogin({
        sub: "legacy_member", workspace_memberships: ["workspace_a"],
        takosumi: { workspace_id: "workspace_a", role: "owner", ...appClaims },
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "invalid_userinfo" });
    });
  }

  for (const takosumi of [null, false, "malformed", []]) {
    test(`rejects malformed app claim envelope ${JSON.stringify(takosumi)}`, async () => {
      const { response } = await completeLogin({
        sub: "legacy_member", workspace_memberships: ["workspace_a"], takosumi,
      });
      expect(response.status).toBe(403);
    });
  }

  test("revalidates role removal, foreign capsule, subject change and revocation on session reads", async () => {
    let claims: Record<string, unknown> = {
      sub: "manager", takosumi: { capsule_id: "capsule_git", app_role: "owner" },
    };
    const { response } = await completeLogin(claims);
    const cookie = cookieValue(response, "takos_git_session");
    const live: OAuthFetch = async () => Response.json(claims);
    expect(await sessionInfo(cookie, live)).toMatchObject({ canManageApp: true });
    claims = { sub: "manager", takosumi: { capsule_id: "capsule_git" } };
    expect(await sessionInfo(cookie, live)).toMatchObject({ authenticated: true, appRole: null, canManageApp: false });
    claims = { sub: "manager", workspace_memberships: ["workspace_a"], takosumi: { capsule_id: "foreign", app_role: "owner" } };
    expect(await sessionInfo(cookie, live)).toMatchObject({ authenticated: false });
    claims = { sub: "other", takosumi: { capsule_id: "capsule_git", app_role: "owner" } };
    expect(await sessionInfo(cookie, live)).toMatchObject({ authenticated: false });
    expect(await sessionInfo(cookie, async () => new Response(null, { status: 401 }))).toMatchObject({ authenticated: false });
    expect(await sessionInfo(cookie, async () => { throw new Error("unavailable"); })).toMatchObject({ authenticated: false });
  });

  test("encrypted sessions cannot be replayed across app, issuer or client context", async () => {
    const { response, fetchImpl } = await completeLogin({ sub: "ordinary" });
    const cookie = cookieValue(response, "takos_git_session");
    for (const context of [
      { APP_CAPSULE_ID: "other_capsule" },
      { OIDC_CLIENT_ID: "other_client" },
      { OIDC_ISSUER_URL: "https://other-accounts.example" },
    ]) {
      expect(await readBrowserSession(sessionRequest(cookie), { ...ENV, ...context }, fetchImpl)).toBeNull();
    }
    const tampered = `${cookie.slice(0, 10)}${cookie[10] === "a" ? "b" : "a"}${cookie.slice(11)}`;
    expect(await readBrowserSession(sessionRequest(tampered), ENV, fetchImpl)).toBeNull();
  });

  test("legacy signed Workspace sessions retain ordinary access without management authority", async () => {
    const cookie = await legacyCookie({
      subject: "legacy", name: null, email: null, workspaceIds: ["workspace_a"],
      expiresAt: Math.floor(Date.now() / 1000) + 60,
      appRole: "owner",
    });
    expect(await sessionInfo(cookie, async () => { throw new Error("legacy has no token"); })).toMatchObject({
      authenticated: true, appRole: null, canManageApp: false,
    });
    expect(await readBrowserSession(sessionRequest(cookie), { ...ENV, APP_WORKSPACE_ID: "other" })).toBeNull();
  });

  test("does not accept an OAuth state cookie as a session cookie", async () => {
    const login = await beginLogin();
    const session = await readBrowserSession(
      new Request("https://git.example/api/v1/repos", {
        headers: {
          cookie: `takos_git_session=${login.stateCookie}`,
        },
      }),
      ENV,
    );
    expect(session).toBeNull();
  });

  test("normalizes an external return_to to the local root", async () => {
    const login = await beginLogin("//evil.example/path");
    const response = await handleBrowserAuth(
      new Request(
        `https://git.example/api/auth/callback?code=code_1&state=${encodeURIComponent(login.state)}`,
        {
          headers: {
            cookie: `takos_git_oauth_state=${login.stateCookie}`,
          },
        },
      ),
      ENV,
      async (input) => {
        const url = new URL(input.toString());
        return url.pathname === "/oauth/token"
          ? Response.json({ access_token: "oauth-access" })
          : Response.json({
              sub: "principal_1",
              workspace_memberships: ["workspace_a"],
            });
      },
    );
    expect(response?.status).toBe(302);
    expect(response?.headers.get("location")).toBe("/");
  });

  test("rejects caller-controlled callback origins and issuer paths", async () => {
    const callbackOrigin = await handleBrowserAuth(
      new Request("https://attacker.example/api/auth/login"),
      ENV,
    );
    expect(
      new URL(callbackOrigin?.headers.get("location") ?? "").searchParams.get(
        "redirect_uri",
      ),
    ).toBe("https://git.example/api/auth/callback");

    const issuerPath = await handleBrowserAuth(
      new Request("https://git.example/api/auth/login"),
      { ...ENV, OIDC_ISSUER_URL: "https://accounts.example/tenant" },
    );
    expect(issuerPath?.status).toBe(503);
    expect(await issuerPath?.json()).toMatchObject({
      error: "browser_auth_unconfigured",
      missing: ["OIDC_ISSUER_URL"],
    });
  });
});
