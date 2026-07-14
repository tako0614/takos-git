/**
 * Forks feature public surface.
 *
 * `registerForkRoutes(registry)` is the single call worker.ts makes to mount
 * fork + upstream-sync (POST fork, GET forks list, GET network, POST sync). The
 * service exports are the reusable seams (fork mechanics, network walk, R2 object
 * copy) other features/tests can drive directly.
 */

export { registerForkRoutes, forkHandlers, forkRoutes } from "./routes.ts";

export {
  forkRepository,
  syncFork,
  copyRepoObjects,
  listForkChildren,
  forkNetworkRoot,
  forkNetworkMembers,
  resolveUpstream,
  getRepoById,
  getRepoByOwnerName,
  toRepositoryDtoFull,
  type RepoFullRow,
  type ForkOutcome,
  type SyncOutcome,
} from "./service.ts";
