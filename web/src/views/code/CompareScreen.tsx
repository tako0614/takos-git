import { createMemo, createResource, Show, Suspense, type JSX } from "solid-js";
import { A, useNavigate } from "@solidjs/router";
import { compareRouteSpec } from "./compare-route.ts";
import { formatCompareSpec, parseCompareSpec } from "./compare-spec.ts";
import { commitHref, compareHref, repoBase } from "./helpers.ts";
import { reposApi } from "../../api/repos.ts";
import { ApiError } from "../../api/client.ts";
import type { CompareResponse } from "../../api/types.ts";
import { useSession } from "../../store/session.tsx";
import {
  Banner,
  Box,
  Button,
  ButtonLink,
  DiffView,
  EmptyState,
  Icons,
  LoadingBlock,
  Sha,
} from "../../ui/index.ts";
import { cn } from "../../lib/cn.ts";
import { CommitRows } from "./CommitRows.tsx";
import { DiffSummary } from "./CommitDetailScreen.tsx";
import { RefSelector } from "./RefSelector.tsx";

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
 * Two-ref comparison: interactive base/head branch/tag selectors, ahead/behind
 * counts, commit range, aggregate diff, and a handoff to open a pull request.
 * Serves `/:owner/:repo/compare/*spec` (`base...head`).
 */
export function CompareScreen(props: {
  owner: string;
  repo: string;
  spec: string;
  defaultBranch?: string;
}): JSX.Element {
  const navigate = useNavigate();
  const session = useSession();
  const refs = createMemo(() => parseCompareSpec(props.spec));
  const effectiveBase = () => refs().base || props.defaultBranch || "";
  const effectiveHead = () => refs().head;
  const hasCompleteSpec = () => Boolean(refs().base && refs().head);

  const navigateCompare = (nextBase: string, nextHead: string) => {
    const b = nextBase.trim() || props.defaultBranch || "main";
    const h = nextHead.trim() || b;
    navigate(compareHref(props.owner, props.repo, formatCompareSpec(b, h, refs().separator)));
  };

  const swapRefs = () => {
    if (!effectiveBase() || !effectiveHead()) return;
    navigateCompare(effectiveHead(), effectiveBase());
  };

  const openPullHref = () => {
    const params = new URLSearchParams({
      new: "1",
      base: refs().base,
      head: refs().head,
    });
    return `${repoBase(props.owner, props.repo)}/pulls?${params.toString()}`;
  };

  const [result, { refetch }] = createResource(
    () => (hasCompleteSpec() ? ([props.owner, props.repo, props.spec] as const) : false),
    async ([o, r, spec]) => {
      try {
        return { data: await reposApi.compare(o, r, compareRouteSpec(spec)), error: null as ApiError | null };
      } catch (err) {
        return { data: null, error: err instanceof ApiError ? err : new ApiError(500, "unknown", "Failed to compare") };
      }
    },
  );

  return (
    <div class="space-y-4">
      <div class="space-y-3">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex items-center gap-2">
            <Icons.GitMerge class="h-5 w-5 text-muted" />
            <h1 class="text-base font-semibold text-fg">Comparing changes</h1>
          </div>
          <Show
            when={
              session.authenticated() &&
              hasCompleteSpec() &&
              refs().base !== refs().head &&
              (result()?.data?.commits.length ?? 0) > 0
            }
          >
            <ButtonLink as={A} href={openPullHref()} variant="primary" size="sm">
              <Icons.GitPullRequest class="h-4 w-4" /> Open pull request
            </ButtonLink>
          </Show>
        </div>

        <div
          class="flex flex-wrap items-center gap-2 rounded-md border border-border bg-canvas-subtle p-2.5 text-sm"
          role="group"
          aria-label="Choose refs to compare"
        >
          <RefSelector
            owner={props.owner}
            repo={props.repo}
            currentRef={effectiveBase()}
            defaultBranch={props.defaultBranch}
            size="sm"
            triggerPrefix="base:"
            triggerLabel={`Base ref: ${effectiveBase() || "none"}`}
            dialogLabel="Choose a base branch or tag"
            heading="Choose a base ref"
            placeholder="base"
            onPick={(ref) => navigateCompare(ref, effectiveHead() || ref)}
          />
          <button
            type="button"
            disabled={!effectiveBase() || !effectiveHead() || effectiveBase() === effectiveHead()}
            onClick={swapRefs}
            title="Swap base and compare refs"
            aria-label="Swap base and compare refs"
            class="tg-focus inline-flex h-11 w-11 items-center justify-center rounded-md border border-border bg-canvas text-muted hover:bg-canvas-inset hover:text-fg disabled:cursor-not-allowed disabled:opacity-50 sm:h-7 sm:w-7"
          >
            <Icons.ArrowLeft class="h-3.5 w-3.5" />
          </button>
          <RefSelector
            owner={props.owner}
            repo={props.repo}
            currentRef={effectiveHead()}
            defaultBranch={props.defaultBranch}
            size="sm"
            triggerPrefix="compare:"
            triggerLabel={`Compare ref: ${effectiveHead() || "none"}`}
            dialogLabel="Choose a compare branch or tag"
            heading="Choose a compare ref"
            placeholder="choose ref"
            onPick={(ref) => navigateCompare(effectiveBase(), ref)}
          />
        </div>
      </div>

      <Show
        when={hasCompleteSpec()}
        fallback={
          <EmptyState
            icon={<Icons.GitMerge class="h-8 w-8" />}
            title="Choose two refs to compare"
            description="Pick a base and compare branch or tag above to inspect commits and file differences."
          />
        }
      >
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
                  <Banner
                    tone="danger"
                    title="Could not compare these refs"
                    action={
                      <Button size="sm" disabled={result.loading} onClick={() => void refetch()}>
                        Retry
                      </Button>
                    }
                  >
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
                                merge base{" "}
                                <A
                                  href={commitHref(props.owner, props.repo, base())}
                                  class="tg-focus inline-flex min-h-11 items-center rounded hover:opacity-80 sm:min-h-0"
                                  title={`View merge base commit ${base().slice(0, 7)}`}
                                >
                                  <Sha value={base()} />
                                </A>
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
      </Show>
    </div>
  );
}
