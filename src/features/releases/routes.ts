/**
 * Releases / assets / tags route registration — mirrors
 * `src/features/repos/routes.ts`. Every route registers `auth:"public"` and gates
 * inside its handler via `requireRepoAccess`, so the one shared path serves
 * anonymous, browser, and Interface-OAuth callers. The integrator adds exactly one
 * import + one `registerReleaseRoutes(registry)` call in worker.ts.
 */

import type { Route, RouteRegistry } from "../../router.ts";
import { releaseHandlers } from "./releases.ts";
import { assetHandlers } from "./assets.ts";
import { tagHandlers } from "./tags.ts";

const RR = "/api/v1/repos/:owner/:repo";

const releaseRoutes: readonly Route[] = [
  // --- releases ---
  { method: "GET", path: `${RR}/releases`, auth: "public", handler: releaseHandlers.list },
  { method: "POST", path: `${RR}/releases`, auth: "public", handler: releaseHandlers.create },
  { method: "GET", path: `${RR}/releases/latest`, auth: "public", handler: releaseHandlers.latest },
  { method: "GET", path: `${RR}/releases/:tag`, auth: "public", handler: releaseHandlers.get },
  { method: "PATCH", path: `${RR}/releases/:tag`, auth: "public", handler: releaseHandlers.patch },
  { method: "DELETE", path: `${RR}/releases/:tag`, auth: "public", handler: releaseHandlers.remove },

  // --- release assets (delete-by-id sits ABOVE the :tag/assets prefix so it is
  //     matched distinctly; both are registered, the router disambiguates) ---
  { method: "GET", path: `${RR}/releases/:tag/assets`, auth: "public", handler: assetHandlers.list },
  { method: "POST", path: `${RR}/releases/:tag/assets`, auth: "public", handler: assetHandlers.upload },
  { method: "GET", path: `${RR}/releases/:tag/assets/:id/download`, auth: "public", handler: assetHandlers.download },
  { method: "DELETE", path: `${RR}/releases/assets/:id`, auth: "public", handler: assetHandlers.remove },

  // --- tags ---
  { method: "GET", path: `${RR}/tags`, auth: "public", handler: tagHandlers.list },
  { method: "POST", path: `${RR}/tags`, auth: "public", handler: tagHandlers.create },
  { method: "DELETE", path: `${RR}/tags/:name`, auth: "public", handler: tagHandlers.remove },
];

const registered = new WeakSet<object>();

/** Register every releases/assets/tags route into `registry`. Idempotent. */
export function registerReleaseRoutes(registry: RouteRegistry): void {
  if (registered.has(registry)) return;
  registered.add(registry);
  registry.registerAll(releaseRoutes);
}

export { releaseRoutes };
