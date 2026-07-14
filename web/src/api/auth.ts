/**
 * Browser session wiring. The SPA authenticates ONLY through the HttpOnly OIDC
 * cookie session (`/api/auth/*`); it never handles Interface OAuth bearers.
 */
import { api } from "./client.ts";
import type { SessionState } from "./types.ts";

/** `GET /api/auth/session` — `{ authenticated, user }` or `{ authenticated:false, configured }`. */
export function fetchSession(signal?: AbortSignal): Promise<SessionState> {
  return api.get<SessionState>("/api/auth/session", undefined, signal);
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
