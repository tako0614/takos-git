import type { IssueCreateInput } from "../../api/issues.ts";
import { createSubmissionRecovery } from "../../lib/submission-recovery.ts";

export interface IssueSubmission {
  readonly idempotencyKey: string;
  readonly revision: number;
  readonly input: IssueCreateInput;
}

export function createIssueSubmission(createKey: () => string = () => crypto.randomUUID()) {
  const recovery = createSubmissionRecovery<IssueSubmission>();
  return {
    ...recovery,
    begin(input: IssueCreateInput, revision: number): IssueSubmission | null {
      if (recovery.state()) return null;
      const attempt = { idempotencyKey: createKey(), revision, input: {
        ...input, labels: input.labels ? [...input.labels] : undefined,
        assignees: input.assignees ? [...input.assignees] : undefined,
      } };
      return recovery.begin(attempt) ? attempt : null;
    },
  };
}
