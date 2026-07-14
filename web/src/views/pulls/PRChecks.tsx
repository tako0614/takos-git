/**
 * Checks tab: the combined commit status + check runs for the PR head sha,
 * pulled from `checksApi`. Shows an overall roll-up banner and per-item rows
 * (context/name, state, description, and any details link the producer set).
 */
import {
  createResource,
  ErrorBoundary,
  For,
  Show,
  Suspense,
  type JSX,
} from "solid-js";
import { checksApi } from "../../api/checks.ts";
import { ApiError } from "../../api/client.ts";
import type {
  CheckRunDto,
  CombinedStatusDto,
  CommitStatusDto,
} from "../../api/types.ts";
import {
  Banner,
  Box,
  EmptyState,
  ExternalLink,
  Icons,
  LoadingBlock,
  Sha,
  type BannerTone,
} from "../../ui/index.ts";

type Rollup = "success" | "failure" | "pending" | "neutral";

function StateIcon(props: { rollup: Rollup }): JSX.Element {
  switch (props.rollup) {
    case "success":
      return <Icons.Check class="h-4 w-4 text-success" />;
    case "failure":
      return <Icons.X class="h-4 w-4 text-danger" />;
    case "pending":
      return <Icons.Clock class="h-4 w-4 text-attention" />;
    default:
      return <Icons.Info class="h-4 w-4 text-muted" />;
  }
}

function statusRollup(s: CommitStatusDto["state"]): Rollup {
  if (s === "success") return "success";
  if (s === "failure" || s === "error") return "failure";
  return "pending";
}

function checkRunRollup(run: CheckRunDto): Rollup {
  if (run.status !== "completed") return "pending";
  switch (run.conclusion) {
    case "success":
      return "success";
    case "failure":
    case "timed_out":
    case "action_required":
      return "failure";
    case "neutral":
    case "cancelled":
    case "skipped":
      return "neutral";
    default:
      return "neutral";
  }
}

function Row(props: {
  rollup: Rollup;
  name: string;
  description?: string | null;
  href?: string | null;
}): JSX.Element {
  return (
    <div class="flex items-center gap-3 border-b border-border px-4 py-2.5 last:border-b-0">
      <StateIcon rollup={props.rollup} />
      <div class="min-w-0 flex-1">
        <div class="truncate text-sm font-medium text-fg">{props.name}</div>
        <Show when={props.description}>
          <div class="truncate text-xs text-muted">{props.description}</div>
        </Show>
      </div>
      <Show when={props.href}>
        <ExternalLink href={props.href!} class="shrink-0 text-xs text-accent hover:underline">
          Details
        </ExternalLink>
      </Show>
    </div>
  );
}

export function PRChecks(props: { owner: string; repo: string; sha: string }): JSX.Element {
  const key = () => [props.owner, props.repo, props.sha] as const;
  const [combined] = createResource(key, ([o, r, s]) => checksApi.combinedStatus(o, r, s));
  const [runs] = createResource(key, ([o, r, s]) => checksApi.checkRuns(o, r, s));

  const overall = (): { tone: BannerTone; title: string } => {
    const c: CombinedStatusDto | undefined = combined();
    const runList = runs()?.checkRuns ?? [];
    const anyFail =
      c?.state === "failure" || runList.some((r) => checkRunRollup(r) === "failure");
    const anyPending =
      c?.state === "pending" ||
      runList.some((r) => checkRunRollup(r) === "pending");
    if (anyFail) return { tone: "danger", title: "Some checks were not successful" };
    if (anyPending) return { tone: "warning", title: "Some checks haven't completed yet" };
    return { tone: "success", title: "All checks have passed" };
  };

  const isEmpty = () =>
    (combined()?.statuses.length ?? 0) === 0 && (runs()?.checkRuns.length ?? 0) === 0;

  return (
    <ErrorBoundary
      fallback={(err) => (
        <Banner tone="danger" title="Could not load checks">
          {err instanceof ApiError ? err.message : "Unexpected error."}
        </Banner>
      )}
    >
      <Suspense fallback={<LoadingBlock label="Loading checks…" />}>
        <Show
          when={!isEmpty()}
          fallback={
            <EmptyState
              icon={<Icons.Play class="h-8 w-8" />}
              title="No checks reported"
              description="No statuses or check runs have been published for the head commit yet."
            />
          }
        >
          <div class="space-y-4">
            <Banner tone={overall().tone} title={overall().title}>
              <span class="inline-flex items-center gap-1">
                Head commit <Sha value={props.sha} />
              </span>
            </Banner>

            <Show when={(runs()?.checkRuns.length ?? 0) > 0}>
              <Box>
                <div class="border-b border-border bg-canvas-subtle px-4 py-2 text-sm font-semibold">
                  Check runs
                </div>
                <For each={runs()?.checkRuns}>
                  {(run) => (
                    <Row
                      rollup={checkRunRollup(run)}
                      name={run.name}
                      description={run.output?.title ?? run.output?.summary}
                      href={run.detailsUrl}
                    />
                  )}
                </For>
              </Box>
            </Show>

            <Show when={(combined()?.statuses.length ?? 0) > 0}>
              <Box>
                <div class="border-b border-border bg-canvas-subtle px-4 py-2 text-sm font-semibold">
                  Commit statuses
                </div>
                <For each={combined()?.statuses}>
                  {(status) => (
                    <Row
                      rollup={statusRollup(status.state)}
                      name={status.context}
                      description={status.description}
                      href={status.targetUrl}
                    />
                  )}
                </For>
              </Box>
            </Show>
          </div>
        </Show>
      </Suspense>
    </ErrorBoundary>
  );
}
