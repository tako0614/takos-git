/**
 * Actions-feature route registration.
 *
 * Mirrors the other Phase-3 features: every route is `auth:"public"` and gates
 * inside its handler via `requireRepoAccess`, so anonymous, browser, and
 * Interface-OAuth callers share one path. worker.ts adds one import + one call.
 */

import type { Route, RouteRegistry } from "../../router.ts";
import { actionsHandlers } from "./http.ts";

const RR = "/api/v1/repos/:owner/:repo";

const actionsRoutes: readonly Route[] = [
  // --- workflows ---
  { method: "GET", path: `${RR}/actions/workflows`, auth: "public", handler: actionsHandlers.listWorkflows },

  // --- runs ---
  { method: "GET", path: `${RR}/actions/runs`, auth: "public", handler: actionsHandlers.listRuns },
  { method: "POST", path: `${RR}/actions/runs`, auth: "public", handler: actionsHandlers.dispatchRun },
  { method: "GET", path: `${RR}/actions/runs/:runId`, auth: "public", handler: actionsHandlers.getRun },
  { method: "GET", path: `${RR}/actions/runs/:runId/jobs`, auth: "public", handler: actionsHandlers.getRunJobs },
  { method: "POST", path: `${RR}/actions/runs/:runId/rerun`, auth: "public", handler: actionsHandlers.rerun },
  { method: "POST", path: `${RR}/actions/runs/:runId/cancel`, auth: "public", handler: actionsHandlers.cancel },
  { method: "GET", path: `${RR}/actions/runs/:runId/artifacts`, auth: "public", handler: actionsHandlers.listArtifacts },

  // --- jobs ---
  { method: "GET", path: `${RR}/actions/jobs/:jobId`, auth: "public", handler: actionsHandlers.getJob },
  { method: "GET", path: `${RR}/actions/jobs/:jobId/logs`, auth: "public", handler: actionsHandlers.getJobLogs },

  // --- artifacts ---
  { method: "GET", path: `${RR}/actions/artifacts/:artifactId`, auth: "public", handler: actionsHandlers.downloadArtifact },

  // --- secrets (write-only values; names listed) ---
  { method: "GET", path: `${RR}/actions/secrets`, auth: "public", handler: actionsHandlers.listSecrets },
  { method: "PUT", path: `${RR}/actions/secrets/:name`, auth: "public", handler: actionsHandlers.putSecret },
  { method: "DELETE", path: `${RR}/actions/secrets/:name`, auth: "public", handler: actionsHandlers.deleteSecret },
];

// Idempotency: worker.ts and tests may both register on a shared global registry.
const registered = new WeakSet<object>();

/** Register every Actions-feature route into `registry`. Idempotent per registry. */
export function registerActionsRoutes(registry: RouteRegistry): void {
  if (registered.has(registry)) return;
  registered.add(registry);
  registry.registerAll(actionsRoutes);
}

export { actionsRoutes };
