/**
 * D1 service layer for issues, comments, labels, milestones.
 *
 * Pure metadata plane: no git object/ref access lives here (issues carry no SHA).
 * Every function is a thin, explicit-SQL query over {@link DbClient}; handlers
 * own validation + authorization, this module owns persistence + projection.
 *
 * Numbers come from the shared `repo_counters` allocator: issues (and PRs) draw
 * from scope `'issue'`; milestones draw from their own scope `'milestone'`.
 */

import type { DbClient } from "../../db/index.ts";
import {
  toCommentDto,
  toIssueDto,
  toLabelDto,
  toMilestoneDto,
  toPrincipalRef,
  type IssueCommentDto,
  type IssueCommentRow,
  type IssueDetails,
  type IssueDto,
  type IssueRow,
  type LabelDto,
  type LabelRow,
  type MilestoneDto,
  type MilestoneRow,
  type PrincipalRef,
  type PrincipalRow,
} from "./dto.ts";

const ISSUE_COLUMNS =
  "id, repo_id, number, title, body, state, state_reason, author_id, milestone_id, is_pull_request, comment_count, created_at, updated_at, closed_at";
const LABEL_COLUMNS = "id, repo_id, name, color, description, created_at";
const MILESTONE_COLUMNS =
  "id, repo_id, number, title, description, state, due_on, created_at, updated_at, closed_at";
const COMMENT_COLUMNS =
  "id, issue_id, author_id, body, created_at, updated_at";

// ============================================================================
// Number allocation (shared issue+PR counter, and milestone counter)
// ============================================================================

/**
 * Atomically allocate the next per-repo sequence number for `scope`. The
 * `repo_counters.next_value` row holds the next number to hand out; a single
 * upsert both reserves the current value and advances the cursor.
 */
export async function allocateNumber(
  db: DbClient,
  repoId: string,
  scope: string,
): Promise<number> {
  const row = await db.queryOne<{ nv: number }>(
    `INSERT INTO repo_counters (repo_id, scope, next_value) VALUES (?, ?, 2)
     ON CONFLICT(repo_id, scope) DO UPDATE SET next_value = next_value + 1
     RETURNING next_value AS nv`,
    [repoId, scope],
  );
  // First insert → nv=2 → allocated 1; each later conflict → nv-1.
  return (row?.nv ?? 2) - 1;
}

// ============================================================================
// Principal resolution
// ============================================================================

/** Look up an existing principal id by OIDC/Interface subject, or null. */
export async function principalIdBySubject(
  db: DbClient,
  subject: string,
): Promise<string | null> {
  const row = await db.queryOne<{ id: string }>(
    `SELECT id FROM principals WHERE subject = ? LIMIT 1`,
    [subject],
  );
  return row?.id ?? null;
}

async function principalRefsByIds(
  db: DbClient,
  ids: readonly string[],
): Promise<Map<string, PrincipalRef>> {
  const map = new Map<string, PrincipalRef>();
  const unique = [...new Set(ids.filter((id) => id))];
  if (unique.length === 0) return map;
  const placeholders = unique.map(() => "?").join(", ");
  const rows = await db.query<PrincipalRow>(
    `SELECT id, subject, display_name FROM principals WHERE id IN (${placeholders})`,
    unique,
  );
  for (const row of rows) {
    const ref = toPrincipalRef(row);
    if (ref) map.set(row.id, ref);
  }
  return map;
}

// ============================================================================
// Labels
// ============================================================================

export function isValidLabelName(name: string): boolean {
  return name.length >= 1 && name.length <= 128 && !/[\n\r]/u.test(name);
}

export function isValidColor(color: string): boolean {
  return /^[0-9a-fA-F]{6}$/u.test(color);
}

export async function listLabels(
  db: DbClient,
  repoId: string,
): Promise<LabelDto[]> {
  const rows = await db.query<LabelRow>(
    `SELECT ${LABEL_COLUMNS} FROM labels WHERE repo_id = ? ORDER BY name COLLATE NOCASE ASC`,
    [repoId],
  );
  return rows.map(toLabelDto);
}

export async function getLabelRow(
  db: DbClient,
  repoId: string,
  name: string,
): Promise<LabelRow | null> {
  return db.queryOne<LabelRow>(
    `SELECT ${LABEL_COLUMNS} FROM labels WHERE repo_id = ? AND name = ? COLLATE NOCASE LIMIT 1`,
    [repoId, name],
  );
}

