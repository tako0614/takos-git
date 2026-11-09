/**
 * Pull requests, reviews, inline comments, merge/conflicts client. Backs the
 * Pull requests views (list / detail / diff / files / conflicts / merge).
 */
import { api, getPage, repoPath, type Page, type Query } from "./client.ts";
import type {
  CommitSummary,
  DiffPayload,
  PullRequestDto,
  ReviewCommentDto,
  ReviewDto,
} from "./types.ts";

export interface PullListFilter {
  readonly state?: "open" | "closed" | "all";
  readonly limit?: number;
  readonly cursor?: string | null;
}

interface PullEnvelope {
  readonly pull_request: PullRequestDto;
}

function unwrapPull(response: PullEnvelope): { pull: PullRequestDto } {
  return { pull: response.pull_request };
}

export const pullsApi = {
  list(owner: string, repo: string, filter: PullListFilter = {}, signal?: AbortSignal): Promise<Page<PullRequestDto>> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(filter as Query)) if (v != null && v !== "") params.set(k, String(v));
    const qs = params.toString();
    return getPage<PullRequestDto>(`${repoPath(owner, repo)}/pulls${qs ? `?${qs}` : ""}`, "pull_requests", {}, signal);
  },

  get(owner: string, repo: string, number: number, signal?: AbortSignal): Promise<{ pull: PullRequestDto }> {
    return api.get<PullEnvelope>(`${repoPath(owner, repo)}/pulls/${number}`, undefined, signal).then(unwrapPull);
  },

  diff(owner: string, repo: string, number: number, signal?: AbortSignal): Promise<DiffPayload> {
    return api.get<DiffPayload>(`${repoPath(owner, repo)}/pulls/${number}/diff`, undefined, signal);
  },

  files(owner: string, repo: string, number: number, params: { limit?: number; cursor?: string | null } = {}, signal?: AbortSignal): Promise<Page<DiffPayload["files"][number]>> {
    return getPage(`${repoPath(owner, repo)}/pulls/${number}/files`, "files", params, signal);
  },

  commits(owner: string, repo: string, number: number, signal?: AbortSignal): Promise<{ commits: readonly CommitSummary[] }> {
    return api.get(`${repoPath(owner, repo)}/pulls/${number}/commits`, undefined, signal);
  },

  reviews(owner: string, repo: string, number: number, signal?: AbortSignal): Promise<Page<ReviewDto>> {
    return getPage<ReviewDto>(`${repoPath(owner, repo)}/pulls/${number}/reviews`, "reviews", {}, signal);
  },

  reviewComments(owner: string, repo: string, number: number, signal?: AbortSignal): Promise<Page<ReviewCommentDto>> {
    return getPage<ReviewCommentDto>(`${repoPath(owner, repo)}/pulls/${number}/comments`, "comments", {}, signal);
  },

  conflicts(owner: string, repo: string, number: number, signal?: AbortSignal): Promise<unknown> {
    return api.get(`${repoPath(owner, repo)}/pulls/${number}/conflicts`, undefined, signal);
  },

  // --- writes ---------------------------------------------------------------

  create(owner: string, repo: string, input: { title: string; body?: string; head: string; base: string; draft?: boolean }): Promise<{ pull: PullRequestDto }> {
    return api.post<PullEnvelope>(`${repoPath(owner, repo)}/pulls`, input).then(unwrapPull);
  },

  update(owner: string, repo: string, number: number, patch: Partial<{ title: string; body: string; base: string }>): Promise<{ pull: PullRequestDto }> {
    return api.patch<PullEnvelope>(`${repoPath(owner, repo)}/pulls/${number}`, patch).then(unwrapPull);
  },

  close(owner: string, repo: string, number: number): Promise<{ pull: PullRequestDto }> {
    return api.post<PullEnvelope>(`${repoPath(owner, repo)}/pulls/${number}/close`).then(unwrapPull);
  },

  reopen(owner: string, repo: string, number: number): Promise<{ pull: PullRequestDto }> {
    return api.post<PullEnvelope>(`${repoPath(owner, repo)}/pulls/${number}/reopen`).then(unwrapPull);
  },

  merge(owner: string, repo: string, number: number, input: { method: "merge" | "squash" | "rebase"; commitTitle?: string; commitMessage?: string }): Promise<{ pull: PullRequestDto; mergeCommit: string }> {
    const message = input.commitTitle
      ? `${input.commitTitle}${input.commitMessage ? `\n\n${input.commitMessage}` : ""}`
      : input.commitMessage;
    return api.post<PullEnvelope & { merge_commit: string }>(
      `${repoPath(owner, repo)}/pulls/${number}/merge`,
      { method: input.method, commit_message: message },
    ).then(response => ({ ...unwrapPull(response), mergeCommit: response.merge_commit }));
  },

  review(owner: string, repo: string, number: number, input: { state: "approved" | "changes_requested" | "commented"; body?: string; commitSha?: string }): Promise<{ review: ReviewDto }> {
    return api.post(`${repoPath(owner, repo)}/pulls/${number}/reviews`, input);
  },

  comment(owner: string, repo: string, number: number, input: { body: string; path: string; line: number; side?: "LEFT" | "RIGHT"; commitSha?: string }): Promise<{ comment: ReviewCommentDto }> {
    return api.post(`${repoPath(owner, repo)}/pulls/${number}/comments`, input);
  },

  resolve(owner: string, repo: string, number: number, input: unknown): Promise<unknown> {
    return api.post(`${repoPath(owner, repo)}/pulls/${number}/resolve`, input);
  },
};
