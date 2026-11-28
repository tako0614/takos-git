/**
 * Commits tab: the commits contained in the PR (head ahead of base), newest at
 * the bottom as GitHub lists them. Each row links its sha to the commit view
 * and lets the user expand multi-line commit descriptions inline.
 */
import {
  createResource,
  createSignal,
  createUniqueId,
  ErrorBoundary,
  For,
  Show,
  Suspense,
  type JSX,
} from "solid-js";
import { A } from "@solidjs/router";
import { pullsApi } from "../../api/pulls.ts";
import { ApiError } from "../../api/client.ts";
import type { CommitSummary } from "../../api/types.ts";
import {
  Avatar,
  Banner,
  Box,
  Button,
  EmptyState,
  Icons,
  LoadingBlock,
  RelativeTime,
} from "../../ui/index.ts";
import { CopyButton } from "../code/CopyButton.tsx";
import { commitBody, commitTitle } from "../code/helpers.ts";

function CommitRow(props: { owner: string; repo: string; commit: CommitSummary }): JSX.Element {
  const title = () => commitTitle(props.commit.message);
  const body = () => commitBody(props.commit.message);
  const hasBody = () => body().length > 0;
  const [expanded, setExpanded] = createSignal(false);
  const bodyId = createUniqueId();
  const authorLabel = () => props.commit.author.name || props.commit.author.email || "?";
  return (
    <div class="flex flex-col gap-2 border-b border-border px-4 py-3 last:border-b-0 sm:flex-row sm:items-start sm:gap-3">
      <div class="flex min-w-0 flex-1 items-start gap-3">
        <Icons.GitCommit class="mt-1 h-4 w-4 shrink-0 text-muted" />
        <Avatar name={authorLabel()} size={20} class="mt-0.5 shrink-0" />
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-1.5">
            <A
              href={`/${props.owner}/${props.repo}/commit/${props.commit.sha}`}
              class="tg-focus inline-flex min-h-11 max-w-full items-center truncate rounded text-sm font-medium text-fg hover:text-accent hover:underline sm:min-h-0"
              title={title()}
            >
              <span class="truncate">{title()}</span>
            </A>
            <Show when={hasBody()}>
              <button
                type="button"
                aria-expanded={expanded()}
                aria-controls={expanded() ? bodyId : undefined}
                aria-label={expanded() ? "Hide commit description" : "Show commit description"}
                title={expanded() ? "Hide commit description" : "Show commit description"}
                onClick={() => setExpanded((v) => !v)}
                class="tg-focus inline-flex h-11 min-w-11 shrink-0 items-center justify-center rounded border border-border bg-canvas-subtle px-1.5 text-xs font-semibold leading-4 text-muted hover:bg-canvas-inset hover:text-fg sm:h-5 sm:min-w-0"
              >
                …
              </button>
            </Show>
          </div>
          <div class="text-xs text-muted">
            <span class="font-medium text-fg">{authorLabel()}</span>{" "}
            committed <RelativeTime epochMs={props.commit.committer.date} />
          </div>
          <Show when={hasBody() && expanded()}>
            <pre
              id={bodyId}
              class="mt-2 whitespace-pre-wrap break-words rounded-md border border-border bg-canvas-subtle px-3 py-2 font-mono text-xs text-muted"
            >
              {body()}
            </pre>
          </Show>
        </div>
      </div>
      <div class="flex shrink-0 items-center gap-1 pl-14 sm:pl-0">
        <A
          href={`/${props.owner}/${props.repo}/commit/${props.commit.sha}`}
          class="tg-focus inline-flex min-h-11 items-center rounded-md border border-border bg-canvas-subtle px-2.5 py-1 font-mono text-xs text-fg hover:bg-canvas-inset sm:min-h-0 sm:px-2"
          title={`View commit ${props.commit.sha.slice(0, 7)}`}
        >
          {props.commit.sha.slice(0, 7)}
        </A>
        <CopyButton
          value={props.commit.sha}
          label="Commit SHA"
          title="Copy full SHA"
          class="h-11 w-11 hover:bg-canvas-subtle sm:h-7 sm:w-7"
        />
      </div>
    </div>
  );
}

export function PRCommits(props: { owner: string; repo: string; number: number }): JSX.Element {
  const [data, { refetch }] = createResource(
    () => [props.owner, props.repo, props.number] as const,
    ([o, r, n]) => pullsApi.commits(o, r, n),
  );

  return (
    <ErrorBoundary
      fallback={(err, reset) => (
        <Banner
          tone="danger"
          title="Could not load commits"
          action={
            <Button size="sm" onClick={() => { void refetch(); reset(); }}>
              Retry
            </Button>
          }
        >
          {err instanceof ApiError ? err.message : "Unexpected error."}
        </Banner>
      )}
    >
      <Suspense fallback={<LoadingBlock label="Loading commits…" />}>
        <Show
          when={(data()?.commits.length ?? 0) > 0}
          fallback={
            <EmptyState
              icon={<Icons.GitCommit class="h-8 w-8" />}
              title="No commits"
              description="This pull request does not contain any commits ahead of its base branch."
            />
          }
        >
          <Box>
            <For each={data()?.commits}>
              {(commit) => <CommitRow owner={props.owner} repo={props.repo} commit={commit} />}
            </For>
          </Box>
        </Show>
      </Suspense>
    </ErrorBoundary>
  );
}
