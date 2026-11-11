/**
 * Submit-review panel: an overall review body plus the three GitHub verdicts —
 * Comment / Request changes / Approve — posted via `pullsApi.review`. A
 * `commented` verdict requires a body, checked before dispatch and by the server.
 */
import { onCleanup, Show, type JSX } from "solid-js";
import { Banner, Button, Icons, Textarea, useToast } from "../../ui/index.ts";
import { createReviewSubmission, type ReviewAcknowledgment } from "./review-submission.ts";

export function ReviewForm(props: {
  owner: string;
  repo: string;
  number: number;
  onSubmitted: (ack: ReviewAcknowledgment) => void;
  onCancel?: () => void;
}): JSX.Element {
  const toast = useToast();
  const flow = createReviewSubmission({
    target: () => ({ owner: props.owner, repo: props.repo, number: props.number }),
    onSubmitted: (ack) => props.onSubmitted(ack),
    onSuccess: (state) => {
      toast.success(
        state === "approved"
          ? "Approved."
          : state === "changes_requested"
            ? "Requested changes."
            : "Review submitted.",
      );
    },
  });
  onCleanup(flow.dispose);

  return (
    <div class="space-y-3 rounded-md border border-border bg-canvas p-4">
      <h3 class="text-sm font-semibold text-fg">Finish your review</h3>
      <Show when={flow.error()}>
        <Banner tone="danger">{flow.error()}</Banner>
      </Show>
      <Textarea
        rows={4}
        placeholder="Leave an overall review comment…"
        value={flow.body()}
        onInput={(e) => flow.updateBody(e.currentTarget.value)}
      />
      <div class="flex flex-wrap items-center gap-2">
        <Button variant="default" onClick={() => void flow.submit("commented")} disabled={!!flow.busy()}>
          <Icons.MessageSquare class="h-4 w-4" /> Comment
        </Button>
        <Button variant="default" onClick={() => void flow.submit("changes_requested")} disabled={!!flow.busy()}>
          <Icons.AlertTriangle class="h-4 w-4" /> Request changes
        </Button>
        <Button variant="primary" onClick={() => void flow.submit("approved")} disabled={!!flow.busy()}>
          <Icons.Check class="h-4 w-4" /> Approve
        </Button>
        <Show when={props.onCancel}>
          <Button variant="invisible" onClick={() => props.onCancel?.()} disabled={!!flow.busy()}>
            Cancel
          </Button>
        </Show>
      </div>
    </div>
  );
}