export type CreateLabelResult =
  | { readonly ok: true; readonly label: LabelDto }
  | { readonly ok: false; readonly code: "conflict" };

export async function createLabel(
  db: DbClient,
  repoId: string,
  input: { name: string; color: string; description: string | null },
): Promise<CreateLabelResult> {
  const existing = await getLabelRow(db, repoId, input.name);
  if (existing) return { ok: false, code: "conflict" };
  const id = db.id();
  const now = db.now();
  await db.run(
    `INSERT INTO labels (id, repo_id, name, color, description, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, repoId, input.name, input.color, input.description, now],
  );
  const row = await db.queryOne<LabelRow>(
    `SELECT ${LABEL_COLUMNS} FROM labels WHERE id = ?`,
    [id],
  );
  return { ok: true, label: toLabelDto(row as LabelRow) };
}

export async function updateLabel(
  db: DbClient,
  repoId: string,
  name: string,
  input: { name?: string; color?: string; description?: string | null },
): Promise<LabelDto | null> {
  const row = await getLabelRow(db, repoId, name);
  if (!row) return null;
  const nextName = input.name ?? row.name;
  const nextColor = input.color ?? row.color;
  const nextDescription =
    input.description === undefined ? row.description : input.description;
  await db.run(
    `UPDATE labels SET name = ?, color = ?, description = ? WHERE id = ?`,
    [nextName, nextColor, nextDescription, row.id],
  );
  const updated = await db.queryOne<LabelRow>(
    `SELECT ${LABEL_COLUMNS} FROM labels WHERE id = ?`,
    [row.id],
  );
  return updated ? toLabelDto(updated) : null;
}

export async function deleteLabel(
  db: DbClient,
  repoId: string,
  name: string,
): Promise<boolean> {
  const row = await getLabelRow(db, repoId, name);
  if (!row) return false;
  await db.run(`DELETE FROM labels WHERE id = ?`, [row.id]);
  return true;
}

/** Resolve label names to ids within a repo; returns the missing names too. */
async function resolveLabelIds(
  db: DbClient,
  repoId: string,
  names: readonly string[],
): Promise<{ ids: string[]; missing: string[] }> {
  const ids: string[] = [];
  const missing: string[] = [];
  for (const name of names) {
    const row = await getLabelRow(db, repoId, name);
    if (row) ids.push(row.id);
    else missing.push(name);
  }
  return { ids, missing };
}

// ============================================================================
// Milestones
// ============================================================================

export async function getMilestoneRowByNumber(
  db: DbClient,
  repoId: string,
  number: number,
): Promise<MilestoneRow | null> {
  return db.queryOne<MilestoneRow>(
    `SELECT ${MILESTONE_COLUMNS} FROM milestones WHERE repo_id = ? AND number = ? LIMIT 1`,
    [repoId, number],
  );
}

async function milestoneIssueCounts(
  db: DbClient,
  milestoneId: string,
): Promise<{ open: number; closed: number }> {
  const rows = await db.query<{ state: string; n: number }>(
    `SELECT state, COUNT(*) AS n FROM issues WHERE milestone_id = ? GROUP BY state`,
    [milestoneId],
  );
  let open = 0;
  let closed = 0;
  for (const row of rows) {
    if (row.state === "closed") closed = row.n;
    else open = row.n;
  }
  return { open, closed };
}

export async function listMilestones(
  db: DbClient,
  repoId: string,
  state: "open" | "closed" | "all",
): Promise<MilestoneDto[]> {
  const clause = state === "all" ? "" : " AND state = ?";
  const params: unknown[] = [repoId];
  if (state !== "all") params.push(state);
  const rows = await db.query<MilestoneRow>(
    `SELECT ${MILESTONE_COLUMNS} FROM milestones WHERE repo_id = ?${clause} ORDER BY number DESC`,
    params,
  );
  const out: MilestoneDto[] = [];
  for (const row of rows) {
    out.push(toMilestoneDto(row, await milestoneIssueCounts(db, row.id)));
  }
  return out;
}

export async function getMilestone(
  db: DbClient,
  repoId: string,
  number: number,
): Promise<MilestoneDto | null> {
  const row = await getMilestoneRowByNumber(db, repoId, number);
  if (!row) return null;
  return toMilestoneDto(row, await milestoneIssueCounts(db, row.id));
}

export async function createMilestone(
  db: DbClient,
  repoId: string,
  input: { title: string; description: string | null; dueOn: number | null },
): Promise<MilestoneDto> {
  const id = db.id();
  const now = db.now();
  const number = await allocateNumber(db, repoId, "milestone");
  await db.run(
    `INSERT INTO milestones (id, repo_id, number, title, description, state, due_on, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
    [id, repoId, number, input.title, input.description, input.dueOn, now, now],
  );
  const row = await db.queryOne<MilestoneRow>(
    `SELECT ${MILESTONE_COLUMNS} FROM milestones WHERE id = ?`,
    [id],
  );
  return toMilestoneDto(row as MilestoneRow, { open: 0, closed: 0 });
}

export async function updateMilestone(
  db: DbClient,
  repoId: string,
  number: number,
  input: {
    title?: string;
    description?: string | null;
    state?: "open" | "closed";
    dueOn?: number | null;
  },
): Promise<MilestoneDto | null> {
  const row = await getMilestoneRowByNumber(db, repoId, number);
  if (!row) return null;
  const now = db.now();
  const nextTitle = input.title ?? row.title;
  const nextDescription =
    input.description === undefined ? row.description : input.description;
  const nextState = input.state ?? (row.state === "closed" ? "closed" : "open");
  const nextDueOn = input.dueOn === undefined ? row.due_on : input.dueOn;
  const closedAt =
    nextState === "closed" ? (row.closed_at ?? now) : null;
  await db.run(
    `UPDATE milestones SET title = ?, description = ?, state = ?, due_on = ?, updated_at = ?, closed_at = ? WHERE id = ?`,
    [nextTitle, nextDescription, nextState, nextDueOn, now, closedAt, row.id],
  );
  return getMilestone(db, repoId, number);
}

export async function deleteMilestone(
  db: DbClient,
  repoId: string,
  number: number,
): Promise<boolean> {
  const row = await getMilestoneRowByNumber(db, repoId, number);
  if (!row) return false;
  // issues.milestone_id is ON DELETE SET NULL, so open issues simply detach.
  await db.run(`DELETE FROM milestones WHERE id = ?`, [row.id]);
  return true;
}

// ============================================================================
// Issues — detail attachment
// ============================================================================

async function labelsForIssues(
  db: DbClient,
  issueIds: readonly string[],
): Promise<Map<string, LabelDto[]>> {
  const map = new Map<string, LabelDto[]>();
  if (issueIds.length === 0) return map;
  const placeholders = issueIds.map(() => "?").join(", ");
  const rows = await db.query<LabelRow & { issue_id: string }>(
    `SELECT il.issue_id AS issue_id, ${LABEL_COLUMNS.split(", ")
      .map((column) => `l.${column}`)
      .join(", ")}
       FROM issue_labels il
       JOIN labels l ON l.id = il.label_id
      WHERE il.issue_id IN (${placeholders})
      ORDER BY l.name COLLATE NOCASE ASC`,
    issueIds,
  );
  for (const row of rows) {
    const list = map.get(row.issue_id) ?? [];
    list.push(toLabelDto(row));
    map.set(row.issue_id, list);
  }
  return map;
}

async function assigneesForIssues(
  db: DbClient,
  issueIds: readonly string[],
): Promise<Map<string, PrincipalRef[]>> {
  const map = new Map<string, PrincipalRef[]>();
  if (issueIds.length === 0) return map;
  const placeholders = issueIds.map(() => "?").join(", ");
  const rows = await db.query<{
    issue_id: string;
    id: string;
    subject: string;
    display_name: string | null;
  }>(
    `SELECT ia.issue_id AS issue_id, p.id AS id, p.subject AS subject, p.display_name AS display_name
       FROM issue_assignees ia
       JOIN principals p ON p.id = ia.principal_id
      WHERE ia.issue_id IN (${placeholders})
      ORDER BY p.subject ASC`,
    issueIds,
  );
  for (const row of rows) {
    const list = map.get(row.issue_id) ?? [];
    list.push({ id: row.id, subject: row.subject, displayName: row.display_name });
    map.set(row.issue_id, list);
  }
  return map;
}

async function milestoneRefs(
  db: DbClient,
  milestoneIds: readonly (string | null)[],
): Promise<Map<string, { number: number; title: string; state: "open" | "closed" }>> {
  const map = new Map<string, { number: number; title: string; state: "open" | "closed" }>();
  const unique = [...new Set(milestoneIds.filter((id): id is string => !!id))];
  if (unique.length === 0) return map;
  const placeholders = unique.map(() => "?").join(", ");
  const rows = await db.query<{ id: string; number: number; title: string; state: string }>(
    `SELECT id, number, title, state FROM milestones WHERE id IN (${placeholders})`,
    unique,
  );
  for (const row of rows) {
    map.set(row.id, {
      number: row.number,
      title: row.title,
      state: row.state === "closed" ? "closed" : "open",
    });
  }
  return map;
}

/** Hydrate a set of issue rows into DTOs with author/labels/assignees/milestone. */
async function hydrateIssues(
  db: DbClient,
  rows: readonly IssueRow[],
): Promise<IssueDto[]> {
  const issueIds = rows.map((row) => row.id);
  const [labels, assignees, milestones, authors] = await Promise.all([
    labelsForIssues(db, issueIds),
    assigneesForIssues(db, issueIds),
    milestoneRefs(db, rows.map((row) => row.milestone_id)),
    principalRefsByIds(
      db,
      rows.map((row) => row.author_id).filter((id): id is string => !!id),
    ),
  ]);
  return rows.map((row) => {
    const details: IssueDetails = {
      author: row.author_id ? authors.get(row.author_id) ?? null : null,
      milestone: row.milestone_id ? milestones.get(row.milestone_id) ?? null : null,
      labels: labels.get(row.id) ?? [],
      assignees: assignees.get(row.id) ?? [],
    };
    return toIssueDto(row, details);
  });
}

// ============================================================================
// Issues — read
// ============================================================================

export async function getIssueRowByNumber(
  db: DbClient,
  repoId: string,
  number: number,
): Promise<IssueRow | null> {
  return db.queryOne<IssueRow>(
    `SELECT ${ISSUE_COLUMNS} FROM issues WHERE repo_id = ? AND number = ? LIMIT 1`,
    [repoId, number],
  );
}

export async function getIssueDto(
  db: DbClient,
  repoId: string,
  number: number,
): Promise<IssueDto | null> {
  const row = await getIssueRowByNumber(db, repoId, number);
  if (!row) return null;
  const [dto] = await hydrateIssues(db, [row]);
  return dto ?? null;
}

export interface ListIssuesFilter {
  readonly state: "open" | "closed" | "all";
  readonly labelName?: string | null;
  readonly milestoneNumber?: number | null;
  readonly assigneeSubject?: string | null;
  readonly limit: number;
  readonly offset: number;
}

export interface ListIssuesResult {
  readonly issues: IssueDto[];
  readonly hasMore: boolean;
}

export async function listIssues(
  db: DbClient,
  repoId: string,
  filter: ListIssuesFilter,
): Promise<ListIssuesResult> {
  const where: string[] = ["i.repo_id = ?", "i.is_pull_request = 0"];
  const params: unknown[] = [repoId];
  if (filter.state !== "all") {
    where.push("i.state = ?");
    params.push(filter.state);
  }
  if (filter.labelName) {
    where.push(
      `EXISTS (SELECT 1 FROM issue_labels il JOIN labels l ON l.id = il.label_id
                WHERE il.issue_id = i.id AND l.name = ? COLLATE NOCASE)`,
    );
    params.push(filter.labelName);
  }
  if (filter.milestoneNumber != null) {
    where.push(
      `i.milestone_id = (SELECT id FROM milestones WHERE repo_id = ? AND number = ?)`,
    );
    params.push(repoId, filter.milestoneNumber);
  }
  if (filter.assigneeSubject) {
    where.push(
      `EXISTS (SELECT 1 FROM issue_assignees ia JOIN principals p ON p.id = ia.principal_id
                WHERE ia.issue_id = i.id AND p.subject = ?)`,
    );
    params.push(filter.assigneeSubject);
  }
  const rows = await db.query<IssueRow>(
    `SELECT ${ISSUE_COLUMNS.split(", ")
      .map((column) => `i.${column}`)
      .join(", ")}
       FROM issues i
      WHERE ${where.join(" AND ")}
      ORDER BY i.number DESC
      LIMIT ? OFFSET ?`,
    [...params, filter.limit + 1, filter.offset],
  );
  const hasMore = rows.length > filter.limit;
  const page = hasMore ? rows.slice(0, filter.limit) : rows;
  return { issues: await hydrateIssues(db, page), hasMore };
}

// ============================================================================
// Issues — write
// ============================================================================

export async function createIssue(
  db: DbClient,
  repoId: string,
  input: {
    title: string;
    body: string | null;
    authorId: string;
    milestoneId: string | null;
    labelIds: readonly string[];
    assigneeIds: readonly string[];
  },
): Promise<IssueDto> {
  const id = db.id();
  const now = db.now();
  const number = await allocateNumber(db, repoId, "issue");
  await db.run(
    `INSERT INTO issues (id, repo_id, number, title, body, state, author_id, milestone_id, is_pull_request, comment_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'open', ?, ?, 0, 0, ?, ?)`,
    [id, repoId, number, input.title, input.body, input.authorId, input.milestoneId, now, now],
  );
  for (const labelId of new Set(input.labelIds)) {
    await db.run(
      `INSERT OR IGNORE INTO issue_labels (issue_id, label_id) VALUES (?, ?)`,
      [id, labelId],
    );
  }
  for (const assigneeId of new Set(input.assigneeIds)) {
    await db.run(
      `INSERT OR IGNORE INTO issue_assignees (issue_id, principal_id) VALUES (?, ?)`,
      [id, assigneeId],
    );
  }
  const dto = await getIssueDto(db, repoId, number);
  return dto as IssueDto;
}

async function touchIssue(db: DbClient, issueId: string, at: number): Promise<void> {
  await db.run(`UPDATE issues SET updated_at = ? WHERE id = ?`, [at, issueId]);
}

export async function updateIssueFields(
  db: DbClient,
  issueId: string,
  input: {
    title?: string;
    body?: string | null;
    milestoneId?: string | null;
    stateReason?: string | null;
  },
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (input.title !== undefined) {
    sets.push("title = ?");
    params.push(input.title);
  }
  if (input.body !== undefined) {
    sets.push("body = ?");
    params.push(input.body);
  }
  if (input.milestoneId !== undefined) {
    sets.push("milestone_id = ?");
    params.push(input.milestoneId);
  }
  if (input.stateReason !== undefined) {
    sets.push("state_reason = ?");
    params.push(input.stateReason);
  }
  const now = db.now();
  sets.push("updated_at = ?");
  params.push(now);
  params.push(issueId);
  await db.run(`UPDATE issues SET ${sets.join(", ")} WHERE id = ?`, params);
}

export async function setIssueState(
  db: DbClient,
  issueId: string,
  state: "open" | "closed",
  stateReason: string | null,
): Promise<void> {
  const now = db.now();
  const closedAt = state === "closed" ? now : null;
  await db.run(
    `UPDATE issues SET state = ?, state_reason = ?, closed_at = ?, updated_at = ? WHERE id = ?`,
    [state, stateReason, closedAt, now, issueId],
  );
}

/** Replace the full assignee set with the given principal ids. */
export async function setAssignees(
  db: DbClient,
  issueId: string,
  principalIds: readonly string[],
): Promise<void> {
  await db.run(`DELETE FROM issue_assignees WHERE issue_id = ?`, [issueId]);
  for (const id of new Set(principalIds)) {
    await db.run(
      `INSERT OR IGNORE INTO issue_assignees (issue_id, principal_id) VALUES (?, ?)`,
      [issueId, id],
    );
  }
  await touchIssue(db, issueId, db.now());
}

/** Replace the full label set with the given label ids. */
export async function setIssueLabels(
  db: DbClient,
  issueId: string,
  labelIds: readonly string[],
): Promise<void> {
  await db.run(`DELETE FROM issue_labels WHERE issue_id = ?`, [issueId]);
  for (const id of new Set(labelIds)) {
    await db.run(
      `INSERT OR IGNORE INTO issue_labels (issue_id, label_id) VALUES (?, ?)`,
      [issueId, id],
    );
  }
  await touchIssue(db, issueId, db.now());
}

export async function addIssueLabels(
  db: DbClient,
  issueId: string,
  labelIds: readonly string[],
): Promise<void> {
  for (const id of new Set(labelIds)) {
    await db.run(
      `INSERT OR IGNORE INTO issue_labels (issue_id, label_id) VALUES (?, ?)`,
      [issueId, id],
    );
  }
  await touchIssue(db, issueId, db.now());
}

export async function removeIssueLabelByName(
  db: DbClient,
  repoId: string,
  issueId: string,
  name: string,
): Promise<boolean> {
  const label = await getLabelRow(db, repoId, name);
  if (!label) return false;
  const result = await db.run(
    `DELETE FROM issue_labels WHERE issue_id = ? AND label_id = ?`,
    [issueId, label.id],
  );
  await touchIssue(db, issueId, db.now());
  return (result.meta.changes ?? 0) > 0;
}

// ============================================================================
// Comments
// ============================================================================

export function isValidCommentBody(body: string): boolean {
  return body.trim().length >= 1 && body.length <= 262_144;
}

export async function createComment(
  db: DbClient,
  issueId: string,
  authorId: string,
  body: string,
): Promise<IssueCommentDto> {
  const id = db.id();
  const now = db.now();
  await db.run(
    `INSERT INTO issue_comments (id, issue_id, author_id, body, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, issueId, authorId, body, now, now],
  );
  await db.run(
    `UPDATE issues SET comment_count = comment_count + 1, updated_at = ? WHERE id = ?`,
    [now, issueId],
  );
  const author = await principalRefsByIds(db, [authorId]);
  const row = await db.queryOne<IssueCommentRow>(
    `SELECT ${COMMENT_COLUMNS} FROM issue_comments WHERE id = ?`,
    [id],
  );
  return toCommentDto(row as IssueCommentRow, author.get(authorId) ?? null);
}

export async function listComments(
  db: DbClient,
  issueId: string,
  limit: number,
  offset: number,
): Promise<{ comments: IssueCommentDto[]; hasMore: boolean }> {
  const rows = await db.query<IssueCommentRow>(
    `SELECT ${COMMENT_COLUMNS} FROM issue_comments WHERE issue_id = ?
      ORDER BY created_at ASC, id ASC LIMIT ? OFFSET ?`,
    [issueId, limit + 1, offset],
  );
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const authors = await principalRefsByIds(
    db,
    page.map((row) => row.author_id).filter((id): id is string => !!id),
  );
  return {
    comments: page.map((row) =>
      toCommentDto(row, row.author_id ? authors.get(row.author_id) ?? null : null),
    ),
    hasMore,
  };
}

export interface CommentContext {
  readonly comment: IssueCommentRow;
  readonly issue: IssueRow;
}

/** Load a comment plus its issue, scoped to `repoId` (else null → 404). */
export async function getCommentInRepo(
  db: DbClient,
  repoId: string,
  commentId: string,
): Promise<CommentContext | null> {
  const comment = await db.queryOne<IssueCommentRow>(
    `SELECT ${COMMENT_COLUMNS} FROM issue_comments WHERE id = ? LIMIT 1`,
    [commentId],
  );
  if (!comment) return null;
  const issue = await db.queryOne<IssueRow>(
    `SELECT ${ISSUE_COLUMNS} FROM issues WHERE id = ? AND repo_id = ? LIMIT 1`,
    [comment.issue_id, repoId],
  );
  if (!issue) return null;
  return { comment, issue };
}

export async function updateComment(
  db: DbClient,
  commentId: string,
  body: string,
): Promise<IssueCommentDto | null> {
  const now = db.now();
  await db.run(
    `UPDATE issue_comments SET body = ?, updated_at = ? WHERE id = ?`,
    [body, now, commentId],
  );
  const row = await db.queryOne<IssueCommentRow>(
    `SELECT ${COMMENT_COLUMNS} FROM issue_comments WHERE id = ?`,
    [commentId],
  );
  if (!row) return null;
  const author = row.author_id
    ? (await principalRefsByIds(db, [row.author_id])).get(row.author_id) ?? null
    : null;
  return toCommentDto(row, author);
}

export async function deleteComment(
  db: DbClient,
  commentId: string,
  issueId: string,
): Promise<void> {
  await db.run(`DELETE FROM issue_comments WHERE id = ?`, [commentId]);
  await db.run(
    `UPDATE issues SET comment_count = CASE WHEN comment_count > 0 THEN comment_count - 1 ELSE 0 END, updated_at = ? WHERE id = ?`,
    [db.now(), issueId],
  );
}

// ============================================================================
// Shared helpers exported for handlers
// ============================================================================

export { resolveLabelIds };
