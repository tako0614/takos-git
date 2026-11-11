/**
 * Conversation tab: the PR description, a merged timeline of issue comments and
 * review verdicts, a review summary, the comment composer + close/reopen
 * actions, an inline "add review" panel, and the merge box.
 *
 * PR conversation comments are issue comments (a PR is an issue), so they are
 * read/written through `issuesApi.comments` / `issuesApi.comment`.
 */
import {
  createMemo,
  createResource,
  createSignal,
  ErrorBoundary,
  For,
  onCleanup,
  Show,
  Suspense,
  type JSX,
} from "solid-js";
import { pullsApi } from "../../api/pulls.ts";
import { issuesApi } from "../../api/issues.ts";
import { ApiError } from "../../api/client.ts";
import type {
  IssueCommentDto,
  PullRequestDto,
  ReviewDto,
} from "../../api/types.ts";
import { useSession } from "../../store/session.tsx";
import { useSubmissionScope } from "../../lib/submission-scope.ts";
import { createCommentSubmission, type CommentSubmission } from "../issues/comment-submission.ts";
import { createCommentTimeline } from "../issues/comment-timeline.ts";
import { acknowledgeCommentReceipt } from "./comment-receipt.ts";
import {
  Avatar,
  Banner,
  Box,
  Button,
  Icons,
  Label,
  LoadingBlock,
  Markdown,
  RelativeTime,
  Textarea,
  useConfirmDialog,
  useToast,
} from "../../ui/index.ts";
import { principalName, reviewStateLabel } from "./shared.tsx";
import { ReviewForm } from "./ReviewForm.tsx";
import { MergeBox } from "./MergeBox.tsx";

interface TimelineEntry {
  readonly at: number;
  readonly kind: "comment" | "review";
  readonly comment?: IssueCommentDto;
  readonly review?: ReviewDto;
}

function CommentCard(props: {
  authorName: string;
  at: number;
  header?: JSX.Element;
  body: string | null;
}): JSX.Element {
  return (
    <div class="flex gap-3">
      <Avatar name={props.authorName} size={32} class="mt-0.5" />
      <Box class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-2 border-b border-border bg-canvas-subtle px-4 py-2 text-sm">
          <span class="font-semibold text-fg">{props.authorName}</span>
          {props.header}
          <span class="text-muted">
            commented <RelativeTime epochMs={props.at} />
          </span>
        </div>
        <div class="px-4 py-3">
          <Markdown source={props.body} />
        </div>
      </Box>
    </div>
  );
}

function ReviewCard(props: { review: ReviewDto }): JSX.Element {
  const tone = () =>
    props.review.state === "approved"
      ? "success"
      : props.review.state === "changes_requested"
        ? "danger"
        : "default";
  const icon = () =>
    props.review.state === "approved" ? (
      <Icons.Check class="h-3.5 w-3.5" />
    ) : props.review.state === "changes_requested" ? (
      <Icons.AlertTriangle class="h-3.5 w-3.5" />
    ) : (
      <Icons.Eye class="h-3.5 w-3.5" />
    );
  return (
    <div class="flex gap-3">
      <Avatar name={principalName(props.review.reviewer)} size={32} class="mt-0.5" />
      <Box class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-2 border-b border-border bg-canvas-subtle px-4 py-2 text-sm">
          <span class="font-semibold text-fg">{principalName(props.review.reviewer)}</span>
          <Label tone={tone()}>{icon()} {reviewStateLabel(props.review.state)}</Label>
          <span class="text-muted"><RelativeTime epochMs={props.review.createdAt} /></span>
        </div>
        <Show when={props.review.body}>
          <div class="px-4 py-3">
            <Markdown source={props.review.body} />
          </div>
        </Show>
      </Box>
    </div>
  );
}

