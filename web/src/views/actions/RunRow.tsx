import { Show, type JSX } from "solid-js";
import { Avatar, Icons, Link, RelativeTime, Sha } from "../../ui/index.ts";
import { RunStatusGlyph } from "./StatusBadge.tsx";
import { formatDuration, shortRef } from "./helpers.tsx";
import type { WorkflowRunDto } from "../../api/types.ts";

/** One row in the runs list — GitHub's workflow-run line item. */
export function RunRow(props: {
  owner: string;
  repo: string;
  run: WorkflowRunDto;
}): JSX.Element {
  const run = () => props.run;
  const title = () => run().workflowPath.split("/").pop() ?? run().workflowPath;
  const href = () => `/${props.owner}/${props.repo}/actions/runs/${run().id}`;
  const duration = () => formatDuration(run().startedAt, run().completedAt);

  return (
    <div class="flex items-start gap-3 px-4 py-3">
      <span class="mt-0.5 shrink-0">
        <RunStatusGlyph status={run().status} conclusion={run().conclusion} />
      </span>
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Link href={href()} class="font-semibold text-fg hover:text-accent">
            {title()}
          </Link>
          <span class="text-xs text-muted">#{run().runNumber}</span>
          <Show when={run().runAttempt > 1}>
            <span class="text-xs text-muted">(attempt {run().runAttempt})</span>
          </Show>
        </div>
        <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <span class="inline-flex items-center gap-1">
            <Icons.Zap class="h-3 w-3" /> {run().event}
          </span>
          <Show when={shortRef(run().ref)}>
            <span class="inline-flex items-center gap-1">
              <Icons.GitBranch class="h-3 w-3" /> {shortRef(run().ref)}
            </span>
          </Show>
          <Show when={run().sha}>
            {(sha) => (
              <span class="inline-flex items-center gap-1">
                <Icons.GitCommit class="h-3 w-3" /> <Sha value={sha()} />
              </span>
            )}
          </Show>
          <Show when={run().actor}>
            {(actor) => (
              <span class="inline-flex items-center gap-1">
                <Avatar
                  name={actor().displayName ?? actor().subject}
                  src={actor().avatarUrl}
                  size={16}
                />
                {actor().displayName ?? actor().subject}
              </span>
            )}
          </Show>
        </div>
      </div>
      <div class="hidden shrink-0 flex-col items-end gap-1 text-xs text-muted sm:flex">
        <RelativeTime epochMs={run().createdAt} />
        <Show when={duration()}>
          <span class="inline-flex items-center gap-1">
            <Icons.Clock class="h-3 w-3" /> {duration()}
          </span>
        </Show>
      </div>
    </div>
  );
}
