/**
 * Local Issues-view API helpers for endpoints the frozen `issuesApi` does not
 * expose yet: repo-label CRUD, milestone CRUD, and comment edit/delete. These
 * are thin wrappers over the frozen low-level `api` + `repoPath` from the shared
 * client (no hand-rolled fetch) so the same cookie-auth / CSRF / error-envelope
 * invariants apply. Kept inside the view dir per the Phase-4b partitioning rule;
 * the natural home is `api/issues.ts` — see the integrator note in the report.
 */
import { api, repoPath } from "../../api/client.ts";
import type { IssueCommentDto, LabelDto, MilestoneDto } from "../../api/types.ts";

export interface LabelInput {
  readonly name: string;
  readonly color: string;
  readonly description?: string | null;
}

export interface MilestoneInput {
  readonly title: string;
  readonly description?: string | null;
  readonly dueOn?: number | null;
}

export const issuesExtraApi = {
  // --- repo label CRUD (maintainer floor server-side) ----------------------
  createLabel(owner: string, repo: string, input: LabelInput): Promise<{ label: LabelDto }> {
    return api.post(`${repoPath(owner, repo)}/labels`, input);
  },
  updateLabel(
    owner: string,
    repo: string,
    name: string,
    patch: Partial<{ name: string; color: string; description: string | null }>,
  ): Promise<{ label: LabelDto }> {
    return api.patch(`${repoPath(owner, repo)}/labels/${encodeURIComponent(name)}`, patch);
  },
  deleteLabel(owner: string, repo: string, name: string): Promise<{ deleted: boolean }> {
    return api.del(`${repoPath(owner, repo)}/labels/${encodeURIComponent(name)}`);
  },

  // --- milestone CRUD (maintainer floor server-side) -----------------------
  createMilestone(owner: string, repo: string, input: MilestoneInput): Promise<{ milestone: MilestoneDto }> {
    return api.post(`${repoPath(owner, repo)}/milestones`, input);
  },
  updateMilestone(
    owner: string,
    repo: string,
    number: number,
    patch: Partial<{ title: string; description: string | null; state: "open" | "closed"; dueOn: number | null }>,
  ): Promise<{ milestone: MilestoneDto }> {
    return api.patch(`${repoPath(owner, repo)}/milestones/${number}`, patch);
  },
  deleteMilestone(owner: string, repo: string, number: number): Promise<{ deleted: boolean }> {
    return api.del(`${repoPath(owner, repo)}/milestones/${number}`);
  },

  // --- issue comment edit / delete (author|maintainer floor server-side) ---
  editComment(owner: string, repo: string, commentId: string, body: string): Promise<{ comment: IssueCommentDto }> {
    return api.patch(`${repoPath(owner, repo)}/issues/comments/${encodeURIComponent(commentId)}`, { body });
  },
  deleteComment(owner: string, repo: string, commentId: string): Promise<{ deleted: boolean }> {
    return api.del(`${repoPath(owner, repo)}/issues/comments/${encodeURIComponent(commentId)}`);
  },
};
