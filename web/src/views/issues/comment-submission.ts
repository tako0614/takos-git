import type { SubmissionContext } from "../../api/issues.ts";
import { createJournaledSubmission } from "../../lib/journaled-submission.ts";
import { SUBMISSION_STORAGE_ERROR } from "../../lib/submission-journal.ts";
import { commentContext, createCommentJournal, matchesCommentContext, type CommentJournalOptions } from "./submission-journal.ts";

export interface CommentSubmission {
  readonly idempotencyKey: string;
  readonly body: string;
  readonly revision: number;
  readonly closeAfter?: "open" | "closed";
  readonly context?: SubmissionContext;
}

/** The composer owns one submitted draft independently of subsequent edits. */
export function createCommentSubmission(options?: CommentJournalOptions) {
  const flow = createJournaledSubmission(options ? createCommentJournal(options) : null, (attempt: CommentSubmission) => ({ body: attempt.body, revision: attempt.revision }));
  const context = options ? Object.freeze(commentContext(options)) : undefined;
  return {
    ...flow, context,
    begin(attempt: CommentSubmission): boolean {
      if (flow.state()) return false;
      if (options && !matchesCommentContext(attempt.context, options)) throw new Error(SUBMISSION_STORAGE_ERROR);
      return flow.begin(attempt);
    },
    saveDraft(body: string, revision: number): void { flow.saveForm({ body, revision }); },
  };
}
