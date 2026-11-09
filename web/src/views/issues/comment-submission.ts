import { createSubmissionRecovery } from "../../lib/submission-recovery.ts";

export interface CommentSubmission {
  readonly idempotencyKey: string;
  readonly body: string;
  readonly revision: number;
  readonly closeAfter?: "open" | "closed";
}

/** The composer owns one submitted draft independently of subsequent edits. */
export function createCommentSubmission() {
  return createSubmissionRecovery<CommentSubmission>();
}
