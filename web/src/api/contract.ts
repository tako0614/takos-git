/**
 * The single crossing point between the SPA and the worker's versioned wire
 * contract. The core `/api/v1` vocabulary — roles, visibility, the repository
 * DTO, scopes, the pagination + error envelope — is imported DIRECTLY from the
 * worker's canonical `src/contract/v1.ts` (it is dependency-free, so no worker
 * runtime leaks into the bundle). Feature-specific DTOs (issues, pulls,
 * releases, actions, checks) live in their server `features/<x>/dto.ts` files
 * which pull in server-only imports (`DbClient`), so those are MIRRORED locally
 * in `./types.ts` instead — the one place the two sides are kept in sync by
 * review. Vite `server.fs.allow` grants dev-server read access to the file.
 */

export type {
  Role,
  Visibility,
  Scope,
  OwnerType,
  OwnerDto,
  PrincipalKind,
  PrincipalDto,
  RepositoryDto,
  RepoAction,
  PaginationParams,
  // The wire error-envelope shape. Named `ApiErrorBody` to avoid colliding with
  // the runtime `ApiError` class the fetch client throws.
  ApiError as ApiErrorBody,
} from "../../../src/contract/v1.ts";

export {
  ROLE_ORDER,
  roleRank,
  roleAtLeast,
  maxRole,
  SCOPES,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
} from "../../../src/contract/v1.ts";
