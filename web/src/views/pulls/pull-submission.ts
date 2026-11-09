import type { pullsApi } from "../../api/pulls.ts";
import { ApiError } from "../../api/client.ts";
import { createSubmissionRecovery } from "../../lib/submission-recovery.ts";
import { createSignal } from "solid-js";
import { createPullJournal, PULL_STORAGE_ERROR, type PullFormSnapshot, type PullJournalOptions } from "./pull-submission-storage.ts";

export interface PullSubmission {
  readonly idempotencyKey: string;
  readonly revision: number;
  readonly input: Parameters<typeof pullsApi.create>[2];
}
export function createPullSubmission(createKey: () => string = () => crypto.randomUUID(), options?: PullJournalOptions) {
  const recovery = createSubmissionRecovery<PullSubmission>();
  const journal = options ? createPullJournal(options) : null;
  const [storageError, setStorageError] = createSignal<string | null>(null);
  let restoredForm: PullFormSnapshot | null = null;
  const bind = (input: PullSubmission["input"]): PullSubmission["input"] => ({ ...input, ...(options ? { repository_id: options.repositoryId, recovery_scope: options.scope } : {}) });
  function restore(): boolean {
    const saved = journal?.read();
    if (!saved) return false;
    // A restored ACK must never consume this document's form generation.
    const attempt = { ...saved.attempt, revision: -1 };
    recovery.begin(attempt); recovery.fail(attempt, new TypeError("Previous document did not confirm creation"));
    restoredForm = saved.form; return true;
  }
  try { restore(); } catch { setStorageError(PULL_STORAGE_ERROR); }
  function clear(attempt: PullSubmission): boolean {
    try { journal?.remove(attempt.idempotencyKey); setStorageError(null); return true; }
    catch { setStorageError(PULL_STORAGE_ERROR); return false; }
  }
  return {
    ...recovery,
    storageError,
    restoredForm: () => restoredForm,
    begin(input: PullSubmission["input"], revision: number): PullSubmission | null {
      if (recovery.state()) return null;
      try { if (restore()) return null; } catch { setStorageError(PULL_STORAGE_ERROR); throw new Error(PULL_STORAGE_ERROR); }
      const attempt = { idempotencyKey: createKey(), revision, input: bind(input) };
      try { journal?.write({ attempt, form: { input: attempt.input, revision } }, null); setStorageError(null); }
      catch { setStorageError(PULL_STORAGE_ERROR); throw new Error(PULL_STORAGE_ERROR); }
      return recovery.begin(attempt) ? attempt : null;
    },
    saveDraft(input: PullSubmission["input"], revision: number): void {
      const attempt = recovery.state()?.attempt;
      if (!attempt) return;
      try { journal?.write({ attempt, form: { input: bind(input), revision } }, attempt.idempotencyKey); setStorageError(null); }
      catch { setStorageError(PULL_STORAGE_ERROR); }
    },
    acknowledge(attempt: PullSubmission): boolean {
      if (recovery.state()?.attempt !== attempt || recovery.state()?.phase !== "sending") return false;
      if (!clear(attempt)) {
        recovery.fail(attempt, new TypeError(PULL_STORAGE_ERROR));
        throw new Error(PULL_STORAGE_ERROR);
      }
      return recovery.acknowledge(attempt);
    },
    fail(attempt: PullSubmission, error: unknown): void {
      if (recovery.state()?.attempt !== attempt || recovery.state()?.phase !== "sending") return;
      recovery.fail(attempt, error);
      // Only the authorized receipt handler's explicit tombstone proves that
      // retrying the old intent cannot recover a live PR. Other denials do not.
      if (error instanceof ApiError && error.status === 410 && error.code === "submission_deleted") recovery.resolve(attempt);
      if (!recovery.state() && !clear(attempt)) {
        recovery.begin(attempt); recovery.fail(attempt, new TypeError(PULL_STORAGE_ERROR));
      }
    },
  };
}
