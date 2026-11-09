export type SubmissionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export interface SubmissionAttempt { readonly idempotencyKey: string; readonly revision: number }
export interface SavedSubmission<A, F> { readonly attempt: A; readonly form: F }
export interface SubmissionJournal<A, F> {
  readonly errorMessage: string;
  read(): SavedSubmission<A, F> | null;
  write(saved: SavedSubmission<A, F>, expectedKey: string | null): void;
  remove(expectedKey: string): void;
}
export const SUBMISSION_STORAGE_ERROR = "Saved submission recovery is unavailable. Restore this tab's browser storage and try again; no new submission will be sent.";
export const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
export const isRevision = (value: unknown, minimum = 0): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
export const isSubmissionKey = (value: unknown): value is string => typeof value === "string" && /^[\x21-\x7e]{1,255}$/u.test(value);

/** Format-specific codecs retain their wire format; writes/cleanup own one key. */
export function createSubmissionJournal<A extends SubmissionAttempt, F>(options: {
  storage: () => SubmissionStorage; key: string;
  decode: (value: unknown) => SavedSubmission<A, F> | null;
  encode: (saved: SavedSubmission<A, F>) => unknown;
  errorMessage?: string;
}): SubmissionJournal<A, F> {
  const message = options.errorMessage ?? SUBMISSION_STORAGE_ERROR;
  const read = (): SavedSubmission<A, F> | null => {
    try {
      const raw = options.storage().getItem(options.key);
      if (raw === null) return null;
      if (raw.length > 2 * 1024 * 1024) throw new Error("Oversized recovery");
      const saved = options.decode(JSON.parse(raw));
      if (!saved) throw new Error("Invalid recovery");
      return saved;
    } catch { throw new Error(message); }
  };
  return {
    errorMessage: message, read,
    write(saved, expectedKey) {
      try {
        const current = read();
        if (current && current.attempt.idempotencyKey !== expectedKey) throw new Error("Another pending intent");
        const raw = JSON.stringify(options.encode(saved));
        if (raw.length > 2 * 1024 * 1024) throw new Error("Oversized recovery");
        const storage = options.storage(); storage.setItem(options.key, raw);
        if (storage.getItem(options.key) !== raw) throw new Error("Recovery was not retained");
      } catch { throw new Error(message); }
    },
    remove(expectedKey) {
      try {
        const current = read(); if (!current) return;
        if (current.attempt.idempotencyKey !== expectedKey) throw new Error("Another pending intent");
        const storage = options.storage(); storage.removeItem(options.key);
        if (storage.getItem(options.key) !== null) throw new Error("Recovery was not cleared");
      } catch { throw new Error(message); }
    },
  };
}
