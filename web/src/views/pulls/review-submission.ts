import { createSignal } from "solid-js";
import { pullsApi } from "../../api/pulls.ts";
import { ApiError } from "../../api/client.ts";

export type ReviewVerdict = "approved" | "changes_requested" | "commented";
interface ReviewTarget { owner: string; repo: string; number: number }
export interface ReviewAcknowledgment { keepOpen: boolean }

/** One mounted review form; retiring it must suppress its late completion effects. */
export function createReviewSubmission(options: {
  target: () => ReviewTarget;
  onSubmitted: (ack: ReviewAcknowledgment) => void;
  onSuccess: (state: ReviewVerdict) => void;
}) {
  const [body, setBody] = createSignal("");
  const [busy, setBusy] = createSignal<ReviewVerdict | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  let revision = 0, retired = false;
  const targetKey = () => {
    const t = options.target();
    return JSON.stringify([t.owner, t.repo, t.number]);
  };
  function updateBody(value: string): void { revision += 1; setBody(value); }
  async function submit(state: ReviewVerdict): Promise<void> {
    if (retired || busy()) return;
    const text = body().trim();
    if (state === "commented" && !text) {
      setError("A comment review requires a message.");
      return;
    }
    const target = { ...options.target() }, captured = targetKey(), sentRevision = revision;
    const current = () => !retired && captured === targetKey();
    setBusy(state);
    setError(null);
    try {
      await pullsApi.review(target.owner, target.repo, target.number, {
        state, body: text || undefined,
      });
      if (!current()) return;
      const keepOpen = revision !== sentRevision;
      if (!keepOpen) setBody("");
      options.onSuccess(state);
      options.onSubmitted({ keepOpen });
    } catch (err) {
      if (current()) setError(err instanceof ApiError ? err.message : "Failed to submit review.");
    } finally {
      if (current()) setBusy(null);
    }
  }
  return { body, busy, error, updateBody, submit, dispose: () => { retired = true; } };
}
