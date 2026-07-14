import { Index, Show, type JSX } from "solid-js";
import { Banner, Box, EmptyState, Icons, LoadingBlock } from "../../ui/index.ts";
import { RunRow } from "./RunRow.tsx";
import type { WorkflowRunDto } from "../../api/types.ts";

/** Presentational runs list: loading / error / empty / rows. */
export function RunsList(props: {
  owner: string;
  repo: string;
  runs: readonly WorkflowRunDto[];
  loading: boolean;
  error: string | null;
  filtered: boolean;
}): JSX.Element {
  return (
    <Show
      when={!props.error}
      fallback={<Banner tone="danger" title="Couldn't load workflow runs">{props.error}</Banner>}
    >
      <Show
        when={!props.loading}
        fallback={<LoadingBlock label="Loading workflow runs…" />}
      >
        <Show
          when={props.runs.length > 0}
          fallback={
            <EmptyState
              icon={<Icons.Play class="h-8 w-8" />}
              title={props.filtered ? "No runs match these filters" : "No workflow runs yet"}
              description={
                props.filtered
                  ? "Try clearing the filters to see all runs."
                  : "Runs appear here once a workflow is triggered by a push, pull request, or manual dispatch."
              }
            />
          }
        >
          <Box>
            <div class="divide-y divide-border">
              <Index each={props.runs}>
                {(run) => <RunRow owner={props.owner} repo={props.repo} run={run()} />}
              </Index>
            </div>
          </Box>
        </Show>
      </Show>
    </Show>
  );
}
