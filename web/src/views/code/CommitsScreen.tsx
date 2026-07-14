import { createResource, createSignal, Show, Suspense, type JSX } from "solid-js";
import { A, useNavigate, useSearchParams } from "@solidjs/router";
import { reposApi } from "../../api/repos.ts";
import {
  Banner,
  Button,
  EmptyState,
  Icons,
  LoadingBlock,
} from "../../ui/index.ts";
import { RefSelector } from "./RefSelector.tsx";
import { CommitRows } from "./CommitRows.tsx";
import { blobHref, commitsHref, treeHref } from "./helpers.ts";

const PAGE = 30;

/**
 * Commit history for a ref, optionally filtered to a single file via `?path=`
 * (the blob "History" link). Groups commits by day; "Load more" widens the
 * server limit (the commits route is limit- rather than cursor-paged).
 */
export function CommitsScreen(props: {
  owner: string;
  repo: string;
  refName: string;
  defaultBranch: string;
}): JSX.Element {
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const path = () => (typeof search.path === "string" ? search.path : "");
  const [limit, setLimit] = createSignal(PAGE);

  const pathQuery = () => (path() ? `?path=${encodeURIComponent(path())}` : "");

  const [result] = createResource(
    () => [props.owner, props.repo, props.refName, path(), limit()] as const,
    async ([o, r, ref, p, lim]) => {
      try {
        return { data: await reposApi.commits(o, r, { ref, path: p || undefined, limit: lim }), error: null as Error | null };
      } catch (err) {
        return { data: null, error: err instanceof Error ? err : new Error("Failed to load commits") };
      }
    },
  );

  const pickRef = (ref: string) =>
    navigate(`${commitsHref(props.owner, props.repo, ref)}${pathQuery()}`);

  return (
    <div class="space-y-4">
      <div class="flex flex-wrap items-center gap-2">
        <RefSelector
          owner={props.owner}
          repo={props.repo}
          currentRef={props.refName}
          defaultBranch={props.defaultBranch}
          onPick={pickRef}
        />
        <h2 class="text-sm font-semibold text-fg">Commits</h2>
        <Show when={path()}>
          <span class="inline-flex items-center gap-1.5 rounded-full border border-border bg-canvas-subtle px-2.5 py-0.5 text-xs text-muted">
            <Icons.FileText class="h-3.5 w-3.5" />
            <A href={blobHref(props.owner, props.repo, props.refName, path())} class="font-mono hover:text-accent hover:underline">
              {path()}
            </A>
            <A
              href={commitsHref(props.owner, props.repo, props.refName)}
              aria-label="Clear file filter"
              class="text-subtle hover:text-fg"
            >
              <Icons.X class="h-3 w-3" />
            </A>
          </span>
        </Show>
      </div>

      <Suspense fallback={<LoadingBlock label="Loading commits…" />}>
        <Show when={result()} keyed fallback={<LoadingBlock label="Loading commits…" />}>
          {(res) => (
            <Show
              when={res.data}
              fallback={
                <Banner tone="danger" title="Could not load commits">
                  {res.error?.message ?? "Unknown error"}
                </Banner>
              }
            >
              {(data) => (
                <Show
                  when={data().commits.length > 0}
                  fallback={
                    <EmptyState
                      icon={<Icons.GitCommit class="h-8 w-8" />}
                      title="No commits found"
                      description={
                        path() ? (
                          <>No commits touch <code class="font-mono">{path()}</code> on this ref.</>
                        ) : (
                          <>This ref has no commit history yet.</>
                        )
                      }
                      action={
                        <A href={treeHref(props.owner, props.repo, props.refName)} class="text-accent hover:underline">
                          Browse files
                        </A>
                      }
                    />
                  }
                >
                  <CommitRows owner={props.owner} repo={props.repo} commits={data().commits} />
                  <Show when={data().truncated}>
                    <div class="flex justify-center">
                      <Button
                        variant="default"
                        disabled={result.loading}
                        onClick={() => setLimit((n) => n + PAGE)}
                      >
                        <Show when={result.loading} fallback={<>Load more commits</>}>
                          Loading…
                        </Show>
                      </Button>
                    </div>
                  </Show>
                </Show>
              )}
            </Show>
          )}
        </Show>
      </Suspense>
    </div>
  );
}
