import type { PullSubmission } from "./pull-submission.ts";

import { createSubmissionJournal, type SubmissionStorage } from "../../lib/submission-journal.ts";
type TabStorage = SubmissionStorage;
export interface PullJournalOptions {
  readonly storage: () => TabStorage;
  readonly scope: string;
  readonly repositoryId: string;
}
export interface PullFormSnapshot {
  readonly input: PullSubmission["input"];
  readonly revision: number;
}
export interface SavedPullSubmission {
  readonly attempt: PullSubmission;
  readonly form: PullFormSnapshot;
}
export const PULL_STORAGE_ERROR = "Saved PR recovery is unavailable. Restore this tab's browser storage and try again; no new submission will be sent.";

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function input(value: unknown, options: PullJournalOptions): value is PullSubmission["input"] {
  return object(value) && typeof value.title === "string" && typeof value.base === "string" && typeof value.head === "string"
    && (value.body === undefined || typeof value.body === "string") && (value.draft === undefined || typeof value.draft === "boolean")
    && value.repository_id === options.repositoryId && value.recovery_scope === options.scope
    && Object.keys(value).every(key => ["title", "base", "head", "body", "draft", "repository_id", "recovery_scope"].includes(key));
}
function revision(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

/** One pending intent per caller/repository in this tab, never auth material. */
export function createPullJournal(options: PullJournalOptions) {
  return createSubmissionJournal<PullSubmission, PullFormSnapshot>({
    storage: options.storage,
    key: `takos-git:pending-pr:v1:${JSON.stringify([options.scope, options.repositoryId])}`,
    errorMessage: PULL_STORAGE_ERROR,
    encode: saved => ({ version: 1, scope: options.scope, repositoryId: options.repositoryId, ...saved }),
    decode(value): SavedPullSubmission | null {
      if (!object(value) || value.version !== 1 || value.scope !== options.scope || value.repositoryId !== options.repositoryId
        || !object(value.attempt) || !object(value.form)
        || typeof value.attempt.idempotencyKey !== "string" || !/^[\x21-\x7e]{1,255}$/u.test(value.attempt.idempotencyKey)
        || !revision(value.attempt.revision, -1) || !revision(value.form.revision, 0)
        || !input(value.attempt.input, options) || !input(value.form.input, options)) return null;
      return { attempt: value.attempt as unknown as PullSubmission, form: value.form as unknown as PullFormSnapshot };
    },
  });
}
