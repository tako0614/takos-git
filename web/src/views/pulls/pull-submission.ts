import type { pullsApi } from "../../api/pulls.ts";
import { ApiError } from "../../api/client.ts";
import { createSubmissionRecovery } from "../../lib/submission-recovery.ts";

export interface PullSubmission {
  readonly idempotencyKey: string;
  readonly revision: number;
  readonly input: Parameters<typeof pullsApi.create>[2];
}
export function createPullSubmission(createKey: () => string = () => crypto.randomUUID()) {
  const recovery = createSubmissionRecovery<PullSubmission>();
  return {
    ...recovery,
    begin(input: PullSubmission["input"], revision: number): PullSubmission | null {
      if (recovery.state()) return null;
      const attempt = { idempotencyKey: createKey(), revision, input: { ...input } };
      return recovery.begin(attempt) ? attempt : null;
    },
    fail(attempt: PullSubmission, error: unknown): void {
      recovery.fail(attempt, error);
      // Only the authorized receipt handler's explicit tombstone proves that
      // retrying the old intent cannot recover a live PR. Other denials do not.
      if (error instanceof ApiError && error.status === 410 && error.code === "submission_deleted") recovery.resolve(attempt);
    },
  };
}
