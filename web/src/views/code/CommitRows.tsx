import { For, Show, type JSX } from "solid-js";
import { A } from "@solidjs/router";
import type { CommitSummary } from "../../api/types.ts";
import { Avatar, Icons, RelativeTime } from "../../ui/index.ts";
import { CopyButton } from "./CopyButton.tsx";
import { commitBody, commitHref, commitTitle, groupByDay } from "./helpers.ts";

const PATH_STATUS_TONE: Record<string, string> = {
  added: "text-success",
  deleted: "text-danger",
  modified: "text-attention",
};

function CommitRow(props: { owner: string; repo: string; commit: CommitSummary }): JSX.Element {
  const c = () => props.commit;
  const hasBody = () => commitBody(c().message).length > 0;
  return (
    <div class="flex items-start gap-3 px-4 py-3">
      <Avatar name={c().author.name || c().author.email || "?"} size={32} class="mt-0.5" />
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <A
            href={commitHref(props.owner, props.repo, c().sha)}
            class="truncate font-semibold text-fg hover:text-accent hover:underline"
            title={commitTitle(c().message)}
          >
            {commitTitle(c().message)}
          </A>
          <Show when={hasBody()}>
            <span
              class="rounded border border-border px-1.5 text-xs leading-4 text-muted"
              title={commitBody(c().message)}
            >
              …
            </span>
          </Show>
          <Show when={c().pathStatus}>
            {(status) => (
              <span class={`shrink-0 text-xs font-semibold uppercase ${PATH_STATUS_TONE[status()] ?? "text-muted"}`}>
                {status()}
              </span>
            )}
          </Show>
        </div>
        <div class="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted">
          <span class="font-medium text-fg/80">{c().author.name || c().author.email}</span>
          <span>committed</span>
          <RelativeTime epochMs={c().author.date} />
        </div>
      </div>
      <div class="flex shrink-0 items-center gap-1">
        <A
          href={commitHref(props.owner, props.repo, c().sha)}
          class="rounded-md border border-border bg-canvas-subtle px-2 py-1 font-mono text-xs text-muted hover:bg-canvas-inset hover:text-fg"
          title="Browse this commit"
        >
          {c().sha.slice(0, 7)}
        </A>
        <CopyButton
          value={c().sha}
          label="Commit SHA"
          title="Copy full SHA"
          class="h-7 w-7 hover:bg-canvas-subtle"
        />
      </div>
    </div>
  );
}

/** A GitHub-style day-grouped commit list. */
export function CommitRows(props: {
  owner: string;
  repo: string;
  commits: readonly CommitSummary[];
}): JSX.Element {
  return (
    <div class="overflow-hidden rounded-md border border-border">
      <For each={groupByDay(props.commits)}>
        {([day, dayCommits]) => (
          <div>
            <div class="flex items-center gap-2 border-b border-border bg-canvas-subtle px-4 py-2 text-xs font-medium text-muted">
              <Icons.GitCommit class="h-3.5 w-3.5" />
              Commits on {day}
            </div>
            <div class="divide-y divide-border">
              <For each={dayCommits}>
                {(commit) => <CommitRow owner={props.owner} repo={props.repo} commit={commit} />}
              </For>
            </div>
          </div>
        )}
      </For>
    </div>
  );
}
