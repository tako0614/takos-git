import { createMemo, createResource, Show, Suspense, type JSX } from "solid-js";
import { reposApi } from "../../api/repos.ts";
import { ApiError } from "../../api/client.ts";
import type { CompareResponse } from "../../api/types.ts";
import {
  Banner,
  Box,
  DiffView,
  EmptyState,
  Icons,
  LoadingBlock,
  Sha,
} from "../../ui/index.ts";
import { cn } from "../../lib/cn.ts";
import { CommitRows } from "./CommitRows.tsx";
import { DiffSummary } from "./CommitDetailScreen.tsx";

/** Split a `base...head` / `base..head` spec into its two endpoints. */
function parseSpec(spec: string): { base: string; head: string } {
  const decoded = decodeURIComponent(spec);
  const sep = decoded.includes("...") ? "..." : "..";
  const idx = decoded.indexOf(sep);
  if (idx < 0) return { base: decoded, head: "" };
  return { base: decoded.slice(0, idx), head: decoded.slice(idx + sep.length) };
}

const STATUS_LABEL: Record<CompareResponse["status"], { text: string; tone: string }> = {
  identical: { text: "These refs are identical", tone: "text-muted" },
  ahead: { text: "ahead", tone: "text-success" },
  behind: { text: "behind", tone: "text-attention" },
  diverged: { text: "diverged", tone: "text-danger" },
};

function StatusIcon(props: { status: CompareResponse["status"] }): JSX.Element {
  return (
    <Show when={props.status === "diverged"} fallback={<Icons.GitCommit class="h-4 w-4" />}>
      <Icons.GitMerge class="h-4 w-4" />
    </Show>
  );
}

/**
 * Two-ref comparison: ahead/behind counts, the commit range, and the aggregate
 * diff. Serves `/:owner/:repo/compare/*spec` (`base...head`).
 */
export function CompareScreen(props: { owner: string; repo: string; spec: string }): JSX.Element {
  const refs = createMemo(() => parseSpec(props.spec));

  const [result] = createResource(
    () => [props.owner, props.repo, props.spec] as const,
    async ([o, r, spec]) => {
      try {
        return { data: await reposApi.compare(o, r, spec), error: null as ApiError | null };
      } catch (err) {
        return { data: null, error: err instanceof ApiError ? err : new ApiError(500, "unknown", "Failed to compare") };
      }
    },
  );

  return (
    <div class="space-y-4">
      <div class="flex flex-wrap items-center gap-2 text-sm">
        <Icons.GitMerge class="h-5 w-5 text-muted" />
        <span class="font-semibold text-fg">Comparing changes</span>
        <span class="inline-flex items-center gap-1.5">
          <span class="rounded-md border border-border bg-canvas-subtle px-2 py-0.5 font-mono text-xs">
            {refs().base || "base"}
          </span>
          <Icons.ArrowLeft class="h-4 w-4 rotate-180 text-subtle" />
          <span class="rounded-md border border-border bg-canvas-subtle px-2 py-0.5 font-mono text-xs">
            {refs().head || "head"}
          </span>
        </span>
      </div>

      <Suspense fallback={<LoadingBlock label="Comparing…" />}>
        <Show
          when={result()}
          keyed
          fallback={<LoadingBlock label="Comparing…" />}
        >
          {(res) => (
            <Show
              when={res.data}
              fallback={
                <Banner tone="danger" title="Could not compare these refs">
                  {res.error?.message ?? "One of the refs may not exist."}
                </Banner>
              }
            >
              {(data) => {
                const status = () => STATUS_LABEL[data().status];
                return (
                  <div class="space-y-4">
                    <Box>
                      <div class="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                        <span class={cn("inline-flex items-center gap-1.5 font-medium", status().tone)}>
                          <StatusIcon status={data().status} />
                          <Show when={data().status === "identical"} fallback={<span>Refs {status().text}</span>}>
                            {status().text}
                          </Show>
                        </span>
                        <Show when={data().status !== "identical"}>
                          <span class="text-muted">
                            <span class="font-semibold text-success">{data().ahead}</span> ahead ·{" "}
                            <span class="font-semibold text-attention">{data().behind}</span> behind
                          </span>
                        </Show>
                        <Show when={data().mergeBaseSha}>
                          {(base) => (
                            <span class="ml-auto flex items-center gap-1.5 text-xs text-muted">
                              merge base <Sha value={base()} />
                            </span>
                          )}
                        </Show>
                      </div>
                    </Box>

                    <Show
                      when={data().commits.length > 0}
                      fallback={
                        <EmptyState
                          icon={<Icons.GitCommit class="h-8 w-8" />}
                          title="Nothing to compare"
                          description="There are no commits between these refs."
                        />
                      }
                    >
                      <div>
                        <h2 class="mb-2 text-sm font-semibold text-fg">
                          {data().commits.length} {data().commits.length === 1 ? "commit" : "commits"}
                        </h2>
                        <CommitRows owner={props.owner} repo={props.repo} commits={data().commits} />
                      </div>

                      <div class="flex items-center justify-between pt-2">
                        <DiffSummary files={data().diff.files} />
                      </div>
                      <DiffView files={data().diff.files} />
                    </Show>
                  </div>
                );
              }}
            </Show>
          )}
        </Show>
      </Suspense>
    </div>
  );
}
