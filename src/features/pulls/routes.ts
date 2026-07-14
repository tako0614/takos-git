/**
 * Pulls feature route registration — one `registerPullRoutes(registry)` the
 * integrator wires into worker.ts with a single import + call (mirrors
 * `registerRepoRoutes`). Every route registers as `auth:"public"` and gates
 * inside its handler via `requireRepoAccess` (the Phase-3a shared-surface
 * pattern): one path serves anonymous/browser/interface callers.
 *
 * Route → action → role floor (enforced by the frozen ACL):
 *   reads            → contents.read  (reader; anon on public)
 *   open/update/close/reopen/reviews/comments → pulls.write (reader floor;
 *       author-or-maintainer enforced in-handler for update/close/reopen/edit)
 *   merge/resolve    → pulls.merge    (writer floor; branch protection may raise
 *       to maintainer + required approvals/checks, enforced at merge time)
 */

import type { Route, RouteRegistry } from "../../router.ts";
import { crudHandlers } from "./pull-crud.ts";
import { reviewHandlers } from "./reviews.ts";
import { commentHandlers } from "./comments.ts";
import { mergeHandlers } from "./merge-handlers.ts";

const RR = "/api/v1/repos/:owner/:repo";
const P = `${RR}/pulls`;
const PN = `${P}/:number`;

const pullRoutes: readonly Route[] = [
  // --- lifecycle ---
  { method: "POST", path: P, auth: "public", handler: crudHandlers.open },
  { method: "GET", path: P, auth: "public", handler: crudHandlers.list },
  { method: "GET", path: PN, auth: "public", handler: crudHandlers.get },
  { method: "PATCH", path: PN, auth: "public", handler: crudHandlers.update },
  { method: "POST", path: `${PN}/close`, auth: "public", handler: crudHandlers.close },
  { method: "POST", path: `${PN}/reopen`, auth: "public", handler: crudHandlers.reopen },

  // --- diff / files / commits ---
  { method: "GET", path: `${PN}/diff`, auth: "public", handler: crudHandlers.diff },
  { method: "GET", path: `${PN}/files`, auth: "public", handler: crudHandlers.files },
  { method: "GET", path: `${PN}/commits`, auth: "public", handler: crudHandlers.commits },

  // --- conflicts / resolve / merge ---
  { method: "GET", path: `${PN}/conflicts`, auth: "public", handler: mergeHandlers.conflicts },
  { method: "POST", path: `${PN}/resolve`, auth: "public", handler: mergeHandlers.resolve },
  { method: "POST", path: `${PN}/merge`, auth: "public", handler: mergeHandlers.merge },

  // --- reviews ---
  { method: "POST", path: `${PN}/reviews`, auth: "public", handler: reviewHandlers.submit },
  { method: "GET", path: `${PN}/reviews`, auth: "public", handler: reviewHandlers.list },

  // --- inline review comments ---
  { method: "POST", path: `${PN}/comments`, auth: "public", handler: commentHandlers.create },
  { method: "GET", path: `${PN}/comments`, auth: "public", handler: commentHandlers.list },
  { method: "PATCH", path: `${P}/comments/:id`, auth: "public", handler: commentHandlers.edit },
  { method: "DELETE", path: `${P}/comments/:id`, auth: "public", handler: commentHandlers.remove },
];

// Idempotency: worker.ts and tests may both register on a shared registry.
const registered = new WeakSet<object>();

/** Register every pulls-feature route into `registry`. Idempotent per registry. */
export function registerPullRoutes(registry: RouteRegistry): void {
  if (registered.has(registry)) return;
  registered.add(registry);
  registry.registerAll(pullRoutes);
}

export { pullRoutes };
