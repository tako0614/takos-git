export type { TakosActorContext } from "takos-paas-contract/internal-rpc";

export interface GitRepositorySummary {
  id: string;
  name: string;
  ownerAccountId: string;
  defaultBranch: string;
}

export interface GitRefSummary {
  name: string;
  target: string;
}

export interface GitRepositoryDetail extends GitRepositorySummary {
  refs: GitRefSummary[];
  createdAt: string;
  updatedAt: string;
}

export interface GitCreateRepositoryRequest {
  id: string;
  name: string;
  ownerAccountId: string;
  defaultBranch?: string;
  refs?: GitRefSummary[] | Record<string, string>;
}

export interface GitUpdateRepositoryRequest {
  name?: string;
  ownerAccountId?: string;
  defaultBranch?: string;
  refs?: GitRefSummary[] | Record<string, string>;
}

export interface GitResolveSourceRequest {
  repositoryId: string;
  sourceRef: string;
}

export interface GitResolveSourceResponse {
  repositoryId: string;
  sourceRef: string;
  resolvedCommit: string;
  resolvedRef?: string;
}

export const TAKOS_GIT_INTERNAL_PATHS = {
  repositories: "/internal/repositories",
  repository: (repositoryId: string): string =>
    `/internal/repositories/${encodeURIComponent(repositoryId)}`,
  repositoryRefs: (repositoryId: string): string =>
    `/internal/repositories/${encodeURIComponent(repositoryId)}/refs`,
  objects: "/internal/objects",
  object: (repositoryId: string, objectId: string): string =>
    `/internal/objects/${encodeURIComponent(repositoryId)}/${
      encodeURIComponent(objectId)
    }`,
  resolveSource: "/internal/source/resolve",
} as const;

export const TAKOS_GIT_CAPABILITIES = {
  repoRead: "git.repo.read",
  repoWrite: "git.repo.write",
  objectRead: "git.object.read",
  refResolve: "git.ref.resolve",
} as const;
