/**
 * `/api/auth/*` browser-OIDC endpoints + the `/api/v1` tail.
 *
 * The `/api/v1` forge surface (repos CRUD, code browser, collaborators, teams,
 * branch protection) now lives on the router + per-repo ACL under
 * `src/features/repos/`. This module keeps only the browser-auth handler (login /
 * callback / session / logout) and a JSON 404 for any `/api/v1` path that matched
 * no registered route — so a stray API path never falls through to the SPA/git
 * handlers.
 */

import {
  handleBrowserAuth,
  type BrowserAuthEnv,
  type OAuthFetch,
} from "./browser-auth.ts";
import { errorBody } from "./contract/v1.ts";
import type { ObjectStoreBinding } from "./git/types.ts";

export interface ForgeApiEnv extends BrowserAuthEnv {
  BUCKET: ObjectStoreBinding;
  APP_URL?: string;
  APP_CAPSULE_ID?: string;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export async function handleForgeApi(
  request: Request,
  env: ForgeApiEnv,
  interfaceUserInfoFetch?: OAuthFetch,
): Promise<Response | null> {
  const authResponse = await handleBrowserAuth(
    request,
    env,
    interfaceUserInfoFetch ?? fetch,
  );
  if (authResponse) return authResponse;

  const url = new URL(request.url);
  if (url.pathname === "/api/v1" || url.pathname.startsWith("/api/v1/")) {
    // Reaches here only when the router matched no `/api/v1` route.
    return json(errorBody("not_found", "Not Found"), 404);
  }
  return null;
}