function ReviewSummary(props: { reviews: readonly ReviewDto[] }): JSX.Element {
  const verdicts = createMemo(() => {
    const latest = new Map<string, string>();
    const ordered = [...props.reviews].sort((a, b) => a.createdAt - b.createdAt);
    for (const r of ordered) {
      const key = r.reviewer?.id ?? r.id;
      if (r.state === "approved" || r.state === "changes_requested") latest.set(key, r.state);
      else if (r.state === "dismissed") latest.delete(key);
    }
    let approvals = 0;
    let changes = 0;
    for (const v of latest.values()) {
      if (v === "approved") approvals += 1;
      if (v === "changes_requested") changes += 1;
    }
    return { approvals, changes };
  });

  return (
    <Show when={props.reviews.length > 0}>
      <div class="flex flex-wrap items-center gap-3 rounded-md border border-border bg-canvas-subtle px-4 py-2 text-sm">
        <span class="font-semibold text-fg">Reviews</span>
        <Show when={verdicts().approvals > 0}>
          <Label tone="success"><Icons.Check class="h-3.5 w-3.5" /> {verdicts().approvals} approved</Label>
        </Show>
        <Show when={verdicts().changes > 0}>
          <Label tone="danger"><Icons.AlertTriangle class="h-3.5 w-3.5" /> {verdicts().changes} requested changes</Label>
        </Show>
        <Show when={verdicts().approvals === 0 && verdicts().changes === 0}>
          <span class="text-muted">No decisive verdicts yet.</span>
        </Show>
      </div>
    </Show>
  );
}

interface ConversationProps {
  owner: string;
  repo: string;
  pr: PullRequestDto;
  onChanged: () => void;
}
interface ConversationTarget {
  owner: string; repo: string; number: number;
  repositoryId?: string; recoveryScope?: string; issueId?: string;
}

export function PRConversation(props: ConversationProps): JSX.Element {
  const scope = useSubmissionScope(() => props.owner, () => props.repo);
  const target = createMemo(() => ({
    owner: props.owner, repo: props.repo, number: props.pr.number, issueId: props.pr.issueId,
    repositoryId: scope()?.repositoryId, recoveryScope: scope()?.recoveryScope,
  }), undefined, { equals: (a, b) => a?.owner === b.owner && a?.repo === b.repo && a?.number === b.number
    && a?.issueId === b.issueId && a?.repositoryId === b.repositoryId && a?.recoveryScope === b.recoveryScope });
  return <Show when={target()} keyed>{identity => <Conversation owner={identity.owner} repo={identity.repo} pr={props.pr} onChanged={props.onChanged} target={identity} />}</Show>;
}

