import type { pullsApi } from "../../api/pulls.ts";
import { createJournaledSubmission } from "../../lib/journaled-submission.ts";
import { createPullJournal, type PullJournalOptions } from "./pull-submission-storage.ts";

export interface PullSubmission {
  readonly idempotencyKey: string;
  readonly revision: number;
  readonly input: Parameters<typeof pullsApi.create>[2];
}
export function createPullSubmission(createKey: () => string = () => crypto.randomUUID(), options?: PullJournalOptions) {
  const flow = createJournaledSubmission(options ? createPullJournal(options) : null, (attempt: PullSubmission) => ({ input: attempt.input, revision: attempt.revision }));
  const bind = (input: PullSubmission["input"]): PullSubmission["input"] => ({ ...input, ...(options ? { repository_id: options.repositoryId, recovery_scope: options.scope } : {}) });
  return {
    ...flow,
    begin(input: PullSubmission["input"], revision: number): PullSubmission | null {
      if (flow.state()) return null;
      const attempt = { idempotencyKey: createKey(), revision, input: bind(input) };
      return flow.begin(attempt) ? attempt : null;
    },
    saveDraft(input: PullSubmission["input"], revision: number): void { flow.saveForm({ input: bind(input), revision }); },
  };
}
