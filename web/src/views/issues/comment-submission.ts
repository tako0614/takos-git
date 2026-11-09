import { createSignal } from "solid-js";
import { ApiError } from "../../api/client.ts";

export interface CommentSubmission {
  readonly idempotencyKey: string;
  readonly body: string;
  readonly revision: number;
  readonly closeAfter?: "open" | "closed";
}

type SubmissionState = { readonly attempt: CommentSubmission; readonly phase: "sending" | "unknown" };

/** The composer owns one submitted draft independently of subsequent edits. */
export function createCommentSubmission() {
  const [state, setState] = createSignal<SubmissionState | null>(null);
  const owns = (attempt: CommentSubmission, phase: SubmissionState["phase"]) =>
    state()?.attempt === attempt && state()?.phase === phase;
  return {
    state,
    unknown: () => state()?.phase === "unknown" ? state()!.attempt : null,
    begin(attempt: CommentSubmission): boolean {
      if (state()) return false;
      setState({ attempt, phase: "sending" });
      return true;
    },
    retry(attempt: CommentSubmission): boolean {
      if (!owns(attempt, "unknown")) return false;
      setState({ attempt, phase: "sending" });
      return true;
    },
    acknowledge(attempt: CommentSubmission): boolean {
      if (!owns(attempt, "sending")) return false;
      setState(null);
      return true;
    },
    fail(attempt: CommentSubmission, error: unknown): void {
      if (!owns(attempt, "sending")) return;
      // A transport/decoding error, timeout or 5xx does not prove rollback.
      const rejected = error instanceof ApiError && error.status >= 400 &&
        error.status < 500 && error.status !== 408;
      setState(rejected ? null : { attempt, phase: "unknown" });
    },
    resolve(attempt: CommentSubmission): boolean {
      if (!owns(attempt, "unknown")) return false;
      setState(null);
      return true;
    },
  };
}