function Conversation(props: ConversationProps & { target: ConversationTarget }): JSX.Element {
  const session = useSession();
  const toast = useToast();
  const { confirm } = useConfirmDialog();
  const target = props.target;
  const flow = target.repositoryId && target.recoveryScope && target.issueId ? createCommentSubmission({
    storage: () => sessionStorage, scope: target.recoveryScope, repositoryId: target.repositoryId, issueId: target.issueId,
  }) : null;
  const restored = flow?.restoredForm();
  const [draft, setDraft] = createSignal(restored?.body ?? "");
  let revision = restored?.revision ?? 0, retired = false;
  onCleanup(() => { retired = true; });
  const updateDraft = (body: string) => { revision += 1; setDraft(body); flow?.saveDraft(body, revision); };
  const [posting, setPosting] = createSignal(false);
  const [showReview, setShowReview] = createSignal(false);
  const [busy, setBusy] = createSignal(false);

  const key = () => [target.owner, target.repo, target.number] as const;

  const [reviews, { refetch: refetchReviews }] = createResource(key, ([o, r, n]) =>
    pullsApi.reviews(o, r, n),
  );
  const commentTimeline = createCommentTimeline();
  const [loadingMore, setLoadingMore] = createSignal(false);
  let readGeneration = 0;
  const [comments, { refetch: refetchComments }] = createResource(key, async ([o, r, n]) => {
    const read = commentTimeline.beginRead(), generation = ++readGeneration;
    try {
      const page = await issuesApi.comments(o, r, n);
      if (!retired && generation === readGeneration) commentTimeline.accept(read, page, true);
      return page;
    } finally { commentTimeline.finishRead(read); }
  });

  async function loadMoreComments(): Promise<void> {
    const cursor = commentTimeline.cursor();
    if (retired || loadingMore() || comments.loading || !cursor) return;
    const read = commentTimeline.beginRead(), generation = readGeneration;
    setLoadingMore(true);
    try {
      const page = await issuesApi.comments(target.owner, target.repo, target.number, { cursor });
      if (!retired && generation === readGeneration && commentTimeline.cursor() === cursor) commentTimeline.accept(read, page, false);
    } catch (err) {
      if (!retired && generation === readGeneration) toast.error(err instanceof ApiError ? err.message : "Could not load more comments.");
    } finally {
      commentTimeline.finishRead(read);
      if (!retired) setLoadingMore(false);
    }
  }

  const timeline = createMemo<TimelineEntry[]>(() => {
    const entries: TimelineEntry[] = [];
    comments(); // Preserve resource loading/error handling for the conversation boundary.
    for (const c of commentTimeline.items()) {
      entries.push({ at: c.createdAt, kind: "comment", comment: c });
    }
    for (const r of reviews()?.items ?? []) {
      // "commented" reviews with no body are noise in the timeline; keep those
      // with a body or a decisive verdict.
      if (r.state === "commented" && !r.body) continue;
      entries.push({ at: r.createdAt, kind: "review", review: r });
    }
    return entries.sort((a, b) => a.at - b.at);
  });

  const addComment = async () => {
    if (retired || !flow || flow.state() || flow.storageError() || !draft().trim() || posting()) return;
    const attempt: CommentSubmission = { body: draft().trim(), revision, idempotencyKey: crypto.randomUUID(), context: flow.context };
    try { if (flow.begin(attempt)) await sendComment(attempt); }
    catch (err) { if (!retired) toast.error(err instanceof Error ? err.message : "Could not retain this comment before sending."); }
  };

  async function sendComment(attempt: CommentSubmission): Promise<void> {
    if (!flow || retired) return;
    setPosting(true);
    try {
      const response = await issuesApi.comment(target.owner, target.repo, target.number, attempt.body, attempt.idempotencyKey, attempt.context);
      if (retired) return;
      const comment = acknowledgeCommentReceipt(flow, attempt, response); if (!comment) return;
      commentTimeline.acknowledge(comment);
      if (revision === attempt.revision) setDraft("");
      // The ACK already supplies this row. A first-page refresh could hide it
      // beyond the loaded cursor range; refresh only the PR's count/state.
      props.onChanged();
    } catch (err) {
      if (retired) return;
      flow.fail(attempt, err);
      if (flow.unknown()) { void refetchComments(); props.onChanged(); }
      else toast.error(err instanceof ApiError ? err.message : "Failed to comment.");
    } finally {
      if (!retired) setPosting(false);
    }
  }

  async function retryComment(attempt: CommentSubmission): Promise<void> {
    if (!flow || retired || posting()) return;
    const ok = await confirm({ title: "Retry the original comment?", message: "Recover the original comment with the same key. Your newer draft will stay in this form.", confirmText: "Retry comment" });
    if (ok && !retired && !posting() && flow.retry(attempt)) await sendComment(attempt);
  }

  const toggleState = async () => {
    if (retired || busy()) return;
    setBusy(true);
    try {
      if (props.pr.state === "open") await pullsApi.close(target.owner, target.repo, target.number);
      else await pullsApi.reopen(target.owner, target.repo, target.number);
      if (!retired) props.onChanged();
    } catch (err) {
      if (!retired) toast.error(err instanceof ApiError ? err.message : "Failed to update pull request.");
    } finally {
      if (!retired) setBusy(false);
    }
  };

  return (
    <div class="space-y-4">
      {/* Description */}
      <CommentCard
        authorName={principalName(props.pr.author)}
        at={props.pr.createdAt}
        header={<Label tone="accent">author</Label>}
        body={props.pr.body}
      />

      <ErrorBoundary
        fallback={(err) => (
          <Banner tone="danger" title="Could not load the conversation">
            {err instanceof ApiError ? err.message : "Unexpected error."}
          </Banner>
        )}
      >
        <Suspense fallback={<LoadingBlock label="Loading conversation…" />}>
          <ReviewSummary reviews={reviews()?.items ?? []} />
          <div class="space-y-4">
            <For each={timeline()}>
              {(entry) => (
                <Show
                  when={entry.kind === "comment"}
                  fallback={<ReviewCard review={entry.review!} />}
                >
                  <CommentCard
                    authorName={principalName(entry.comment!.author)}
                    at={entry.comment!.createdAt}
                    body={entry.comment!.body}
                  />
                </Show>
              )}
            </For>
          </div>
          <Show when={commentTimeline.cursor()}>
            <div class="flex justify-center">
              <Button onClick={() => void loadMoreComments()} disabled={loadingMore() || comments.loading}>
                {loadingMore() ? "Loading comments…" : "Load more comments"}
              </Button>
            </div>
          </Show>
        </Suspense>
      </ErrorBoundary>

      {/* Merge box */}
      <MergeBox owner={props.owner} repo={props.repo} pr={props.pr} onChanged={props.onChanged} />

      {/* Composer / actions */}
      <Show
        when={session.authenticated()}
        fallback={
          <Banner
            tone="info"
            action={<Button size="sm" variant="primary" onClick={() => session.signIn()}>Sign in</Button>}
          >
            Sign in to comment, review, or merge this pull request.
          </Banner>
        }
      >
        <Show when={showReview()}>
          <ReviewForm
            owner={props.owner}
            repo={props.repo}
            number={props.pr.number}
            onSubmitted={({ keepOpen }) => {
              if (!keepOpen) setShowReview(false);
              refetchReviews();
            }}
            onCancel={() => setShowReview(false)}
          />
        </Show>

        <Box class="p-4">
          <Show when={!flow}><Banner tone="warning">Safe PR comment recovery is unavailable. Refresh after the server has been updated.</Banner></Show>
          <Show when={flow?.storageError()}>{message => <Banner tone="danger">{message()}</Banner>}</Show>
          <Show when={flow?.unknown()}>{attempt => <Banner tone="warning" title="Comment result is not confirmed">
            Check the conversation or recover the original submission. A new comment will not be sent while its result is unknown.
            <div class="mt-2 flex flex-wrap gap-2">
              <Button size="sm" onClick={() => void refetchComments()}>Refresh conversation</Button>
              <Button size="sm" onClick={() => void retryComment(attempt())}>Retry original comment…</Button>
            </div>
          </Banner>}</Show>
          <Textarea
            rows={4}
            placeholder="Leave a comment"
            value={draft()}
            onInput={(e) => updateDraft(e.currentTarget.value)}
          />
          <div class="mt-3 flex flex-wrap items-center justify-end gap-2">
            <Show when={!showReview() && props.pr.state === "open"}>
              <Button variant="default" onClick={() => setShowReview(true)}>
                <Icons.Eye class="h-4 w-4" /> Add your review
              </Button>
            </Show>
            <Button variant="default" onClick={toggleState} disabled={busy() || props.pr.merged}>
              <Show when={props.pr.state === "open"} fallback={<><Icons.RefreshCw class="h-4 w-4" /> Reopen</>}>
                <Icons.X class="h-4 w-4" /> Close pull request
              </Show>
            </Button>
            <Button variant="primary" onClick={addComment} disabled={!flow || !!flow.state() || !!flow.storageError() || !draft().trim() || posting()}>
              {posting() ? "Commenting…" : "Comment"}
            </Button>
          </div>
        </Box>
      </Show>
    </div>
  );
}
