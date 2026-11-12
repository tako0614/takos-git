import { createSignal } from "solid-js";
import { pullsApi } from "../../api/pulls.ts";
import { ApiError } from "../../api/client.ts";
import { createJournaledSubmission } from "../../lib/journaled-submission.ts";
import { isRecord } from "../../lib/submission-journal.ts";
import { createReviewJournal, reviewContext, type ReviewAttempt, type ReviewFormSnapshot, type ReviewJournalOptions, type ReviewVerdict } from "./review-journal.ts";
import { createReviewDraftStore, REVIEW_DRAFT_ERROR, type SavedReviewDraft } from "./review-draft.ts";
export type { ReviewVerdict } from "./review-journal.ts";
interface ReviewTarget { owner: string; repo: string; number: number; headSha: string }
export interface ReviewAcknowledgment { keepOpen: boolean }

/** Persist one original intent before dispatch; recovery is explicit and same-key. */
export function createReviewSubmission(options: {
  target: () => ReviewTarget;
  recovery: ReviewJournalOptions | null;
  allowNew?: () => boolean;
  onSubmitted: (ack: ReviewAcknowledgment) => void;
  onSuccess: (state: ReviewVerdict) => void;
}) {
  const reviewedHead = options.target().headSha;
  const flow = createJournaledSubmission<ReviewAttempt, ReviewFormSnapshot>(options.recovery ? createReviewJournal(options.recovery) : null,
    (a): ReviewFormSnapshot => ({ body: body(), revision: a.submittedRevision }));
  const drafts = options.recovery ? createReviewDraftStore(options.recovery) : null;
  const [draftError, setDraftError] = createSignal<string | null>(null);
  let retainedDraft: SavedReviewDraft | null = null;
  try { retainedDraft = drafts?.read() ?? null; } catch { setDraftError(REVIEW_DRAFT_ERROR); }
  let draftRaw = retainedDraft?.raw ?? null;
  let draftActive = retainedDraft !== null;
  const restored = flow.restoredForm() ?? retainedDraft?.form;
  const [body, setBody] = createSignal(restored?.body ?? "");
  const [busy, setBusy] = createSignal<ReviewVerdict | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  let revision = restored?.revision ?? 0, retired = false;
  const targetKey = () => { const t = options.target(); return JSON.stringify([t.owner, t.repo, t.number]); };
  function saveDraft(form: ReviewFormSnapshot): void {
    try { draftRaw = drafts?.write(form, draftRaw) ?? null; setDraftError(null); }
    catch { setDraftError(REVIEW_DRAFT_ERROR); throw new Error(REVIEW_DRAFT_ERROR); }
  }
  function draftAvailable(): boolean {
    if (!draftError()) return true;
    try {
      if ((drafts?.read()?.raw ?? null) !== draftRaw) return false;
      setDraftError(null); return true;
    } catch { return false; }
  }
  function updateBody(value: string): void {
    if (retired) return;
    revision += 1; setBody(value); flow.saveForm({ body: value, revision });
    if (draftActive && !flow.state()) {
      try { saveDraft({ body: value, revision }); } catch { /* Keep visible input and report storage failure. */ }
    }
  }
  async function send(attempt: ReviewAttempt): Promise<void> {
    const target = { ...options.target() }, captured = targetKey();
    const current = () => !retired && captured === targetKey();
    setBusy(attempt.state); setError(null);
    try {
      const response = await pullsApi.submitReview(target.owner, target.repo, target.number, {
        state: attempt.state, body: attempt.body ?? undefined, commitSha: attempt.commitSha, ...attempt.context,
      }, attempt.idempotencyKey);
      if (!current()) return;
      const review = isRecord(response) ? response.review : null;
      if (!isRecord(review) || typeof review.id !== "string" || !review.id.trim() || review.state !== attempt.state || review.body !== attempt.body
        || typeof review.createdAt !== "number" || !Number.isFinite(review.createdAt)
        || !(review.commitSha === null || typeof review.commitSha === "string" && /^[a-f0-9]{40}$/u.test(review.commitSha))) {
        throw new TypeError("The original review was not confirmed.");
      }
      if (attempt.commitSha !== undefined && review.commitSha !== attempt.commitSha) {
        throw new TypeError("The reviewed head was not confirmed.");
      }
      const keepOpen = revision !== attempt.submittedRevision;
      // Persist a distinct unsent draft before retiring the original journal.
      // A failed write leaves that original available for same-key recovery.
      saveDraft({ body: keepOpen ? body() : "", revision });
      if (!flow.acknowledge(attempt)) return;
      draftActive = keepOpen;
      if (!keepOpen) setBody("");
      options.onSuccess(attempt.state); options.onSubmitted({ keepOpen });
    } catch (err) {
      if (current()) {
        flow.fail(attempt, err);
        if (err instanceof ApiError && err.status === 409 && err.code === "head_changed") {
          // This owning route looked up the original receipt before refusing a
          // new insert. Preserve the draft before retiring this no-effect attempt.
          try { saveDraft({ body: body(), revision }); draftActive = true; flow.resolve(attempt); }
          catch { /* Failed local persistence retains the original journal. */ }
        }
        setError(err instanceof ApiError ? err.message : "The original review is unconfirmed. Retry the original review to reconcile its result.");
      }
    } finally { if (current()) setBusy(null); }
  }
  async function submit(state: ReviewVerdict): Promise<void> {
    if (retired || busy() || flow.state()) return;
    if (options.allowNew?.() === false) { setError("This pull request is closed. Only original review recovery is available."); return; }
    if (!/^[a-f0-9]{40}$/u.test(reviewedHead) || reviewedHead !== options.target().headSha) {
      setError("The reviewed head changed. Reopen the review form after checking the current version."); return;
    }
    if (!options.recovery) { setError("Safe review recovery is unavailable. Reload after the server has been updated."); return; }
    if (!draftAvailable()) { setError(REVIEW_DRAFT_ERROR); return; }
    const text = body().trim();
    if (state === "commented" && !text) { setError("A comment review requires a message."); return; }
    const attempt: ReviewAttempt = { idempotencyKey: crypto.randomUUID(), revision, submittedRevision: revision,
      state, body: text || null, commitSha: reviewedHead, context: reviewContext(options.recovery) };
    try { if (!flow.begin(attempt)) return; }
    catch (err) { setError(err instanceof Error ? err.message : "Review recovery could not be saved."); return; }
    await send(attempt);
  }
  async function retryOriginal(): Promise<void> {
    const attempt = flow.unknown();
    if (retired || busy() || !attempt) return;
    if (!draftAvailable()) { setError(REVIEW_DRAFT_ERROR); return; }
    // Reconfirm custody of this same journal before a manual recovery request.
    flow.saveForm({ body: body(), revision });
    if (flow.storageError()) { setError(flow.storageError()); return; }
    if (flow.retry(attempt)) await send(attempt);
  }
  return { body, busy, error, updateBody, submit, retryOriginal, pending: flow.state,
    storageError: () => draftError() ?? flow.storageError(), dispose: () => { retired = true; } };
}
