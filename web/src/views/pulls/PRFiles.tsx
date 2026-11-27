/**
 * Files-changed tab: a per-file unified diff with inline review comments
 * anchored to (path, side, line), an add-comment composer on any diff line, a
 * per-file section for outdated/off-diff comments, and the "Review changes"
 * flow (approve / request changes / comment) via `ReviewForm`.
 *
 * A local diff renderer is used (rather than ui `FileDiffView`) because inline
 * comment anchoring requires injecting comment/composer rows between diff lines
 * — a capability the shared renderer intentionally omits.
 */
import {
  createMemo,
  createResource,
  createSignal,
  createUniqueId,
  onCleanup,
  ErrorBoundary,
  For,
  Index,
  Show,
  Suspense,
  type JSX,
} from "solid-js";
import { pullsApi } from "../../api/pulls.ts";
import { ApiError } from "../../api/client.ts";
import type {
  DiffHunk,
  DiffLine,
  PullRequestDto,
  ReviewCommentDto,
} from "../../api/types.ts";
import { useSession } from "../../store/session.tsx";
import { cn } from "../../lib/cn.ts";
import {
  Avatar,
  Banner,
  Box,
  Button,
  EmptyState,
  Icons,
  Label,
  LoadingBlock,
  Markdown,
  RelativeTime,
  Textarea,
  useToast,
} from "../../ui/index.ts";
import type { PrFile } from "./types.ts";
import { principalName } from "./shared.tsx";
import { ReviewForm } from "./ReviewForm.tsx";
import { useSubmissionScope } from "../../lib/submission-scope.ts";
import { diffHunkHeader, reviewLineTarget as addTarget } from "../../lib/diff-lines.ts";
import { createInlineCommentSubmission, type InlineCommentTarget } from "./inline-comment-submission.ts";

const STATUS_TONE: Record<string, string> = {
  added: "text-success",
  deleted: "text-danger",
  modified: "text-attention",
  renamed: "text-accent",
  copied: "text-accent",
};

const SEP = "\0";
function commentKey(path: string, side: "LEFT" | "RIGHT", line: number): string {
  return `${path}${SEP}${side}${SEP}${line}`;
}

function lineBg(type: DiffLine["type"]): string {
  if (type === "add") return "bg-success-subtle";
  if (type === "delete") return "bg-danger-subtle";
  return "";
}
function marker(type: DiffLine["type"]): string {
  return type === "add" ? "+" : type === "delete" ? "-" : " ";
}
function markerClass(type: DiffLine["type"]): string {
  if (type === "add") return "text-success";
  if (type === "delete") return "text-danger";
  return "text-subtle";
}

function CommentThread(props: { comments: readonly ReviewCommentDto[] }): JSX.Element {
  return (
    <div class="space-y-2 bg-canvas p-2">
      <For each={props.comments}>
        {(comment) => (
          <Box class="text-sm">
            <div class="flex flex-wrap items-center gap-2 border-b border-border bg-canvas-subtle px-3 py-1.5">
              <Avatar name={principalName(comment.author)} size={18} />
              <span class="font-semibold text-fg">{principalName(comment.author)}</span>
              <span class="text-xs text-muted"><RelativeTime epochMs={comment.createdAt} /></span>
              <Show when={comment.outdated}>
                <Label tone="attention">Outdated</Label>
              </Show>
            </div>
            <div class="px-3 py-2">
              <Markdown source={comment.body} />
            </div>
          </Box>
        )}
      </For>
    </div>
  );
}

