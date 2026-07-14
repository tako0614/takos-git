/**
 * Submit-review panel: an overall review body plus the three GitHub verdicts —
 * Comment / Request changes / Approve — posted via `pullsApi.review`. A
 * `commented` verdict requires a body (server-enforced); the button disables
 * accordingly.
 */
import { createSignal, Show, type JSX } from "solid-js";
import { pullsApi } from "../../api/pulls.ts";
import { ApiError } from "../../api/client.ts";
import { Banner, Button, Icons, Textarea, useToast } from "../../ui/index.ts";

type Verdict = "approved" | "changes_requested" | "commented";

export function ReviewForm(props: {
  owner: string;
  repo: string;
  number: number;
  onSubmitted: () => void;
  onCancel?: () => void;
}): JSX.Element {
  const toast = useToast();
  const [body, setBody] = createSignal("");
  const [busy, setBusy] = createSignal<Verdict | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  const submit = async (state: Verdict) => {
    if (busy()) return;
    if (state === "commented" && !body().trim()) {
      setError("A comment review requires a message.");
      return;
    }
    setBusy(state);
    setError(null);
    try {
      await pullsApi.review(props.owner, props.repo, props.number, {
        state,
        body: body().trim() || undefined,
      });
      toast.success(
        state === "approved"
          ? "Approved."
          : state === "changes_requested"
            ? "Requested changes."
            : "Review submitted.",
      );
      setBody("");
      props.onSubmitted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to submit review.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div class="space-y-3 rounded-md border border-border bg-canvas p-4">
      <h3 class="text-sm font-semibold text-fg">Finish your review</h3>
      <Show when={error()}>
        <Banner tone="danger">{error()}</Banner>
      </Show>
      <Textarea
        rows={4}
        placeholder="Leave an overall review comment…"
        value={body()}
        onInput={(e) => setBody(e.currentTarget.value)}
      />
      <div class="flex flex-wrap items-center gap-2">
        <Button variant="default" onClick={() => submit("commented")} disabled={!!busy()}>
          <Icons.MessageSquare class="h-4 w-4" /> Comment
        </Button>
        <Button variant="default" onClick={() => submit("changes_requested")} disabled={!!busy()}>
          <Icons.AlertTriangle class="h-4 w-4" /> Request changes
        </Button>
        <Button variant="primary" onClick={() => submit("approved")} disabled={!!busy()}>
          <Icons.Check class="h-4 w-4" /> Approve
        </Button>
        <Show when={props.onCancel}>
          <Button variant="invisible" onClick={() => props.onCancel?.()} disabled={!!busy()}>
            Cancel
          </Button>
        </Show>
      </div>
    </div>
  );
}
