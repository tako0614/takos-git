/**
 * Repos feature route registration — the append-only surface Phase-3b agents
 * copy: each feature exports a `registerXRoutes(registry)` and worker.ts adds one
 * import + one call.
 *
 * Every route here declares `auth: "public"`: the frozen router allows exactly one
 * mechanism per route, but the forge surface must serve anonymous, browser, and
 * Interface-OAuth callers on the SAME path. Each handler resolves the richest
 * available credential (`resolveIdentity`) and then gates through the frozen
 * `authorizeRepo` ACL — enforcement is centralized in `identity.ts`, so a route
 * cannot be added without an ACL check.
 */

import type { Route, RouteRegistry } from "../../router.ts";
import { branchProtectionHandlers } from "./branch-protection.ts";
import { codeBrowserHandlers, listReposHandler } from "./code-browser.ts";
import { collaboratorHandlers } from "./collaborators.ts";
import { repoAdminHandlers } from "./repo-admin.ts";

const R = "/api/v1/repos";
const RR = "/api/v1/repos/:owner/:repo";
const ORG = "/api/v1/orgs/:org";

const repoRoutes: readonly Route[] = [
  // --- repository CRUD ---
  { method: "GET", path: R, auth: "public", handler: listReposHandler },
  { method: "POST", path: R, auth: "public", handler: repoAdminHandlers.create },
  { method: "GET", path: RR, auth: "public", handler: codeBrowserHandlers.info },
  { method: "PATCH", path: RR, auth: "public", handler: repoAdminHandlers.patch },
  { method: "DELETE", path: RR, auth: "public", handler: repoAdminHandlers.remove },

  // --- code browser reads ---
  { method: "GET", path: `${RR}/branches`, auth: "public", handler: codeBrowserHandlers.branches },
  { method: "GET", path: `${RR}/commits`, auth: "public", handler: codeBrowserHandlers.commits },
  { method: "GET", path: `${RR}/commits/:sha`, auth: "public", handler: codeBrowserHandlers.commitDetail },
  { method: "GET", path: `${RR}/compare/:spec`, auth: "public", handler: codeBrowserHandlers.compare },
  { method: "GET", path: `${RR}/tree`, auth: "public", handler: codeBrowserHandlers.tree },
  { method: "GET", path: `${RR}/blob`, auth: "public", handler: codeBrowserHandlers.blob },
  { method: "GET", path: `${RR}/blame`, auth: "public", handler: codeBrowserHandlers.blame },

  // --- collaborators ---
  { method: "GET", path: `${RR}/collaborators`, auth: "public", handler: collaboratorHandlers.listCollaborators },
  { method: "PUT", path: `${RR}/collaborators/:principal`, auth: "public", handler: collaboratorHandlers.putCollaborator },
  { method: "DELETE", path: `${RR}/collaborators/:principal`, auth: "public", handler: collaboratorHandlers.deleteCollaborator },

  // --- team access on a repo ---
  { method: "PUT", path: `${RR}/teams/:team`, auth: "public", handler: collaboratorHandlers.putTeamRepoAccess },
  { method: "DELETE", path: `${RR}/teams/:team`, auth: "public", handler: collaboratorHandlers.deleteTeamRepoAccess },

  // --- branch protection ---
  { method: "GET", path: `${RR}/branch-protection`, auth: "public", handler: branchProtectionHandlers.listRules },
  { method: "GET", path: `${RR}/branch-protection/:pattern`, auth: "public", handler: branchProtectionHandlers.getRule },
  { method: "PUT", path: `${RR}/branch-protection/:pattern`, auth: "public", handler: branchProtectionHandlers.putRule },
  { method: "DELETE", path: `${RR}/branch-protection/:pattern`, auth: "public", handler: branchProtectionHandlers.deleteRule },

  // --- orgs & teams ---
  { method: "POST", path: "/api/v1/orgs", auth: "public", handler: repoAdminHandlers.createOrg },
  { method: "GET", path: `${ORG}/teams`, auth: "public", handler: collaboratorHandlers.listTeams },
  { method: "POST", path: `${ORG}/teams`, auth: "public", handler: collaboratorHandlers.createTeam },
  { method: "PUT", path: `${ORG}/teams/:team/members/:principal`, auth: "public", handler: collaboratorHandlers.putTeamMember },
  { method: "DELETE", path: `${ORG}/teams/:team/members/:principal`, auth: "public", handler: collaboratorHandlers.deleteTeamMember },
];

// Idempotency: worker.ts and tests may both call this on the shared global
// registry; register each registry at most once.
const registered = new WeakSet<object>();

/** Register every repos-feature route into `registry`. Idempotent per registry. */
export function registerRepoRoutes(registry: RouteRegistry): void {
  if (registered.has(registry)) return;
  registered.add(registry);
  registry.registerAll(repoRoutes);
}

export { repoRoutes };
