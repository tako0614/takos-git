/**
 * Actions view — workflow runs list + run detail.
 *
 * Seam (see web/README.md): owns `/:owner/:repo/actions` (runs list, filters,
 * `workflow_dispatch`) and `/:owner/:repo/actions/runs/:runId` (run detail with
 * job graph, per-step logs, artifacts, cancel/re-run). Consumes `useRepo()` for
 * owner/repo/default-branch and `actionsApi` for every read/write. Live state is
 * kept fresh by polling while runs/jobs are non-terminal (CSP-safe; no WS needed).
 */
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  on,
  Show,
  type JSX,
} from "solid-js";
import { useParams } from "@solidjs/router";
import { useRepo } from "../../app/RepoLayout.tsx";
import { useSession } from "../../store/session.tsx";
import {
  Banner,
  Button,
  Icons,
  Pagination,
  Select,
} from "../../ui/index.ts";
import { createPolling } from "../../lib/lifecycle.ts";
import { actionsApi, type RunListFilter } from "../../api/actions.ts";
import { ApiError } from "../../api/client.ts";
import { RunsList } from "./RunsList.tsx";
import { DispatchDialog } from "./DispatchDialog.tsx";
import { RunDetail } from "./RunDetail.tsx";
import { runIsLive } from "./helpers.tsx";
import type { WorkflowDto } from "../../api/types.ts";

const PAGE_SIZE = 25;
const POLL_MS = 8000;

const STATUS_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "All statuses" },
  { value: "queued", label: "Queued" },
  { value: "in_progress", label: "In progress" },
  { value: "completed", label: "Completed" },
];

const EVENT_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "All events" },
  { value: "push", label: "push" },
  { value: "pull_request", label: "pull_request" },
  { value: "workflow_dispatch", label: "manual" },
  { value: "schedule", label: "schedule" },
];

