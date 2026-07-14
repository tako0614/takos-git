/**
 * Web-local mirrors of the feature wire DTOs.
 *
 * These MIRROR the canonical server shapes in `src/features/<x>/dto.ts`. They
 * are re-declared here (not imported) because those server files import
 * server-only modules (`DbClient`) that must never enter the browser bundle.
 * The pairing is intentional and kept in sync by review: if a server `*Dto`
 * changes, its mirror here changes too. Core types (Role, Visibility,
 * RepositoryDto, …) are the exception — they come straight from `./contract.ts`.
 */

import type { RepositoryDto, Visibility } from "./contract.ts";

// ============================================================================
// Session (browser OIDC — `GET /api/auth/session`)
// ============================================================================

export interface SessionUser {
  readonly subject: string;
  readonly name: string | null;
  readonly email: string | null;
}

export type SessionState =
  | { readonly authenticated: true; readonly user: SessionUser }
  | { readonly authenticated: false; readonly configured: boolean };

// ============================================================================
// Repository detail (extends the core RepositoryDto with R2-derived counts)
// ============================================================================

export interface RepoRefCounts {
  readonly branchCount: number;
  readonly tagCount: number;
}

export type RepoDetail = RepositoryDto & Partial<RepoRefCounts>;

export interface RepoListResponse {
  readonly repositories: readonly RepositoryDto[];
  readonly nextCursor: string | null;
}

// ============================================================================
// Code browser (repos/code-browser.ts)
// ============================================================================

export interface GitPerson {
  readonly name: string;
  readonly email: string;
  /** epoch ms (server serializes commit timestamps to ms). */
  readonly date: number;
}

export interface CommitSummary {
  readonly sha: string;
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: GitPerson;
  readonly committer: GitPerson;
  readonly message: string;
  /** Present only in path-filtered history. */
  readonly pathStatus?: "added" | "deleted" | "modified";
}

export interface BranchRef {
  readonly name: string;
  readonly sha: string;
  readonly default: boolean;
}

export interface TreeEntry {
  readonly name: string;
  readonly path: string;
  readonly sha: string;
  readonly mode: string;
  readonly kind: "tree" | "blob" | "gitlink";
}

export interface BranchListResponse {
  readonly repository: string;
  readonly branches: readonly BranchRef[];
}

export interface CommitListResponse {
  readonly repository: string;
  readonly branch: string;
  readonly path?: string;
  readonly commits: readonly CommitSummary[];
  readonly truncated?: boolean;
}

export interface TreeResponse {
  readonly repository: string;
  readonly branch: string;
  readonly commit: string;
  readonly path: string;
  readonly entries: readonly TreeEntry[];
}

export interface BlobResponse {
  readonly repository: string;
  readonly branch: string;
  readonly commit: string;
  readonly path: string;
  readonly sha: string;
  readonly size: number;
  readonly encoding: "utf-8" | "base64";
  readonly content: string;
}

// ============================================================================
// Diffs (git/commit-diff.ts → buildDiffPayload)
// ============================================================================

export type DiffLineType = "context" | "add" | "del";

export interface DiffLine {
  readonly type: DiffLineType;
  readonly text: string;
  readonly oldLine?: number | null;
  readonly newLine?: number | null;
}

export interface DiffHunk {
  readonly header: string;
  readonly lines: readonly DiffLine[];
}

export type FileDiffStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied";

export interface FileDiff {
  readonly path: string;
  readonly oldPath?: string | null;
  readonly status: FileDiffStatus;
  readonly additions: number;
  readonly deletions: number;
  readonly binary: boolean;
  readonly hunks?: readonly DiffHunk[];
}

export interface DiffPayload {
  readonly base: string | null;
  readonly files: readonly FileDiff[];
}

export interface CommitDetailResponse {
  readonly repository: string;
  readonly commit: CommitSummary;
  readonly diff: DiffPayload;
}

export interface CompareResponse {
  readonly repository: string;
  readonly status: "identical" | "ahead" | "behind" | "diverged";
  readonly ahead: number;
  readonly behind: number;
  readonly mergeBaseSha: string | null;
  readonly commits: readonly CommitSummary[];
  readonly diff: DiffPayload;
}

// ============================================================================
// Issues / labels / milestones (features/issues/dto.ts)
// ============================================================================

export interface PrincipalRef {
  readonly id: string;
  readonly subject: string;
  readonly displayName: string | null;
}

