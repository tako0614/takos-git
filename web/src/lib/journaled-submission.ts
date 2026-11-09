import { createSignal, untrack } from "solid-js";
import { ApiError } from "../api/client.ts";
import { createSubmissionRecovery } from "./submission-recovery.ts";
import { SUBMISSION_STORAGE_ERROR, type SubmissionAttempt, type SubmissionJournal } from "./submission-journal.ts";

/** One write-ahead intent, restored as unknown and never automatically sent. */
export function createJournaledSubmission<A extends SubmissionAttempt, F>(journal: SubmissionJournal<A, F> | null, formFromAttempt: (attempt: A) => F) {
  const recovery = createSubmissionRecovery<A>();
  const [storageError, setStorageError] = createSignal<string | null>(null);
  const message = journal?.errorMessage ?? SUBMISSION_STORAGE_ERROR;
  let restoredForm: F | null = null;
  function restore(): boolean {
    const saved = journal?.read(); if (!saved) return false;
    const attempt = { ...saved.attempt, revision: -1 };
    recovery.begin(attempt); recovery.fail(attempt, new TypeError("Previous document did not confirm submission"));
    restoredForm = saved.form; return true;
  }
  // Construction may itself be memoized: local restore transitions must not
  // make that memo depend on the recovery state it is constructing.
  try { untrack(restore); } catch { setStorageError(message); }
  function clear(attempt: A): boolean {
    try { journal?.remove(attempt.idempotencyKey); setStorageError(null); return true; }
    catch { setStorageError(message); return false; }
  }
  return {
    ...recovery, storageError, restoredForm: () => restoredForm,
    begin(attempt: A): boolean {
      if (recovery.state()) return false;
      try {
        if (restore()) return false;
        journal?.write({ attempt, form: formFromAttempt(attempt) }, null); setStorageError(null);
      } catch { setStorageError(message); throw new Error(message); }
      return recovery.begin(attempt);
    },
    saveForm(form: F): void {
      const attempt = recovery.state()?.attempt; if (!attempt) return;
      try { journal?.write({ attempt, form }, attempt.idempotencyKey); setStorageError(null); }
      catch { setStorageError(message); }
    },
    acknowledge(attempt: A): boolean {
      if (recovery.state()?.attempt !== attempt || recovery.state()?.phase !== "sending") return false;
      if (!clear(attempt)) { recovery.fail(attempt, new TypeError(message)); throw new Error(message); }
      return recovery.acknowledge(attempt);
    },
    fail(attempt: A, error: unknown): void {
      if (recovery.state()?.attempt !== attempt || recovery.state()?.phase !== "sending") return;
      recovery.fail(attempt, error);
      if (error instanceof ApiError && error.status === 410 && error.code === "submission_deleted") recovery.resolve(attempt);
      if (!recovery.state() && !clear(attempt)) { recovery.begin(attempt); recovery.fail(attempt, new TypeError(message)); }
    },
    resolve(attempt: A): boolean {
      if (recovery.state()?.attempt !== attempt || recovery.state()?.phase !== "unknown" || !clear(attempt)) return false;
      return recovery.resolve(attempt);
    },
  };
}