export function ActionsView(): JSX.Element {
  const repo = useRepo();
  const session = useSession();
  const [dispatchOpen, setDispatchOpen] = createSignal(false);

  // Repo-scoped filters and cursor stack so client-side repo switches never
  // dispatch a stale request with the previous repository's filters or cursor.
  const repoScope = () => `${repo.owner()}/${repo.repo()}`;
  const [viewState, setViewState] = createSignal<{
    scope: string;
    workflow: string;
    status: string;
    event: string;
    stack: (string | null)[];
  }>({ scope: repoScope(), workflow: "", status: "", event: "", stack: [null] });
  const scoped = () =>
    viewState().scope === repoScope()
      ? viewState()
      : { scope: repoScope(), workflow: "", status: "", event: "", stack: [null] as (string | null)[] };
  const workflow = () => scoped().workflow;
  const status = () => scoped().status;
  const event = () => scoped().event;
  const cursors = () => scoped().stack;
  const currentCursor = () => cursors()[cursors().length - 1] ?? null;
  const updateView = (patch: Partial<{ workflow: string; status: string; event: string; stack: (string | null)[] }>) =>
    setViewState({ ...scoped(), scope: repoScope(), ...patch });
  const setWorkflow = (v: string) => updateView({ workflow: v, stack: [null] });
  const setStatus = (v: string) => updateView({ status: v, stack: [null] });
  const setEvent = (v: string) => updateView({ event: v, stack: [null] });
  const resetPaging = () => updateView({ stack: [null] });
  const clearFilters = () =>
    setViewState({ scope: repoScope(), workflow: "", status: "", event: "", stack: [null] });
  createEffect(
    on(
      repoScope,
      () => {
        setDispatchOpen(false);
        clearFilters();
      },
      { defer: true },
    ),
  );

  const filter = createMemo<RunListFilter>(() => ({
    workflow: workflow() || undefined,
    status: status() || undefined,
    event: event() || undefined,
    limit: PAGE_SIZE,
    cursor: currentCursor(),
  }));

  const source = createMemo(() => ({
    owner: repo.owner(),
    repo: repo.repo(),
    filter: filter(),
  }));

  const [runsRes, { refetch }] = createResource(source, (s) =>
    actionsApi.runs(s.owner, s.repo, s.filter),
  );

  const [workflowsRes, { refetch: refetchWorkflows }] = createResource(
    () => [repo.owner(), repo.repo()] as const,
    async ([o, r]) => (await actionsApi.workflows(o, r)).items,
  );
  const workflows = (): readonly WorkflowDto[] =>
    workflowsRes.error ? [] : (workflowsRes.latest ?? []);
  const workflowsError = (): string | null => {
    const e = workflowsRes.error;
    if (!e) return null;
    return e instanceof ApiError ? e.message : "Could not load workflow definitions.";
  };

  const runsPage = () => (runsRes.error ? undefined : runsRes.latest);
  const items = () => runsPage()?.items ?? [];
  const hasNext = () => Boolean(runsPage()?.nextCursor);
  const hasPrev = () => cursors().length > 1;
  const isFiltered = () => Boolean(workflow() || status() || event());

  const errorText = () => {
    const e = runsRes.error;
    if (!e) return null;
    return e instanceof ApiError ? e.message : "Something went wrong.";
  };

  // Poll while any visible run is still live.
  createPolling({
    active: () => items().some((r) => runIsLive(r)),
    intervalMs: POLL_MS,
    tick: () => void refetch(),
  });

  const goNext = () => {
    const next = runsPage()?.nextCursor;
    if (next) updateView({ stack: [...cursors(), next] });
  };
  const goPrev = () =>
    updateView({
      stack: cursors().length > 1 ? cursors().slice(0, -1) : [null],
    });

  return (
    <div class="flex flex-col gap-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h1 class="inline-flex items-center gap-2 text-lg font-semibold text-fg">
          <Icons.Play class="h-5 w-5 text-muted" /> Workflow runs
        </h1>
        <div class="flex items-center gap-2">
          <Button variant="default" onClick={() => void refetch()} aria-label="Refresh runs">
            <Icons.Refresh class="h-4 w-4" /> Refresh
          </Button>
          <Show when={session.authenticated()}>
            <Button variant="primary" onClick={() => setDispatchOpen(true)}>
              <Icons.Play class="h-4 w-4" /> Run workflow
            </Button>
          </Show>
        </div>
      </div>

      <Show when={workflowsError()}>
        {(msg) => (
          <Banner
            tone="warning"
            title="Could not load workflow list"
            action={
              <Button size="sm" disabled={workflowsRes.loading} onClick={() => void refetchWorkflows()}>
                Retry
              </Button>
            }
          >
            {msg()}
          </Banner>
        )}
      </Show>

      {/* Filter bar */}
      <div class="flex flex-wrap items-center gap-2">
        <label class="sr-only" for="filter-workflow">Filter by workflow</label>
        <Select
          id="filter-workflow"
          class="w-auto min-w-44"
          value={workflow()}
          onChange={(e) => setWorkflow(e.currentTarget.value)}
        >
          <option value="">All workflows</option>
          <For each={workflows()}>
            {(w) => <option value={w.path}>{w.name ?? w.path}</option>}
          </For>
        </Select>

        <label class="sr-only" for="filter-status">Filter by status</label>
        <Select
          id="filter-status"
          class="w-auto min-w-40"
          value={status()}
          onChange={(e) => setStatus(e.currentTarget.value)}
        >
          <For each={STATUS_OPTIONS}>
            {(o) => <option value={o.value}>{o.label}</option>}
          </For>
        </Select>

        <label class="sr-only" for="filter-event">Filter by event</label>
        <Select
          id="filter-event"
          class="w-auto min-w-36"
          value={event()}
          onChange={(e) => setEvent(e.currentTarget.value)}
        >
          <For each={EVENT_OPTIONS}>
            {(o) => <option value={o.value}>{o.label}</option>}
          </For>
        </Select>

        <Show when={isFiltered()}>
          <Button
            variant="invisible"
            size="sm"
            onClick={clearFilters}
          >
            <Icons.X class="h-3.5 w-3.5" /> Clear
          </Button>
        </Show>
      </div>

      <RunsList
        owner={repo.owner()}
        repo={repo.repo()}
        runs={items()}
        loading={runsRes.loading && !runsPage()}
        error={errorText()}
        filtered={isFiltered()}
        onRetry={() => void refetch()}
        onClearFilters={clearFilters}
      />

      <Pagination
        hasNext={hasNext()}
        hasPrev={hasPrev()}
        onNext={goNext}
        onPrev={goPrev}
        loading={runsRes.loading}
      />

      <DispatchDialog
        open={dispatchOpen()}
        onClose={() => setDispatchOpen(false)}
        owner={repo.owner()}
        repo={repo.repo()}
        workflows={workflows()}
        defaultRef={repo.detail()?.defaultBranch ?? "main"}
        onDispatched={() => {
          setDispatchOpen(false);
          resetPaging();
          void refetch();
        }}
      />
    </div>
  );
}

export function RunDetailView(): JSX.Element {
  const repo = useRepo();
  const params = useParams();
  return <RunDetail owner={repo.owner()} repo={repo.repo()} runId={params.runId ?? ""} />;
}
