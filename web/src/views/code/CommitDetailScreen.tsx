import { createMemo, createResource, For, Show, Suspense, type JSX } from "solid-js";
import { A } from "@solidjs/router";
import { reposApi } from "../../api/repos.ts";
import { ApiError } from "../../api/client.ts";
import type { FileDiff } from "../../api/types.ts";
import {
  Avatar,
  Banner,
  Box,
  DiffView,
  EmptyState,
  Icons,
  LoadingBlock,
  RelativeTime,
  Sha,
} from "../../ui/index.ts";
import { CopyButton } from "./CopyButton.tsx";
import { commitBody, commitHref, commitTitle, treeHref } from "./helpers.ts";

/** Adds/dels/file totals for a diff. */
export function diffTotals(files: readonly FileDiff[]): { additions: number; deletions: number; files: number } {
  let additions = 0;
  let deletions = 0;
  for (const f of files) {
    additions += f.additions;
    deletions += f.deletions;
  }
  return { additions, deletions, files: files.length };
}

/** A "N files changed  +A −D" summary strip shared by commit + compare views. */
export function DiffSummary(props: { files: readonly FileDiff[] }): JSX.Element {
  const totals = createMemo(() => diffTotals(props.files));
  return (
    <div class="flex items-center gap-3 text-sm text-muted">
      <span>
        <span class="font-semibold text-fg">{totals().files}</span>{" "}
        {totals().files === 1 ? "file" : "files"} changed
      </span>
      <span class="font-mono text-success">+{totals().additions}</span>
      <span class="font-mono text-danger">−{totals().deletions}</span>
    </div>
  );
}

/**
 * Single-commit detail: message, authorship, parents, and the per-file diff vs
 * the first parent. Serves `/:owner/:repo/commit/:sha`.
 */
export function CommitDetailScreen(props: { owner: string; repo: string; sha: string }): JSX.Element {
  const [result] = createResource(
    () => [props.owner, props.repo, props.sha] as const,
    async ([o, r, sha]) => {
      try {
        return { data: await reposApi.commit(o, r, sha), error: null as ApiError | null };
      } catch (err) {
        return { data: null, error: err instanceof ApiError ? err : new ApiError(500, "unknown", "Failed to load commit") };
      }
    },
  );

  return (
    <Suspense fallback={<LoadingBlock label="Loading commit…" />}>
      <Show when={result()} keyed fallback={<LoadingBlock label="Loading commit…" />}>
        {(res) => (
          <Show
            when={res.data}
            fallback={
              <Show
                when={res.error?.isNotFound}
                fallback={
                  <Banner tone="danger" title="Could not load commit">
                    {res.error?.message}
                  </Banner>
                }
              >
                <EmptyState
                  icon={<Icons.GitCommit class="h-8 w-8" />}
                  title="Commit not found"
                  description={<code class="font-mono">{props.sha}</code>}
                />
              </Show>
            }
          >
            {(data) => {
              const commit = () => data().commit;
              const body = () => commitBody(commit().message);
              return (
                <div class="space-y-4">
                  <Box>
                    <div class="border-b border-border px-4 py-3">
                      <h1 class="text-lg font-semibold text-fg">{commitTitle(commit().message)}</h1>
                      <Show when={body()}>
                        <pre class="mt-2 whitespace-pre-wrap break-words font-mono text-sm text-muted">{body()}</pre>
                      </Show>
                    </div>
                    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm">
                      <Avatar name={commit().author.name || commit().author.email || "?"} size={24} />
                      <span class="font-semibold text-fg">{commit().author.name || commit().author.email}</span>
                      <span class="text-muted">
                        committed <RelativeTime epochMs={commit().author.date} />
                      </span>
                      <div class="ml-auto flex items-center gap-2">
                        <span class="text-xs text-muted">commit</span>
                        <Sha value={commit().sha} />
                        <CopyButton value={commit().sha} label="Commit SHA" class="h-6 w-6 hover:bg-canvas-subtle" />
                        <A
                          href={treeHref(props.owner, props.repo, commit().sha)}
                          class="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-canvas-subtle px-2.5 text-xs text-fg hover:bg-canvas-inset"
                        >
                          <Icons.Code class="h-3.5 w-3.5 text-muted" /> Browse files
                        </A>
                      </div>
                    </div>
                    <Show when={commit().parents.length > 0}>
                      <div class="flex flex-wrap items-center gap-2 border-t border-border bg-canvas-subtle px-4 py-2 text-xs text-muted">
                        <span>{commit().parents.length === 1 ? "Parent" : "Parents"}:</span>
                        <For each={commit().parents}>
                          {(parent) => (
                            <A
                              href={commitHref(props.owner, props.repo, parent)}
                              class="rounded bg-neutral-muted px-1.5 py-0.5 font-mono text-accent hover:underline"
                            >
                              {parent.slice(0, 7)}
                            </A>
                          )}
                        </For>
                      </div>
                    </Show>
                  </Box>

                  <div class="flex items-center justify-between">
                    <DiffSummary files={data().diff.files} />
                    <Show when={data().diff.base}>
                      {(base) => (
                        <span class="text-xs text-muted">
                          vs <Sha value={base()} />
                        </span>
                      )}
                    </Show>
                  </div>
                  <DiffView files={data().diff.files} />
                </div>
              );
            }}
          </Show>
        )}
      </Show>
    </Suspense>
  );
}
