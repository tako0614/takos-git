import { createSignal, createUniqueId, For, Show, type JSX } from "solid-js";
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
  const body = () => commitBody(c().message);
  const hasBody = () => body().length > 0;
  const [expanded, setExpanded] = createSignal(false);
  const bodyId = createUniqueId();
  return (
    <div class="flex items-start gap-3 px-4 py-3">
      <Avatar name={c().author.name || c().author.email || "?"} size={32} class="mt-0.5" />
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-1.5">
          <A
            href={commitHref(props.owner, props.repo, c().sha)}
            class="tg-focus truncate rounded font-semibold text-fg hover:text-accent hover:underline"
            title={commitTitle(c().message)}
          >
            {commitTitle(c().message)}
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
        <Show when={hasBody() && expanded()}>
          <pre
            id={bodyId}
            class="mt-2 whitespace-pre-wrap break-words rounded-md border border-border bg-canvas-subtle px-3 py-2 font-mono text-xs text-muted"
          >
            {body()}
          </pre>
        </Show>
      </div>
      <div class="flex shrink-0 items-center gap-1">
        <A
          href={commitHref(props.owner, props.repo, c().sha)}
          class="tg-focus inline-flex min-h-11 items-center rounded-md border border-border bg-canvas-subtle px-2.5 py-1 font-mono text-xs text-muted hover:bg-canvas-inset hover:text-fg sm:min-h-0 sm:px-2"
          title="Browse this commit"
        >
          {c().sha.slice(0, 7)}
        </A>
        <CopyButton
          value={c().sha}
          label="Commit SHA"
          title="Copy full SHA"
          class="h-11 w-11 hover:bg-canvas-subtle sm:h-7 sm:w-7"
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
