/**
 * Checks-feature route registration (check runs + commit statuses).
 *
 * Mirrors `src/features/repos/routes.ts`: every route is `auth:"public"` and gates
 * inside its handler via `requireRepoAccess`, so anonymous, browser, and
 * Interface-OAuth callers share one path. worker.ts adds one import + one call.
 */

import type { Route, RouteRegistry } from "../../router.ts";
import { checksHandlers } from "./http.ts";

const RR = "/api/v1/repos/:owner/:repo";

const checksRoutes: readonly Route[] = [
  // --- check runs ---
  { method: "POST", path: `${RR}/check-runs`, auth: "public", handler: checksHandlers.createCheckRun },
  { method: "GET", path: `${RR}/check-runs/:checkRunId`, auth: "public", handler: checksHandlers.getCheckRun },
  { method: "PATCH", path: `${RR}/check-runs/:checkRunId`, auth: "public", handler: checksHandlers.updateCheckRun },
  { method: "GET", path: `${RR}/commits/:sha/check-runs`, auth: "public", handler: checksHandlers.listCheckRuns },

  // --- commit statuses ---
  { method: "POST", path: `${RR}/statuses/:sha`, auth: "public", handler: checksHandlers.createCommitStatus },
  { method: "GET", path: `${RR}/commits/:sha/statuses`, auth: "public", handler: checksHandlers.listCommitStatuses },
  { method: "GET", path: `${RR}/commits/:sha/status`, auth: "public", handler: checksHandlers.combinedStatus },
];

// Idempotency: worker.ts and tests may both register on a shared global registry.
const registered = new WeakSet<object>();

/** Register every checks-feature route into `registry`. Idempotent per registry. */
export function registerChecksRoutes(registry: RouteRegistry): void {
  if (registered.has(registry)) return;
  registered.add(registry);
  registry.registerAll(checksRoutes);
}

export { checksRoutes };
