/**
 * Repos feature public surface.
 *
 * `registerRepoRoutes(routes)` is the single call worker.ts makes to mount this
 * feature. The service exports below are the seams Phase-3b feature agents (issues
 * / pulls / releases / forks / webhooks / checks) reuse — owner provisioning, the
 * repo D1 model, and the shared best-effort identity resolver + ACL wrappers — so
 * they never reinvent auth or namespace logic.
 */

export { registerRepoRoutes } from "./routes.ts";

export {
  ensureUserOwner,
  resolveOwner,
  createOrgOwner,
  orgMembershipRole,
  ensurePrincipalBySubject,
  isValidOwnerLogin,
  OwnerConflictError,
  type OwnerRow,
} from "./owners.ts";

export {
  provisionRepo,
  updateRepo,
  deleteRepository,
  getRepoRow,
  listReadableRepos,
  toRepositoryDto,
  cloneUrlFor,
  isValidRepoNameSegment,
  isValidVisibility,
  repoRefCounts,
  type RepoRow,
} from "./repositories.ts";

export {
  resolveIdentity,
  requireRepoAccess,
  csrfGuard,
  type RepoAccess,
} from "./identity.ts";
