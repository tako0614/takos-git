/**
 * Issues-feature route registration. Mirrors `../repos/routes.ts`: every route is
 * `auth: "public"` and gates inside its handler through `requireRepoAccess`
 * (anon/browser/Interface share one path). The integrator adds a single import +
 * `registerIssuesRoutes(registry)` call in worker.ts.
 *
 * Route → action → floor summary (all under `/api/v1/repos/:owner/:repo`):
 *   GET  issues                          contents.read  reader
 *   POST issues                          issues.write   writer
 *   GET  issues/:number                  contents.read  reader
 *   PATCH issues/:number                 issues.write   writer (+author|maintainer for title/body)
 *   POST issues/:number/close|reopen     issues.write   writer
 *   GET  issues/:number/comments         contents.read  reader
 *   POST issues/:number/comments         issues.write   writer
 *   PATCH/DELETE issues/comments/:id     issues.write   writer (+author|maintainer)
 *   PUT/POST issues/:number/labels       issues.write   writer
 *   DELETE issues/:number/labels/:name   issues.write   writer
 *   GET  labels                          contents.read  reader
 *   POST labels                          repo.admin     maintainer
 *   PATCH/DELETE labels/:name            repo.admin     maintainer
 *   GET  milestones                      contents.read  reader
 *   POST milestones                      repo.admin     maintainer
 *   GET  milestones/:number              contents.read  reader
 *   PATCH/DELETE milestones/:number      repo.admin     maintainer
 */

import type { Route, RouteRegistry } from "../../router.ts";
import { commentHandlers } from "./comments.ts";
import { issueHandlers } from "./issues.ts";
import { labelHandlers } from "./labels.ts";
import { milestoneHandlers } from "./milestones.ts";

const RR = "/api/v1/repos/:owner/:repo";

const issueRoutes: readonly Route[] = [
  // --- issues ---
  { method: "GET", path: `${RR}/issues`, auth: "public", handler: issueHandlers.list },
  { method: "POST", path: `${RR}/issues`, auth: "public", handler: issueHandlers.open },

  // comment-by-id (registered before `/issues/:number` param routes for clarity;
  // segment counts differ so there is no actual pattern ambiguity).
  { method: "PATCH", path: `${RR}/issues/comments/:id`, auth: "public", handler: commentHandlers.patch },
  { method: "DELETE", path: `${RR}/issues/comments/:id`, auth: "public", handler: commentHandlers.remove },

  { method: "GET", path: `${RR}/issues/:number`, auth: "public", handler: issueHandlers.get },
  { method: "PATCH", path: `${RR}/issues/:number`, auth: "public", handler: issueHandlers.patch },
  { method: "POST", path: `${RR}/issues/:number/close`, auth: "public", handler: issueHandlers.close },
  { method: "POST", path: `${RR}/issues/:number/reopen`, auth: "public", handler: issueHandlers.reopen },

  // --- issue conversation comments ---
  { method: "GET", path: `${RR}/issues/:number/comments`, auth: "public", handler: commentHandlers.list },
  { method: "POST", path: `${RR}/issues/:number/comments`, auth: "public", handler: commentHandlers.create },

  // --- issue label assignment (triage) ---
  { method: "PUT", path: `${RR}/issues/:number/labels`, auth: "public", handler: labelHandlers.setIssueLabels },
  { method: "POST", path: `${RR}/issues/:number/labels`, auth: "public", handler: labelHandlers.addIssueLabels },
  { method: "DELETE", path: `${RR}/issues/:number/labels/:name`, auth: "public", handler: labelHandlers.removeIssueLabel },

  // --- repo labels ---
  { method: "GET", path: `${RR}/labels`, auth: "public", handler: labelHandlers.list },
  { method: "POST", path: `${RR}/labels`, auth: "public", handler: labelHandlers.create },
  { method: "PATCH", path: `${RR}/labels/:name`, auth: "public", handler: labelHandlers.patch },
  { method: "DELETE", path: `${RR}/labels/:name`, auth: "public", handler: labelHandlers.remove },

  // --- milestones ---
  { method: "GET", path: `${RR}/milestones`, auth: "public", handler: milestoneHandlers.list },
  { method: "POST", path: `${RR}/milestones`, auth: "public", handler: milestoneHandlers.create },
  { method: "GET", path: `${RR}/milestones/:number`, auth: "public", handler: milestoneHandlers.get },
  { method: "PATCH", path: `${RR}/milestones/:number`, auth: "public", handler: milestoneHandlers.patch },
  { method: "DELETE", path: `${RR}/milestones/:number`, auth: "public", handler: milestoneHandlers.remove },
];

// Idempotency: worker.ts and tests may both register on a shared registry.
const registered = new WeakSet<object>();

/** Register every issues-feature route into `registry`. Idempotent per registry. */
export function registerIssuesRoutes(registry: RouteRegistry): void {
  if (registered.has(registry)) return;
  registered.add(registry);
  registry.registerAll(issueRoutes);
}

export { issueRoutes };
