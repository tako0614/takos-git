import type { IssueCreateInput } from "../../api/issues.ts";
import { createJournaledSubmission } from "../../lib/journaled-submission.ts";
import { createIssueJournal, type IssueJournalOptions } from "./submission-journal.ts";

export interface IssueSubmission {
  readonly idempotencyKey: string;
  readonly revision: number;
  readonly input: IssueCreateInput;
}

export function createIssueSubmission(createKey: () => string = () => crypto.randomUUID(), options?: IssueJournalOptions) {
  const recovery = createJournaledSubmission(options ? createIssueJournal(options) : null, (attempt: IssueSubmission) => ({ input: attempt.input, revision: attempt.revision }));
  const bind = (input: IssueCreateInput): IssueCreateInput => ({
    ...input, labels: input.labels ? [...input.labels] : undefined, assignees: input.assignees ? [...input.assignees] : undefined,
    ...(options ? { repository_id: options.repositoryId, recovery_scope: options.scope } : {}),
  });
  return {
    ...recovery,
    begin(input: IssueCreateInput, revision: number): IssueSubmission | null {
      if (recovery.state()) return null;
      const attempt = { idempotencyKey: createKey(), revision, input: bind(input) };
      return recovery.begin(attempt) ? attempt : null;
    },
    saveDraft(input: IssueCreateInput, revision: number): void { recovery.saveForm({ input: bind(input), revision }); },
  };
}
