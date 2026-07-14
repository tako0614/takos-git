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
  EmptyState,
  Icons,
  LoadingBlock,
  RelativeTime,
  Sha,
} from "../../ui/index.ts";

function CommitRow(props: { owner: string; repo: string; commit: CommitSummary }): JSX.Element {
  const title = () => props.commit.message.split("\n")[0];
  return (
    <div class="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0">
      <Icons.GitCommit class="h-4 w-4 shrink-0 text-muted" />
      <Avatar name={props.commit.author.name} size={20} />
      <div class="min-w-0 flex-1">
        <A
          href={`/${props.owner}/${props.repo}/commit/${props.commit.sha}`}
          class="block truncate text-sm font-medium text-fg hover:text-accent hover:underline"
        >
          {title()}
        </A>
        <div class="text-xs text-muted">
          <span class="font-medium text-fg">{props.commit.author.name}</span>{" "}
          committed <RelativeTime epochMs={props.commit.committer.date} />
        </div>
      </div>
      <A
        href={`/${props.owner}/${props.repo}/commit/${props.commit.sha}`}
        class="shrink-0 hover:opacity-80"
        title="Browse the repository at this point"
      >
        <Sha value={props.commit.sha} />
      </A>
    </div>
  );
}

export function PRCommits(props: { owner: string; repo: string; number: number }): JSX.Element {
  const [data] = createResource(
    () => [props.owner, props.repo, props.number] as const,
    ([o, r, n]) => pullsApi.commits(o, r, n),
  );

  return (
    <ErrorBoundary
      fallback={(err) => (
        <Banner tone="danger" title="Could not load commits">
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
