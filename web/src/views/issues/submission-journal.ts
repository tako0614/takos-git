import type { IssueCreateInput, SubmissionContext } from "../../api/issues.ts";
import { createSubmissionJournal, isRecord, isRevision, isSubmissionKey, type SubmissionStorage } from "../../lib/submission-journal.ts";
import type { IssueSubmission } from "./issue-submission.ts";
import type { CommentSubmission } from "./comment-submission.ts";

export interface IssueJournalOptions { readonly storage: () => SubmissionStorage; readonly scope: string; readonly repositoryId: string }
export interface CommentJournalOptions extends IssueJournalOptions { readonly issueId: string }
export interface IssueFormSnapshot { readonly input: IssueCreateInput; readonly revision: number }
export interface CommentFormSnapshot { readonly body: string; readonly revision: number }
export function commentContext(options: CommentJournalOptions): SubmissionContext {
  return { repository_id: options.repositoryId, recovery_scope: options.scope, issue_id: options.issueId };
}
export function matchesContext(value: unknown, options: IssueJournalOptions & { issueId?: string }): boolean {
  return isRecord(value) && value.repository_id === options.repositoryId && value.recovery_scope === options.scope && value.issue_id === options.issueId;
}
export function matchesCommentContext(value: unknown, options: CommentJournalOptions): boolean {
  return matchesContext(value, options) && isRecord(value)
    && Object.keys(value).every(key => ["repository_id", "recovery_scope", "issue_id"].includes(key));
}
const strings = (value: unknown) => value === undefined || (Array.isArray(value) && value.every(item => typeof item === "string"));
function issueInput(value: unknown, options: IssueJournalOptions): value is IssueCreateInput {
  return matchesContext(value, options) && isRecord(value) && typeof value.title === "string"
    && (value.body === undefined || typeof value.body === "string") && strings(value.labels) && strings(value.assignees)
    && (value.milestone === undefined || (typeof value.milestone === "number" && Number.isFinite(value.milestone)))
    && Object.keys(value).every(key => ["title", "body", "labels", "assignees", "milestone", "repository_id", "recovery_scope"].includes(key));
}
const attempt = (value: unknown): value is Record<string, unknown> => isRecord(value) && isSubmissionKey(value.idempotencyKey) && isRevision(value.revision, -1);
function envelope(value: unknown, options: IssueJournalOptions & { issueId?: string }): value is Record<string, unknown> {
  return isRecord(value) && value.version === 1 && value.scope === options.scope && value.repositoryId === options.repositoryId && value.issueId === options.issueId;
}
export function createIssueJournal(options: IssueJournalOptions) {
  return createSubmissionJournal<IssueSubmission, IssueFormSnapshot>({
    storage: options.storage, key: `takos-git:pending-issue:v1:${JSON.stringify([options.scope, options.repositoryId])}`,
    encode: saved => ({ version: 1, scope: options.scope, repositoryId: options.repositoryId, ...saved }),
    decode(value) {
      if (!envelope(value, options) || !attempt(value.attempt) || !issueInput(value.attempt.input, options)
        || !isRecord(value.form) || !isRevision(value.form.revision) || !issueInput(value.form.input, options)) return null;
      return { attempt: value.attempt as unknown as IssueSubmission, form: value.form as unknown as IssueFormSnapshot };
    },
  });
}
export function createCommentJournal(options: CommentJournalOptions) {
  return createSubmissionJournal<CommentSubmission, CommentFormSnapshot>({
    storage: options.storage, key: `takos-git:pending-comment:v1:${JSON.stringify([options.scope, options.repositoryId, options.issueId])}`,
    encode: saved => ({ version: 1, scope: options.scope, repositoryId: options.repositoryId, issueId: options.issueId, ...saved }),
    decode(value) {
      if (!envelope(value, options) || !attempt(value.attempt) || typeof value.attempt.body !== "string" || !matchesCommentContext(value.attempt.context, options)
        || (value.attempt.closeAfter !== undefined && value.attempt.closeAfter !== "open" && value.attempt.closeAfter !== "closed")
        || !isRecord(value.form) || !isRevision(value.form.revision) || typeof value.form.body !== "string") return null;
      return { attempt: value.attempt as unknown as CommentSubmission, form: value.form as unknown as CommentFormSnapshot };
    },
  });
}
