import type { RepositoryCreateInput } from "../../api/repos.ts";
import { createSubmissionRecovery } from "../../lib/submission-recovery.ts";

export interface RepositoryCreation {
  readonly input: RepositoryCreateInput;
  readonly revision: number;
}

/** An uncertain create stays bound to the originally requested namespace/name. */
export function createRepositoryCreation() {
  const recovery = createSubmissionRecovery<RepositoryCreation>();
  return {
    ...recovery,
    prepare(input: RepositoryCreateInput, revision: number): RepositoryCreation | null {
      const attempt = { input: { ...input }, revision };
      return recovery.begin(attempt) ? attempt : null;
    },
  };
}
