import { describe, expect, test } from "bun:test";

import {
  handleBrowserAuth,
  readBrowserSession,
  type BrowserAuthEnv,
} from "./browser-auth.ts";

const ENV: BrowserAuthEnv = {
  OIDC_ISSUER_URL: "https://accounts.example",
  OIDC_CLIENT_ID: "takos-git-client",
  OIDC_CLIENT_SECRET: "client-secret",
  APP_SESSION_SECRET: "session-secret-that-is-long-enough-for-tests",
  APP_WORKSPACE_ID: "workspace_a",
};

function cookieValue(response: Response, name: string): string {
  const header = response.headers.get("set-cookie") ?? "";
  const match = new RegExp(`${name}=([^;,]+)`).exec(header);
  if (!match?.[1]) throw new Error(`missing ${name} cookie: ${header}`);
  return match[1];
}

async function beginLogin(returnTo = "/repos") {
  const response = await handleBrowserAuth(
    new Request(
      `https://git.example/api/auth/login?return_to=${encodeURIComponent(returnTo)}`,
    ),
    ENV,
  );
  if (!response) throw new Error("login route was not handled");
  const location = new URL(response.headers.get("location") ?? "");
  return {
    response,
    state: location.searchParams.get("state") ?? "",
    stateCookie: cookieValue(response, "takos_git_oauth_state"),
  };
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
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("code_challenge")?.length).toBeGreaterThan(
      20,
    );
  });

  test("exchanges the code and issues a Workspace-bound session", async () => {
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
    );
    expect(session).toMatchObject({
      subject: "principal_1",
      name: "Takos User",
      email: "user@example.com",
      workspaceIds: ["workspace_a"],
    });
  });

  test("rejects a user outside the installed Workspace", async () => {
    const login = await beginLogin();
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
              sub: "principal_other",
              workspace_memberships: ["workspace_other"],
            });
      },
    );
    expect(response?.status).toBe(403);
    expect(await response?.json()).toEqual({
      error: "workspace_membership_required",
    });
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
});
