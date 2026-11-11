import { isRecord, isRevision } from "../../lib/submission-journal.ts";
import type { ReviewFormSnapshot, ReviewJournalOptions } from "./review-journal.ts";

export const REVIEW_DRAFT_ERROR = "Saved review draft is unavailable. Restore this tab's browser storage and reload before sending another review.";
const LIMIT = 2 * 1024 * 1024;
export interface SavedReviewDraft { readonly raw: string; readonly form: ReviewFormSnapshot }

/** Unsent text only, separate from an original request key or authentication. */
export function createReviewDraftStore(options: ReviewJournalOptions) {
  const key = `takos-git:review-draft:v1:${JSON.stringify([options.scope, options.repositoryId, options.issueId])}`;
  function read(): SavedReviewDraft | null {
    try {
      const raw = options.storage().getItem(key);
      if (raw === null) return null;
      if (raw.length > LIMIT) throw new Error("Oversized draft");
      const value: unknown = JSON.parse(raw);
      if (!isRecord(value) || value.version !== 1 || value.scope !== options.scope
        || value.repositoryId !== options.repositoryId || value.issueId !== options.issueId
        || !Object.keys(value).every(k => ["version", "scope", "repositoryId", "issueId", "form"].includes(k))
        || !isRecord(value.form) || typeof value.form.body !== "string" || !isRevision(value.form.revision)
        || !Object.keys(value.form).every(k => ["body", "revision"].includes(k))) throw new Error("Invalid draft");
      return { raw, form: { body: value.form.body, revision: value.form.revision } };
    } catch { throw new Error(REVIEW_DRAFT_ERROR); }
  }
  return {
    read,
    write(form: ReviewFormSnapshot, expectedRaw: string | null): string | null {
      try {
        const current = read();
        if ((current?.raw ?? null) !== expectedRaw) throw new Error("Another retained draft");
        if (typeof form.body !== "string" || !isRevision(form.revision)
          || !Object.keys(form).every(k => ["body", "revision"].includes(k))) throw new Error("Invalid form");
        const storage = options.storage();
        if (form.body === "") {
          if (current) storage.removeItem(key);
          if (storage.getItem(key) !== null) throw new Error("Draft not cleared");
          return null;
        }
        const raw = JSON.stringify({ version: 1, scope: options.scope, repositoryId: options.repositoryId,
          issueId: options.issueId, form });
        if (raw.length > LIMIT) throw new Error("Oversized draft");
        storage.setItem(key, raw);
        if (storage.getItem(key) !== raw) throw new Error("Draft not retained");
        return raw;
      } catch { throw new Error(REVIEW_DRAFT_ERROR); }
    },
  };
}
