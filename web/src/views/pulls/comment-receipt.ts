import type { IssueCommentDto } from "../../api/types.ts";
import { isRecord } from "../../lib/submission-journal.ts";
import type { createCommentSubmission, CommentSubmission } from "../issues/comment-submission.ts";

/** An empty/partial success response cannot retire the retained original intent. */
export function acknowledgeCommentReceipt(
  flow: ReturnType<typeof createCommentSubmission>,
  attempt: CommentSubmission,
  response: unknown,
): IssueCommentDto | null {
  const comment = isRecord(response) ? response.comment : null;
  if (!isRecord(comment) || typeof comment.id !== "string" || !comment.id.trim()
    || comment.body !== attempt.body || typeof comment.createdAt !== "number" || !Number.isFinite(comment.createdAt)
    || typeof comment.updatedAt !== "number" || !Number.isFinite(comment.updatedAt)) {
    throw new TypeError("The original comment was not confirmed. Retry the retained submission after checking the conversation.");
  }
  return flow.acknowledge(attempt) ? comment as unknown as IssueCommentDto : null;
}
