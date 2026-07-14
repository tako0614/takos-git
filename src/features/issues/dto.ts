/**
 * DTOs and raw-row shapes for the issues feature.
 *
 * The DTOs are the versioned `/api/v1` wire shape (NOT GitHub wire-compat). Raw
 * `*Row` interfaces mirror the D1 columns exactly (`migrations/0001_init.sql`
 * §5). Mapping lives here so the store and handlers share one projection.
 */

// --- principal reference (author / assignee) -------------------------------

export interface PrincipalRef {
  readonly id: string;
  readonly subject: string;
  readonly displayName: string | null;
}

export interface PrincipalRow {
  id: string;
  subject: string;
  display_name: string | null;
}

export function toPrincipalRef(row: PrincipalRow | null): PrincipalRef | null {
  if (!row) return null;
  return { id: row.id, subject: row.subject, displayName: row.display_name };
}

// --- labels -----------------------------------------------------------------

export interface LabelRow {
  id: string;
  repo_id: string;
  name: string;
  color: string;
  description: string | null;
  created_at: number;
}

export interface LabelDto {
  readonly name: string;
  readonly color: string;
  readonly description: string | null;
  readonly createdAt: number;
}

export function toLabelDto(row: LabelRow): LabelDto {
  return {
    name: row.name,
    color: row.color,
    description: row.description,
    createdAt: row.created_at,
  };
}

// --- milestones -------------------------------------------------------------

export interface MilestoneRow {
  id: string;
  repo_id: string;
  number: number;
  title: string;
  description: string | null;
  state: string;
  due_on: number | null;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
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

export function toMilestoneDto(
  row: MilestoneRow,
  counts: { open: number; closed: number } = { open: 0, closed: 0 },
): MilestoneDto {
  return {
    number: row.number,
    title: row.title,
    description: row.description,
    state: row.state === "closed" ? "closed" : "open",
    dueOn: row.due_on,
    openIssues: counts.open,
    closedIssues: counts.closed,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  };
}

// --- issues -----------------------------------------------------------------

export interface IssueRow {
  id: string;
  repo_id: string;
  number: number;
  title: string;
  body: string | null;
  state: string;
  state_reason: string | null;
  author_id: string | null;
  milestone_id: string | null;
  is_pull_request: number;
  comment_count: number;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
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

export interface IssueDetails {
  readonly author: PrincipalRef | null;
  readonly milestone: IssueMilestoneRef | null;
  readonly labels: readonly LabelDto[];
  readonly assignees: readonly PrincipalRef[];
}

export function toIssueDto(row: IssueRow, details: IssueDetails): IssueDto {
  return {
    number: row.number,
    title: row.title,
    body: row.body,
    state: row.state === "closed" ? "closed" : "open",
    stateReason: row.state_reason,
    author: details.author,
    milestone: details.milestone,
    labels: details.labels,
    assignees: details.assignees,
    isPullRequest: row.is_pull_request === 1,
    commentCount: row.comment_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  };
}

// --- comments ---------------------------------------------------------------

export interface IssueCommentRow {
  id: string;
  issue_id: string;
  author_id: string | null;
  body: string;
  created_at: number;
  updated_at: number;
}

export interface IssueCommentDto {
  readonly id: string;
  readonly author: PrincipalRef | null;
  readonly body: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export function toCommentDto(
  row: IssueCommentRow,
  author: PrincipalRef | null,
): IssueCommentDto {
  return {
    id: row.id,
    author,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
