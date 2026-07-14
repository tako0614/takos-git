/**
 * Repositories + code browser client. Backs the home dashboard and every Code
 * tab view (tree / blob / commits / commit / compare / branches / tags).
 * Read routes exist today; write methods (create/patch/delete, contents) are the
 * thin M2 seam Phase-4b settings/code-edit views call.
 */
import { api, getPage, repoPath, downloadUrl, type Page, type Query } from "./client.ts";
import type { Visibility } from "./contract.ts";
import type {
  BlobResponse,
  BranchListResponse,
  CommitDetailResponse,
  CommitListResponse,
  CompareResponse,
  RepoDetail,
  RepositoryDto,
  TagDto,
  TreeResponse,
} from "./types.ts";

export const reposApi = {
  /** `GET /api/v1/repos` — repos visible to the session (cursor). */
  list(params: { limit?: number; cursor?: string | null } = {}, signal?: AbortSignal): Promise<Page<RepositoryDto>> {
    return getPage<RepositoryDto>("/api/v1/repos", "repositories", params, signal);
  },

  /** `GET /api/v1/repos/:owner/:repo` — metadata + branch/tag counts. */
  async get(owner: string, repo: string, signal?: AbortSignal): Promise<RepoDetail> {
    const body = await api.get<{ repository: RepoDetail }>(repoPath(owner, repo), undefined, signal);
    return body.repository;
  },

  /** `GET …/branches`. */
  branches(owner: string, repo: string, signal?: AbortSignal): Promise<BranchListResponse> {
    return api.get<BranchListResponse>(`${repoPath(owner, repo)}/branches`, undefined, signal);
  },

  /** `GET …/tags` (cursor). */
  tags(owner: string, repo: string, params: { limit?: number; cursor?: string | null } = {}, signal?: AbortSignal): Promise<Page<TagDto>> {
    return getPage<TagDto>(`${repoPath(owner, repo)}/tags`, "tags", params, signal);
  },

  /** `GET …/commits?ref=&path=&limit=`. */
  commits(owner: string, repo: string, query: { ref?: string; path?: string; limit?: number } = {}, signal?: AbortSignal): Promise<CommitListResponse> {
    return api.get<CommitListResponse>(`${repoPath(owner, repo)}/commits`, query as Query, signal);
  },

  /** `GET …/commits/:sha` — single commit + diff vs first parent. */
  commit(owner: string, repo: string, sha: string, signal?: AbortSignal): Promise<CommitDetailResponse> {
    return api.get<CommitDetailResponse>(`${repoPath(owner, repo)}/commits/${encodeURIComponent(sha)}`, undefined, signal);
  },

  /** `GET …/compare/:base...:head`. */
  compare(owner: string, repo: string, spec: string, signal?: AbortSignal): Promise<CompareResponse> {
    return api.get<CompareResponse>(`${repoPath(owner, repo)}/compare/${spec}`, undefined, signal);
  },

  /** `GET …/tree?ref=&path=`. */
  tree(owner: string, repo: string, query: { ref?: string; path?: string } = {}, signal?: AbortSignal): Promise<TreeResponse> {
    return api.get<TreeResponse>(`${repoPath(owner, repo)}/tree`, query as Query, signal);
  },

  /** `GET …/blob?ref=&path=` — ≤1 MiB utf-8/base64. */
  blob(owner: string, repo: string, path: string, ref?: string, signal?: AbortSignal): Promise<BlobResponse> {
    return api.get<BlobResponse>(`${repoPath(owner, repo)}/blob`, { path, ref } as Query, signal);
  },

  /** Same-origin URL for the streamed raw bytes escape hatch (`GET …/raw/:ref/:path`). */
  rawUrl(owner: string, repo: string, ref: string, path: string): string {
    return downloadUrl(`${repoPath(owner, repo)}/raw/${encodeURIComponent(ref)}/${path.split("/").map(encodeURIComponent).join("/")}`);
  },

  // --- writes (M2 seam) -----------------------------------------------------

  /** `POST /api/v1/repos` — create a repo. */
  create(input: { owner: string; name: string; description?: string; visibility?: Visibility; defaultBranch?: string }): Promise<{ repository: RepoDetail }> {
    return api.post("/api/v1/repos", input);
  },

  /** `PATCH …` — update description/visibility/default_branch. */
  update(owner: string, repo: string, patch: Partial<{ description: string; visibility: Visibility; defaultBranch: string; isArchived: boolean }>): Promise<{ repository: RepoDetail }> {
    return api.patch(repoPath(owner, repo), patch);
  },

  /** `DELETE …` — delete a repo. */
  remove(owner: string, repo: string): Promise<void> {
    return api.del(repoPath(owner, repo));
  },

  /** `PUT …/contents/:path` — create/update a file → new commit. */
  putContents(owner: string, repo: string, path: string, input: { branch: string; message: string; content: string; sha?: string }): Promise<unknown> {
    return api.put(`${repoPath(owner, repo)}/contents/${path.split("/").map(encodeURIComponent).join("/")}`, input);
  },
};
