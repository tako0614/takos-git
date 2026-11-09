import { browserRecoveryScope } from "../browser-auth.ts";
import type { AuthContext } from "../contract/v1.ts";
import type { RouteContext } from "../router.ts";
import { errorResponse } from "./repos/http.ts";

export interface SubmissionContextInput { repository_id?: unknown; recovery_scope?: unknown; issue_id?: unknown }
/** Optional custody preconditions after authorization; never an access grant. */
export async function submissionContextError(ctx: RouteContext, auth: AuthContext, repositoryId: string, body: SubmissionContextInput, issueId?: string): Promise<Response | null> {
  if ((body.repository_id !== undefined && body.repository_id !== repositoryId)
    || (body.recovery_scope !== undefined && (auth.channel !== "browser"
      || body.recovery_scope !== await browserRecoveryScope(ctx.env, auth.principal.subject)))) {
    return errorResponse(409, "submission_context_changed", "The original repository or sign-in context changed. Return to its original context before recovering this submission.");
  }
  if (issueId !== undefined && body.issue_id !== undefined && body.issue_id !== issueId) {
    return errorResponse(409, "submission_context_changed", "The original issue context changed. Return to its original issue before recovering this submission.");
  }
  return null;
}