function Composer(props: {
  target: () => InlineCommentTarget;
  onSubmitted: (ack: { keepOpen: boolean }) => void;
  onCancel: () => void;
}): JSX.Element {
  const flow = createInlineCommentSubmission({ target: () => props.target(), onSubmitted: ack => props.onSubmitted(ack) });
  onCleanup(flow.dispose);
  return (
    <div class="space-y-2 bg-canvas p-2">
      <Show when={flow.error()}><Banner tone="danger">{flow.error()}</Banner></Show>
      <Textarea
        name="inlineReviewComment"
        aria-label={`Review comment on ${props.target().path} line ${props.target().line}`}
        rows={3}
        placeholder="Leave a comment on this line…"
        value={flow.body()}
        onInput={(e) => flow.updateBody(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.isComposing || e.keyCode === 229) return;
          if (e.key === "Escape" && !flow.busy()) {
            e.preventDefault();
            e.stopPropagation();
            props.onCancel();
            return;
          }
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && flow.body().trim() && !flow.busy()) {
            e.preventDefault();
            void flow.submit();
          }
        }}
      />
      <div class="flex items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          disabled={!flow.body().trim() || flow.busy()}
          onClick={() => void flow.submit()}
        >
          {flow.busy() ? "Adding…" : "Add comment"}
        </Button>
        <Button size="sm" variant="invisible" onClick={props.onCancel} disabled={flow.busy()}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function LineRows(props: {
  file: PrFile;
  hunk: DiffHunk;
  commentsByKey: Map<string, ReviewCommentDto[]>;
  canWrite: boolean;
  activeComposer: string | null;
  onOpenComposer: (key: string) => void;
  onCancelComposer: () => void;
  targetForComposer: (path: string, side: "LEFT" | "RIGHT", line: number) => InlineCommentTarget;
  onCommentSubmitted: (ack: { keepOpen: boolean }) => void;
}): JSX.Element {
  return (
    <>
      <tr>
        <td colSpan={4} class="bg-accent-subtle px-3 py-1 font-mono text-xs text-muted">
          {diffHunkHeader(props.hunk)}
        </td>
      </tr>
      <Index each={props.hunk.lines}>
        {(lineAccessor) => {
          const line = lineAccessor;
          const target = () => addTarget(line());
          const rowKey = () => {
            const t = target();
            return t ? commentKey(props.file.path, t.side, t.line) : "";
          };
          // Comments anchored to either side number present on this row.
          const rowComments = () => {
            const out: ReviewCommentDto[] = [];
            const l = line();
            if (l.newLineNumber != null && l.type !== "delete") {
              out.push(...(props.commentsByKey.get(commentKey(props.file.path, "RIGHT", l.newLineNumber)) ?? []));
            }
            if (l.oldLineNumber != null && l.type !== "add") {
              out.push(...(props.commentsByKey.get(commentKey(props.file.path, "LEFT", l.oldLineNumber)) ?? []));
            }
            return out;
          };
          return (
            <>
              <tr class={cn("group font-mono text-xs leading-5", lineBg(line().type))}>
                <td class="w-10 select-none border-r border-border px-2 text-right text-subtle">
                  {line().oldLineNumber ?? ""}
                </td>
                <td class="w-10 select-none border-r border-border px-2 text-right text-subtle">
                  {line().newLineNumber ?? ""}
                </td>
                <td class="w-7 select-none text-center">
                  <Show when={props.canWrite && target()}>
                    {(t) => (
                      <button
                        type="button"
                        aria-label={`Add review comment on ${props.file.path} line ${t().line}${t().side === "LEFT" ? " (old)" : ""}`}
                        aria-expanded={props.activeComposer === rowKey()}
                        class="tg-focus inline-flex h-6 w-6 items-center justify-center rounded bg-accent-emphasis text-white opacity-100 sm:h-5 sm:w-5 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 focus-visible:opacity-100"
                        onClick={() => props.onOpenComposer(rowKey())}
                      >
                        <Icons.Plus class="h-3 w-3" />
                      </button>
                    )}
                  </Show>
                </td>
                <td class="whitespace-pre px-2">
                  <span class={cn("select-none font-semibold", markerClass(line().type))}>{marker(line().type)} </span>
                  {line().content}
                </td>
              </tr>
              <Show when={rowComments().length > 0 || props.activeComposer === rowKey()}>
                <tr>
                  <td colSpan={4} class="border-y border-border p-0">
                    <Show when={rowComments().length > 0}>
                      <CommentThread comments={rowComments()} />
                    </Show>
                    <Show when={props.activeComposer === rowKey() && target()}>
                      <Composer
                        onCancel={props.onCancelComposer}
                        target={() => {
                          const t = target()!;
                          return props.targetForComposer(props.file.path, t.side, t.line);
                        }}
                        onSubmitted={props.onCommentSubmitted}
                      />
                    </Show>
                  </td>
                </tr>
              </Show>
            </>
          );
        }}
      </Index>
    </>
  );
}

