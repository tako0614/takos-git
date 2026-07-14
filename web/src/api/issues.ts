/**
 * Issues, comments, labels, milestones client. Backs the Issues views. A PR is
 * an issue with a branch pair, so PR conversation comments reuse `comments()`.
 */
import { api, getPage, repoPath, type Page, type Query } from "./client.ts";
import type {
  IssueCommentDto,
  IssueDto,
  LabelDto,
  MilestoneDto,
} from "./types.ts";

export interface IssueListFilter {
  readonly state?: "open" | "closed" | "all";
  readonly label?: string;
  readonly assignee?: string;
  readonly milestone?: number;
  readonly limit?: number;
  readonly cursor?: string | null;
}

export const issuesApi = {
  list(owner: string, repo: string, filter: IssueListFilter = {}, signal?: AbortSignal): Promise<Page<IssueDto>> {
    const { limit, cursor, ...rest } = filter;
    // State/label/assignee/milestone filters ride as query params on the same GET.
    const path = withFilters(`${repoPath(owner, repo)}/issues`, rest as Query);
    return getPage<IssueDto>(path, "issues", { limit, cursor }, signal);
  },

  get(owner: string, repo: string, number: number, signal?: AbortSignal): Promise<{ issue: IssueDto }> {
    return api.get(`${repoPath(owner, repo)}/issues/${number}`, undefined, signal);
  },

  comments(owner: string, repo: string, number: number, params: { limit?: number; cursor?: string | null } = {}, signal?: AbortSignal): Promise<Page<IssueCommentDto>> {
    return getPage<IssueCommentDto>(`${repoPath(owner, repo)}/issues/${number}/comments`, "comments", params, signal);
  },

  labels(owner: string, repo: string, signal?: AbortSignal): Promise<Page<LabelDto>> {
    return getPage<LabelDto>(`${repoPath(owner, repo)}/labels`, "labels", {}, signal);
  },

  milestones(owner: string, repo: string, signal?: AbortSignal): Promise<Page<MilestoneDto>> {
    return getPage<MilestoneDto>(`${repoPath(owner, repo)}/milestones`, "milestones", {}, signal);
  },

  // --- writes ---------------------------------------------------------------

  create(owner: string, repo: string, input: { title: string; body?: string; labels?: string[]; assignees?: string[]; milestone?: number }): Promise<{ issue: IssueDto }> {
    return api.post(`${repoPath(owner, repo)}/issues`, input);
  },

  update(owner: string, repo: string, number: number, patch: Partial<{ title: string; body: string; state: "open" | "closed"; labels: string[]; assignees: string[]; milestone: number | null }>): Promise<{ issue: IssueDto }> {
    return api.patch(`${repoPath(owner, repo)}/issues/${number}`, patch);
  },

  comment(owner: string, repo: string, number: number, body: string): Promise<{ comment: IssueCommentDto }> {
    return api.post(`${repoPath(owner, repo)}/issues/${number}/comments`, { body });
  },
};

function withFilters(path: string, filters: Query): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}
