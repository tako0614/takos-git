import type { SubmissionContext } from "../../api/issues.ts";
import { createSubmissionJournal, isRecord, isRevision, isSubmissionKey, type SubmissionAttempt } from "../../lib/submission-journal.ts";
import { commentContext, matchesCommentContext, type CommentJournalOptions } from "../issues/submission-journal.ts";

export type ReviewVerdict = "approved" | "changes_requested" | "commented";
export interface ReviewAttempt extends SubmissionAttempt {
  readonly submittedRevision: number;
  readonly state: ReviewVerdict;
  readonly body: string | null;
  readonly context: SubmissionContext;
}
export interface ReviewFormSnapshot { readonly body: string; readonly revision: number }
export type ReviewJournalOptions = CommentJournalOptions;
export { commentContext as reviewContext };
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(k => allowed.includes(k));
export function createReviewJournal(options: ReviewJournalOptions) {
  return createSubmissionJournal<ReviewAttempt, ReviewFormSnapshot>({
    storage: options.storage,
    key: `takos-git:pending-review:v1:${JSON.stringify([options.scope, options.repositoryId, options.issueId])}`,
    encode: saved => ({ version: 1, scope: options.scope, repositoryId: options.repositoryId, issueId: options.issueId, ...saved }),
    decode(value) {
      if (!isRecord(value) || value.version !== 1 || value.scope !== options.scope
        || value.repositoryId !== options.repositoryId || value.issueId !== options.issueId
        || !keys(value, ["version", "scope", "repositoryId", "issueId", "attempt", "form"])) return null;
      const a = value.attempt, form = value.form;
      if (!isRecord(a) || !isSubmissionKey(a.idempotencyKey) || !isRevision(a.revision, -1) || !isRevision(a.submittedRevision)
        || !["approved", "changes_requested", "commented"].includes(String(a.state))
        || !(a.body === null || typeof a.body === "string") || (a.state === "commented" && !a.body?.trim())
        || !matchesCommentContext(a.context, options)
        || !keys(a, ["idempotencyKey", "revision", "submittedRevision", "state", "body", "context"])
        || !isRecord(form) || typeof form.body !== "string" || !isRevision(form.revision) || form.revision < a.submittedRevision
        || !keys(form, ["body", "revision"])) return null;
      return { attempt: a as unknown as ReviewAttempt, form: form as unknown as ReviewFormSnapshot };
    },
  });
}
