import { describe, expect, test } from "bun:test";

import { handleBrowserAuth, type OAuthFetch } from "../../browser-auth.ts";
import { RouteRegistry } from "../../router.ts";
import { registerRepoRoutes } from "./routes.ts";
import { registerForkRoutes } from "../forks/routes.ts";
import { makeEnv, seedFullRepo } from "./testkit.ts";

function cookie(response: Response, name: string): string {
  const value = new RegExp(`${name}=([^;,]+)`).exec(
    response.headers.get("set-cookie") ?? "",
  )?.[1];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

describe("app sign-in preserves repository ACLs", () => {
  for (const appRole of [
    undefined,
    "owner",
    "member",
    "legacy-owner",
    "legacy-member",
    "legacy-viewer",
  ]) {
    const eligible = appRole !== undefined;
    test(`${appRole ?? "ordinary user"} keeps app-local repository permissions`, async () => {
      const handle = makeEnv();
      const env = {
        ...handle.env,
        OIDC_CLIENT_ID: "client",
        APP_SESSION_SECRET: "fixture-session-secret-at-least-32-characters",
      };
      await seedFullRepo(handle, {
        ownerLogin: "acme",
        name: "secret",
        visibility: "private",
      });
      await seedFullRepo(handle, {
        ownerLogin: "acme",
        name: "public",
        visibility: "public",
      });
      await seedFullRepo(handle, {
        ownerLogin: "acme",
        name: "internal",
        visibility: "internal",
      });
      let claims: Record<string, unknown> = {
        sub: "ordinary_account",
        ...(appRole?.startsWith("legacy-")
          ? { workspace_memberships: ["workspace_a"] }
          : {}),
        takosumi: {
          capsule_id: "capsule_git",
          ...(appRole?.startsWith("legacy-")
            ? { workspace_id: "workspace_a", role: appRole.slice(7) }
            : appRole
              ? { app_role: appRole }
              : {}),
        },
      };
      let userInfoFailure: 401 | 503 | null = null;
      const fetchImpl: OAuthFetch = async (input) =>
        new URL(input.toString()).pathname === "/oauth/token"
          ? Response.json({ access_token: "oauth-access", expires_in: 300 })
          : userInfoFailure === null
            ? Response.json(claims)
            : new Response(null, { status: userInfoFailure });
      const login = await handleBrowserAuth(
        new Request("https://git.example/api/auth/login"),
        env,
      );
      if (!login) throw new Error("login unhandled");
      const state = new URL(login.headers.get("location")!).searchParams.get(
        "state",
      );
      const callback = await handleBrowserAuth(
        new Request(
          `https://git.example/api/auth/callback?code=code&state=${state}`,
          {
            headers: {
              cookie: `takos_git_oauth_state=${cookie(login, "takos_git_oauth_state")}`,
            },
          },
        ),
        env,
        fetchImpl,
      );
      if (!callback) throw new Error("callback unhandled");
      expect(callback.status).toBe(302);
      const sessionCookie = `takos_git_session=${cookie(callback, "takos_git_session")}`;
      const registry = new RouteRegistry();
      registerRepoRoutes(registry);
      registerForkRoutes(registry);
      const dispatch = async (method: string, path: string, body?: unknown) => {
        const response = await registry.handle({
          request: new Request(`https://git.example${path}`, {
            method,
            headers: {
              cookie: sessionCookie,
              origin: "https://git.example",
              "content-type": "application/json",
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
          }),
          env,
          interfaceUserInfoFetch: fetchImpl,
        });
        if (!response) throw new Error("route unhandled");
        return response;
      };
      expect((await dispatch("GET", "/api/v1/repos/acme/secret")).status).toBe(
        404,
      );
      expect((await dispatch("GET", "/api/v1/repos/acme/public")).status).toBe(
        200,
      );
      expect(
        (await dispatch("GET", "/api/v1/repos/acme/internal")).status,
      ).toBe(eligible ? 200 : 404);
      expect(
        (
          await dispatch("PATCH", "/api/v1/repos/acme/public", {
            description: "forbidden",
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await dispatch("POST", "/api/v1/repos", {
            owner: "personal",
            name: "own",
            visibility: "private",
          })
        ).status,
      ).toBe(eligible ? 201 : 403);
      const listed = (await (
        await dispatch("GET", "/api/v1/repos")
      ).json()) as { repositories: Array<{ name: string }> };
      expect(listed.repositories.some((repo) => repo.name === "internal")).toBe(
        eligible,
      );
      expect(
        (await dispatch("GET", "/api/v1/repos/acme/internal/tree")).status,
      ).toBe(eligible ? 200 : 404);
      expect(
        (
          await dispatch("POST", "/api/v1/repos/acme/public/forks", {
            owner: "forks",
            name: "copy",
          })
        ).status,
      ).toBe(eligible ? 201 : 403);
      expect(
        (await dispatch("POST", "/api/v1/orgs", { login: "new-org" })).status,
      ).toBe(eligible ? 201 : 403);
      if (eligible)
        expect(
          (
            await dispatch("PATCH", "/api/v1/repos/personal/own", {
              description: "allowed",
            })
          ).status,
        ).toBe(200);
      // Current membership is request evidence, not a cached principal grant.
      claims = {
        sub: "ordinary_account",
        takosumi: { capsule_id: "capsule_git" },
      };
      expect(
        (await dispatch("GET", "/api/v1/repos/acme/internal")).status,
      ).toBe(404);
      expect(
        (
          await dispatch("POST", "/api/v1/repos", {
            owner: "another",
            name: "denied",
          })
        ).status,
      ).toBe(403);
      userInfoFailure = 503;
      const unavailable = await dispatch(
        "GET",
        "/api/v1/repos/acme/public",
      );
      expect(unavailable.status).toBe(503);
      expect(unavailable.headers.get("set-cookie")).toBeNull();

      userInfoFailure = 401;
      const expired = await dispatch("GET", "/api/v1/repos/acme/public");
      expect(expired.status).toBe(401);
      expect(expired.headers.get("set-cookie")).toContain(
        "takos_git_session=;",
      );
      expect(await expired.json()).toMatchObject({
        error: { code: "session_expired" },
      });
    });
  }
});