export interface LabelDto {
  readonly name: string;
  readonly color: string;
  readonly description: string | null;
  readonly createdAt: number;
}

export interface MilestoneDto {
  readonly number: number;
  readonly title: string;
  readonly description: string | null;
  readonly state: "open" | "closed";
  readonly dueOn: number | null;
  readonly openIssues: number;
  readonly closedIssues: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly closedAt: number | null;
}

export interface IssueMilestoneRef {
  readonly number: number;
  readonly title: string;
  readonly state: "open" | "closed";
}

export interface IssueDto {
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly state: "open" | "closed";
  readonly stateReason: string | null;
  readonly author: PrincipalRef | null;
  readonly milestone: IssueMilestoneRef | null;
  readonly labels: readonly LabelDto[];
  readonly assignees: readonly PrincipalRef[];
  readonly isPullRequest: boolean;
  readonly commentCount: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly closedAt: number | null;
}

export interface IssueCommentDto {
  readonly id: string;
  readonly author: PrincipalRef | null;
  readonly body: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

// ============================================================================
// Pull requests / reviews (features/pulls/dto.ts)
// ============================================================================

export interface PrincipalLite {
  readonly id: string;
  readonly subject: string;
  readonly kind: string;
  readonly displayName: string | null;
  readonly email: string | null;
}

export interface PullRequestDto {
  readonly number: number;
  readonly state: "open" | "closed";
  readonly title: string;
  readonly body: string | null;
  readonly draft: boolean;
  readonly merged: boolean;
  readonly mergeable: string;
  readonly author: PrincipalLite | null;
  readonly head: { readonly ref: string; readonly sha: string; readonly repo: string | null };
  readonly base: { readonly ref: string; readonly sha: string };
  readonly mergeBaseSha: string | null;
  readonly mergeCommitSha: string | null;
  readonly mergeMethod: string | null;
  readonly mergedAt: number | null;
  readonly mergedBy: PrincipalLite | null;
  readonly commitsCount: number;
  readonly aheadBy: number;
  readonly behindBy: number;
  readonly commentsCount: number;
  readonly reviewCommentsCount: number;
  readonly reviewsCount: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly closedAt: number | null;
}

export interface ReviewDto {
  readonly id: string;
  readonly state: string;
  readonly body: string | null;
  readonly commitSha: string | null;
  readonly reviewer: PrincipalLite | null;
  readonly submittedAt: number | null;
  readonly createdAt: number;
}

export interface ReviewCommentDto {
  readonly id: string;
  readonly reviewId: string | null;
  readonly inReplyToId: string | null;
  readonly author: PrincipalLite | null;
  readonly path: string;
  readonly side: string;
  readonly line: number | null;
  readonly startLine: number | null;
  readonly commitSha: string;
  readonly diffHunk: string | null;
  readonly body: string;
  readonly outdated: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

// ============================================================================
// Releases / assets / tags (features/releases/dto.ts)
// ============================================================================

export interface ReleaseAssetDto {
  readonly id: string;
  readonly name: string;
  readonly contentType: string | null;
  readonly size: number | null;
  readonly checksumSha256: string | null;
  readonly downloadCount: number;
  readonly state: string;
  readonly createdAt: number;
}

export interface ReleaseDto {
  readonly id: string;
  readonly tag: string;
  readonly name: string | null;
  readonly body: string | null;
  readonly targetSha: string | null;
  readonly isDraft: boolean;
  readonly isPrerelease: boolean;
  readonly author: { readonly id: string; readonly subject: string; readonly displayName: string | null } | null;
  readonly createdAt: number;
  readonly publishedAt: number | null;
  readonly assets: readonly ReleaseAssetDto[];
}

export interface TagDto {
  readonly name: string;
  readonly sha: string;
  readonly commitSha: string | null;
  readonly annotated: boolean;
  readonly tagger: { readonly name: string | null; readonly email: string | null } | null;
  readonly taggedAt: number | null;
  readonly message: string | null;
}

// ============================================================================
// Actions (features/actions/dto.ts)
// ============================================================================

export type RunStatus = "queued" | "in_progress" | "completed";
export type RunConclusion =
  | "success"
  | "failure"
  | "cancelled"
  | "skipped"
  | "timed_out";
export type StepStatus = "pending" | "in_progress" | "completed";

export interface ActorDto {
  readonly id: string;
  readonly subject: string;
  readonly displayName: string | null;
  readonly avatarUrl: string | null;
}

export interface WorkflowDto {
  readonly id: string | null;
  readonly path: string;
  readonly name: string | null;
  readonly triggers: readonly string[];
  readonly state: string;
  readonly parsedAt: number | null;
  readonly updatedAt: number | null;
}

export interface WorkflowRunDto {
  readonly id: string;
  readonly workflowPath: string;
  readonly workflowId: string | null;
  readonly event: string;
  readonly ref: string | null;
  readonly sha: string | null;
  readonly status: RunStatus;
  readonly conclusion: RunConclusion | null;
  readonly runNumber: number;
  readonly runAttempt: number;
  readonly actor: ActorDto | null;
  readonly queuedAt: number | null;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly createdAt: number;
}

export interface WorkflowStepDto {
  readonly number: number;
  readonly name: string;
  readonly status: StepStatus;
  readonly conclusion: RunConclusion | null;
  readonly exitCode: number | null;
  readonly errorMessage: string | null;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
}

export interface WorkflowJobDto {
  readonly id: string;
  readonly jobKey: string | null;
  readonly name: string;
  readonly matrix: Record<string, unknown> | null;
  readonly needs: readonly string[];
  readonly status: RunStatus;
  readonly conclusion: RunConclusion | null;
  readonly runnerName: string | null;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly steps?: readonly WorkflowStepDto[];
}

export interface WorkflowArtifactDto {
  readonly id: string;
  readonly name: string;
  readonly sizeBytes: number | null;
  readonly contentType: string | null;
  readonly expiresAt: number | null;
  readonly createdAt: number;
}

export interface WorkflowSecretDto {
  readonly name: string;
  readonly createdAt: number;
  readonly updatedAt: number | null;
}

// ============================================================================
// Checks + commit statuses (features/checks/dto.ts)
// ============================================================================

export type CheckRunStatus = "queued" | "in_progress" | "completed";
export type CheckRunConclusion =
  | "success"
  | "failure"
  | "neutral"
  | "cancelled"
  | "timed_out"
  | "action_required"
  | "skipped";

export interface CheckRunOutput {
  readonly title: string | null;
  readonly summary: string | null;
  readonly text?: string | null;
}

export interface CheckRunDto {
  readonly id: string;
  readonly repoId: string;
  readonly headSha: string;
  readonly name: string;
  readonly status: CheckRunStatus;
  readonly conclusion: CheckRunConclusion | null;
  readonly detailsUrl: string | null;
  readonly externalId: string | null;
  readonly workflowRunId: string | null;
  readonly output: CheckRunOutput | null;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type CommitStatusState = "pending" | "success" | "failure" | "error";
export type CombinedStatusState = "pending" | "success" | "failure";

export interface CommitStatusDto {
  readonly id: string;
  readonly repoId: string;
  readonly sha: string;
  readonly context: string;
  readonly state: CommitStatusState;
  readonly description: string | null;
  readonly targetUrl: string | null;
  readonly creatorId: string | null;
  readonly createdAt: number;
}

export interface CombinedStatusDto {
  readonly sha: string;
  readonly state: CombinedStatusState;
  readonly statuses: readonly CommitStatusDto[];
  readonly totalCount: number;
}

// ============================================================================
// Collaborators / branch protection / webhooks (net-new features)
// ============================================================================

export interface CollaboratorDto {
  readonly principal: PrincipalRef;
  readonly role: "reader" | "writer" | "maintainer" | "owner";
}

export interface BranchProtectionRuleDto {
  readonly pattern: string;
  readonly requiredReviews: number;
  readonly dismissStaleReviews: boolean;
  readonly requireCodeOwner: boolean;
  readonly requiredStatusChecks: readonly string[];
  readonly strictStatusChecks: boolean;
  readonly enforceAdmins: boolean;
  readonly restrictPush: boolean;
  readonly allowForcePush: boolean;
  readonly allowDeletions: boolean;
}

export interface WebhookDto {
  readonly id: string;
  readonly url: string;
  readonly events: readonly string[];
  readonly active: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface WebhookDeliveryDto {
  readonly id: string;
  readonly event: string;
  readonly statusCode: number | null;
  readonly success: boolean;
  readonly durationMs: number | null;
  readonly createdAt: number;
}

// A repo the current session can browse, used by the home dashboard.
export type { RepositoryDto, Visibility };
