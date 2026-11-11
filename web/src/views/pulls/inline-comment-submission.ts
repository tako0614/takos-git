import { createSignal } from "solid-js";
import { ApiError } from "../../api/client.ts";
import { pullsApi } from "../../api/pulls.ts";
import { isRecord } from "../../lib/submission-journal.ts";

export interface InlineCommentTarget {
  owner: string;
  repo: string;
  number: number;
  path: string;
  side: "LEFT" | "RIGHT";
  line: number;
  commitSha: string;
  /** Non-authorizing UI identity: never sent as a credential or API field. */
  scope: string;
}

export function createInlineCommentSubmission(options: {
  target: () => InlineCommentTarget;
  onSubmitted: (ack: { keepOpen: boolean }) => void;
}) {
  const [body, setBody] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const originalTarget = JSON.stringify(options.target());
  let revision = 0, retired = false;
  const current = () => !retired && originalTarget === JSON.stringify(options.target());
  const targetChanged = () => setError("The comment target changed. Reopen this composer before submitting again.");
  async function submit(): Promise<void> {
    if (retired || busy()) return;
    if (!current()) { targetChanged(); return; }
    const text = body().trim();
    if (!text) return;
    const target = { ...options.target() }, submittedRevision = revision;
    setBusy(true); setError(null);
    try {
      if (!current()) return;
      const response = await pullsApi.comment(target.owner, target.repo, target.number, {
        body: text, path: target.path, side: target.side, line: target.line, commitSha: target.commitSha,
      });
      if (!current()) { if (!retired) targetChanged(); return; }
      const comment = isRecord(response) ? response.comment : null;
      if (!isRecord(comment) || typeof comment.id !== "string" || !comment.id.trim()
        || comment.body !== text || comment.path !== target.path || comment.side !== target.side
        || comment.line !== target.line || comment.commitSha !== target.commitSha) {
        throw new TypeError("The original comment was not confirmed. Check the comment list before submitting again.");
      }
      const keepOpen = revision !== submittedRevision;
      if (!keepOpen) setBody("");
      if (current()) options.onSubmitted({ keepOpen });
    } catch (err) {
      if (current()) setError(err instanceof ApiError ? err.message : err instanceof TypeError ? err.message : "The comment was not confirmed. Check the comment list before submitting again.");
    } finally { if (!retired) setBusy(false); }
  }
  return { body, busy, error, submit,
    updateBody(value: string): void { if (!retired) { revision += 1; setBody(value); } },
    dispose(): void { retired = true; },
  };
}