function FileBlock(props: {
  file: PrFile;
  comments: readonly ReviewCommentDto[];
  canWrite: boolean;
  activeComposer: string | null;
  onOpenComposer: (key: string) => void;
  onCancelComposer: () => void;
  targetForComposer: (path: string, side: "LEFT" | "RIGHT", line: number) => InlineCommentTarget;
  onCommentSubmitted: (ack: { keepOpen: boolean }) => void;
}): JSX.Element {
  const [open, setOpen] = createSignal(true);
  const bodyId = createUniqueId();

  const visibleKeys = createMemo(() => {
    const set = new Set<string>();
    for (const hunk of props.file.hunks ?? []) {
      for (const l of hunk.lines) {
        if (l.newLineNumber != null && l.type !== "delete") set.add(commentKey(props.file.path, "RIGHT", l.newLineNumber));
        if (l.oldLineNumber != null && l.type !== "add") set.add(commentKey(props.file.path, "LEFT", l.oldLineNumber));
      }
    }
    return set;
  });

  const commentsByKey = createMemo(() => {
    const map = new Map<string, ReviewCommentDto[]>();
    for (const c of props.comments) {
      if (c.line == null) continue;
      const side = c.side === "LEFT" ? "LEFT" : "RIGHT";
      const key = commentKey(props.file.path, side, c.line);
      const arr = map.get(key) ?? [];
      arr.push(c);
      map.set(key, arr);
    }
    return map;
  });

  const offDiffComments = createMemo(() =>
    props.comments.filter((c) => {
      if (c.line == null) return true;
      const side = c.side === "LEFT" ? "LEFT" : "RIGHT";
      return !visibleKeys().has(commentKey(props.file.path, side, c.line));
    }),
  );

  return (
    <div class="overflow-hidden rounded-md border border-border">
      <button
        type="button"
        aria-expanded={open()}
        aria-controls={open() ? bodyId : undefined}
        class="tg-focus flex min-h-11 w-full items-center gap-2 bg-canvas-subtle px-3 py-2 text-left text-sm hover:bg-canvas-inset sm:min-h-0"
        onClick={() => setOpen((v) => !v)}
      >
        <Icons.ChevronDown class={cn("h-4 w-4 shrink-0 text-muted transition-transform", !open() && "-rotate-90")} />
        <span class={cn("shrink-0 text-xs font-semibold uppercase", STATUS_TONE[props.file.status] ?? "text-muted")}>
          {props.file.status[0]}
        </span>
        <span class="min-w-0 flex-1 truncate font-mono text-xs">
          <Show when={props.file.oldPath && props.file.oldPath !== props.file.path}>
            <span class="text-subtle">{props.file.oldPath} → </span>
          </Show>
          {props.file.path}
        </span>
        <Show when={props.comments.length > 0}>
          <span class="flex shrink-0 items-center gap-1 text-xs text-muted">
            <Icons.MessageSquare class="h-3.5 w-3.5" /> {props.comments.length}
          </span>
        </Show>
        <span class="shrink-0 font-mono text-xs">
          <span class="text-success">+{props.file.additions}</span>{" "}
          <span class="text-danger">-{props.file.deletions}</span>
        </span>
      </button>

      <Show when={open()}>
        <div id={bodyId}>
          <Show
            when={!props.file.binary}
            fallback={<div class="px-3 py-4 text-center text-xs text-muted">Binary file not shown.</div>}
          >
            <div class="overflow-x-auto bg-canvas">
              <table class="w-full border-collapse">
                <tbody>
                  <For each={props.file.hunks ?? []}>
                    {(hunk) => (
                      <LineRows
                        file={props.file}
                        hunk={hunk}
                        commentsByKey={commentsByKey()}
                        canWrite={props.canWrite}
                        activeComposer={props.activeComposer}
                        onOpenComposer={props.onOpenComposer}
                        onCancelComposer={props.onCancelComposer}
                        targetForComposer={props.targetForComposer}
                        onCommentSubmitted={props.onCommentSubmitted}
                      />
                    )}
                  </For>
                </tbody>
              </table>
              <Show when={(props.file.hunks?.length ?? 0) === 0}>
                <div class="px-3 py-4 text-center text-xs text-muted">No line changes to display.</div>
              </Show>
            </div>
          </Show>

          <Show when={offDiffComments().length > 0}>
            <div class="border-t border-border bg-canvas-subtle px-3 py-2">
              <div class="mb-2 text-xs font-semibold text-muted">Outdated / off-diff comments</div>
              <CommentThread comments={offDiffComments()} />
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}

export function PRFiles(props: {
  owner: string;
  repo: string;
  pr: PullRequestDto;
}): JSX.Element {
  const session = useSession();
  const reviewScope = useSubmissionScope(() => props.owner, () => props.repo);
  const reviewTarget = createMemo(() => {
    const current = reviewScope();
    return current && props.pr.issueId ? { owner: props.owner, repo: props.repo, number: props.pr.number,
      repositoryId: current.repositoryId, scope: current.recoveryScope, issueId: props.pr.issueId } : null;
  }, undefined, { equals: (a,b) => a?.owner === b?.owner && a?.repo === b?.repo && a?.number === b?.number
    && a?.repositoryId === b?.repositoryId && a?.scope === b?.scope && a?.issueId === b?.issueId });

  const toast = useToast();
  const [showReview, setShowReview] = createSignal(false);
  const [activeComposer, setActiveComposer] = createSignal<string | null>(null);

  const key = () => [props.owner, props.repo, props.pr.number] as const;
  const [diff, { refetch: refetchDiff }] = createResource(key, ([o, r, n]) => pullsApi.diff(o, r, n));
  const [comments, { refetch: refetchComments }] = createResource(key, ([o, r, n]) =>
    pullsApi.reviewComments(o, r, n),
  );

  const commentsForPath = (path: string): ReviewCommentDto[] =>
    (comments()?.items ?? []).filter((c) => c.path === path);

  const totals = createMemo(() => {
    const files = diff()?.files ?? [];
    return files.reduce(
      (acc, f) => ({ additions: acc.additions + f.additions, deletions: acc.deletions + f.deletions }),
      { additions: 0, deletions: 0 },
    );
  });

  const targetForComposer = (path: string, side: "LEFT" | "RIGHT", line: number): InlineCommentTarget => {
    const state = session.state();
    return { owner: props.owner, repo: props.repo, number: props.pr.number,
      path, side, line, commitSha: diff()?.headSha ?? "",
      scope: JSON.stringify([props.pr.issueId ?? null, state?.authenticated ? state.recoveryScope : null]) };
  };
  const commentSubmitted = ({ keepOpen }: { keepOpen: boolean }) => {
    if (!keepOpen) setActiveComposer(null);
    refetchComments();
    toast.success("Comment added.");
  };

  return (
    <ErrorBoundary
      fallback={(err, reset) => (
        <Banner
          tone="danger"
          title="Could not load the diff"
          action={
            <Button size="sm" onClick={() => { void refetchDiff(); void refetchComments(); reset(); }}>
              Retry
            </Button>
          }
        >
          {err instanceof ApiError ? err.message : "Unexpected error."}
        </Banner>
      )}
    >
      <Suspense fallback={<LoadingBlock label="Loading changes…" />}>
        <div class="space-y-3">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="flex items-center gap-3 text-sm text-muted">
              <span>{diff()?.files.length ?? 0} changed file(s)</span>
              <span class="font-mono text-success">+{totals().additions}</span>
              <span class="font-mono text-danger">-{totals().deletions}</span>
            </div>
            <Show when={session.authenticated()}>
              <Button variant="primary" size="sm" onClick={() => setShowReview((v) => !v)}>
                <Icons.Eye class="h-4 w-4" /> {showReview() ? "Hide review" : props.pr.state === "open" ? "Review changes" : "Recover saved review"}
              </Button>
            </Show>
          </div>

          <Show when={showReview()}>
            <Show when={reviewTarget()} keyed fallback={<Banner tone="warning">Safe review recovery is unavailable. Reload after the server has been updated.</Banner>}>
              {target => <ReviewForm
                owner={target.owner}
                repo={target.repo}
                number={target.number}
                headSha={diff()?.headSha ?? ""}
                allowNew={props.pr.state === "open"}
                recovery={{ storage: () => sessionStorage, scope: target.scope, repositoryId: target.repositoryId, issueId: target.issueId }}
                onSubmitted={({ keepOpen }) => { if (!keepOpen) setShowReview(false); }}
                onCancel={() => setShowReview(false)}
              />}
            </Show>
          </Show>

          <Show
            when={(diff()?.files.length ?? 0) > 0}
            fallback={
              <EmptyState
                icon={<Icons.File class="h-8 w-8" />}
                title="No file changes"
                description="This pull request does not change any files."
              />
            }
          >
            <div class="space-y-4">
              <For each={diff()?.files}>
                {(file) => (
                  <FileBlock
                    file={file}
                    comments={commentsForPath(file.path)}
                    canWrite={session.authenticated() && props.pr.state === "open" && /^[a-f0-9]{40}$/u.test(diff()?.headSha ?? "")}
                    activeComposer={activeComposer()}
                    onOpenComposer={(k) => setActiveComposer(k)}
                    onCancelComposer={() => setActiveComposer(null)}
                    targetForComposer={targetForComposer}
                    onCommentSubmitted={commentSubmitted}
                  />
                )}
              </For>
            </div>
          </Show>
        </div>
      </Suspense>
    </ErrorBoundary>
  );
}
