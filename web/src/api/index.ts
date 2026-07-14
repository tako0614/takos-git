/**
 * API client barrel. Phase-4b views import their feature client from here:
 *
 *   import { reposApi, issuesApi, ApiError } from "../../api";
 *
 * Every method is a thin, typed wrapper over the same-origin `/api/v1` surface
 * with cookie auth, the standard error envelope, and `?limit&cursor` pagination.
 */
export * from "./client.ts";
export * from "./auth.ts";
export * from "./contract.ts";
export type * from "./types.ts";

export { reposApi } from "./repos.ts";
export { issuesApi } from "./issues.ts";
export type { IssueListFilter } from "./issues.ts";
export { pullsApi } from "./pulls.ts";
export type { PullListFilter } from "./pulls.ts";
export { releasesApi } from "./releases.ts";
export { actionsApi } from "./actions.ts";
export type { RunListFilter } from "./actions.ts";
export { checksApi } from "./checks.ts";
export { collaboratorsApi, branchProtectionApi, webhooksApi } from "./admin.ts";
