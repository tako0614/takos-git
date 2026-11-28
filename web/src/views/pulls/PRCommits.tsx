/**
 * Commits tab: the commits contained in the PR (head ahead of base), newest at
 * the bottom as GitHub lists them. Each row links its sha to the commit view.
 */
import {
  createResource,
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

function CommitRow(props: { owner: string; repo: string; commit: CommitSummary }): JSX.Element {
  const title = () => props.commit.message.split("\n")[0];
  const authorLabel = () => props.commit.author.name || props.commit.author.email || "?";
  return (
    <div class="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0">
      <Icons.GitCommit class="h-4 w-4 shrink-0 text-muted" />
      <Avatar name={authorLabel()} size={20} />
      <div class="min-w-0 flex-1">
        <A
          href={`/${props.owner}/${props.repo}/commit/${props.commit.sha}`}
          class="tg-focus block truncate rounded text-sm font-medium text-fg hover:text-accent hover:underline"
        >
          {title()}
        </A>
        <div class="text-xs text-muted">
          <span class="font-medium text-fg">{authorLabel()}</span>{" "}
          committed <RelativeTime epochMs={props.commit.committer.date} />
        </div>
      </div>
      <div class="flex shrink-0 items-center gap-1">
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
