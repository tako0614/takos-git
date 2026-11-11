import { createSignal } from "solid-js";
import { pullsApi } from "../../api/pulls.ts";
import { ApiError } from "../../api/client.ts";
import { createJournaledSubmission } from "../../lib/journaled-submission.ts";
import { isRecord } from "../../lib/submission-journal.ts";
import { createReviewJournal, reviewContext, type ReviewAttempt, type ReviewFormSnapshot, type ReviewJournalOptions, type ReviewVerdict } from "./review-journal.ts";
export type { ReviewVerdict } from "./review-journal.ts";
interface ReviewTarget { owner: string; repo: string; number: number }
export interface ReviewAcknowledgment { keepOpen: boolean }

/** Persist one original intent before dispatch; recovery is explicit and same-key. */
export function createReviewSubmission(options: {
  target: () => ReviewTarget;
  recovery: ReviewJournalOptions | null;
  onSubmitted: (ack: ReviewAcknowledgment) => void;
  onSuccess: (state: ReviewVerdict) => void;
}) {
  const flow = createJournaledSubmission<ReviewAttempt, ReviewFormSnapshot>(options.recovery ? createReviewJournal(options.recovery) : null,
    (a): ReviewFormSnapshot => ({ body: body(), revision: a.submittedRevision }));
  const restored = flow.restoredForm();
  const [body, setBody] = createSignal(restored?.body ?? "");
  const [busy, setBusy] = createSignal<ReviewVerdict | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  let revision = restored?.revision ?? 0, retired = false;
  const targetKey = () => { const t = options.target(); return JSON.stringify([t.owner, t.repo, t.number]); };
  function updateBody(value: string): void {
    revision += 1; setBody(value); flow.saveForm({ body: value, revision });
  }
  async function send(attempt: ReviewAttempt): Promise<void> {
    const target = { ...options.target() }, captured = targetKey();
    const current = () => !retired && captured === targetKey();
    setBusy(attempt.state); setError(null);
    try {
      const response = await pullsApi.submitReview(target.owner, target.repo, target.number, {
        state: attempt.state, body: attempt.body ?? undefined, ...attempt.context,
      }, attempt.idempotencyKey);
      if (!current()) return;
      const review = isRecord(response) ? response.review : null;
      if (!isRecord(review) || typeof review.id !== "string" || !review.id.trim() || review.state !== attempt.state || review.body !== attempt.body
        || typeof review.createdAt !== "number" || !Number.isFinite(review.createdAt)
        || !(review.commitSha === null || typeof review.commitSha === "string" && /^[a-f0-9]{40}$/u.test(review.commitSha))) {
        throw new TypeError("The original review was not confirmed.");
      }
      if (!flow.acknowledge(attempt)) return;
      const keepOpen = revision !== attempt.submittedRevision;
      if (!keepOpen) setBody("");
      options.onSuccess(attempt.state); options.onSubmitted({ keepOpen });
    } catch (err) {
      if (current()) {
        flow.fail(attempt, err);
        setError(err instanceof ApiError ? err.message : "The original review is unconfirmed. Retry the original review to reconcile its result.");
      }
    } finally { if (current()) setBusy(null); }
  }
  async function submit(state: ReviewVerdict): Promise<void> {
    if (retired || busy() || flow.state()) return;
    if (!options.recovery) { setError("Safe review recovery is unavailable. Reload after the server has been updated."); return; }
    const text = body().trim();
    if (state === "commented" && !text) { setError("A comment review requires a message."); return; }
    const attempt: ReviewAttempt = { idempotencyKey: crypto.randomUUID(), revision, submittedRevision: revision,
      state, body: text || null, context: reviewContext(options.recovery) };
    try { if (!flow.begin(attempt)) return; }
    catch (err) { setError(err instanceof Error ? err.message : "Review recovery could not be saved."); return; }
    await send(attempt);
  }
  async function retryOriginal(): Promise<void> {
    const attempt = flow.unknown();
    if (retired || busy() || !attempt) return;
    // Reconfirm custody of this same journal before a manual recovery request.
    flow.saveForm({ body: body(), revision });
    if (flow.storageError()) { setError(flow.storageError()); return; }
    if (flow.retry(attempt)) await send(attempt);
  }
  return { body, busy, error, updateBody, submit, retryOriginal, pending: flow.state,
    storageError: flow.storageError, dispose: () => { retired = true; } };
}
