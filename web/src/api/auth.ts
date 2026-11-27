/**
 * Browser session wiring. The SPA authenticates ONLY through the HttpOnly OIDC
 * cookie session (`/api/auth/*`); it never handles Interface OAuth bearers.
 */
import { api, ApiError } from "./client.ts";
import type { SessionState } from "./types.ts";

/** `GET /api/auth/session` — `{ authenticated, user }` or `{ authenticated:false, configured }`. */
export async function fetchSession(signal?: AbortSignal): Promise<SessionState> {
  try {
    return await api.get<SessionState>("/api/auth/session", undefined, signal);
  } catch (error) {
    // The API client has already restarted the browser login flow.
    if (error instanceof ApiError && error.isSessionExpired) {
      return { authenticated: false, configured: true };
    }
    throw error;
  }
}

/** Redirect target that returns to `returnTo` after the OIDC round-trip. */
export function signInHref(returnTo: string): string {
  const safe = returnTo && returnTo.startsWith("/") ? returnTo : "/";
  return `/api/auth/login?return_to=${encodeURIComponent(safe)}`;
}

/** `POST /api/auth/logout`, then hard-reload so all state resets. */
export async function signOut(): Promise<void> {
  await api.post("/api/auth/logout");
  if (typeof location !== "undefined") location.reload();
}
