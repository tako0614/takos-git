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
  onCleanup,
  Show,
  type JSX,
} from "solid-js";
import { useParams } from "@solidjs/router";
import { useRepo } from "../../app/RepoLayout.tsx";
import {
  Button,
  Icons,
  Pagination,
  Select,
} from "../../ui/index.ts";
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

  const [workflow, setWorkflow] = createSignal("");
  const [status, setStatus] = createSignal("");
  const [event, setEvent] = createSignal("");
  const [dispatchOpen, setDispatchOpen] = createSignal(false);

  // Cursor stack for forward/back pagination (opaque server cursors).
  const [cursors, setCursors] = createSignal<(string | null)[]>([null]);
  const currentCursor = () => cursors()[cursors().length - 1] ?? null;

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

  const [workflowsRes] = createResource(
    () => [repo.owner(), repo.repo()] as const,
    async ([o, r]) => (await actionsApi.workflows(o, r)).items,
  );
  const workflows = (): readonly WorkflowDto[] => workflowsRes.latest ?? [];

  const items = () => runsRes.latest?.items ?? [];
  const hasNext = () => Boolean(runsRes.latest?.nextCursor);
  const hasPrev = () => cursors().length > 1;
  const isFiltered = () => Boolean(workflow() || status() || event());

  const errorText = () => {
    const e = runsRes.error;
    // Keep showing a good list if a background poll transiently fails.
    if (!e || runsRes.latest) return null;
    return e instanceof ApiError ? e.message : "Something went wrong.";
  };

  // Reset pagination whenever a filter changes.
  const resetPaging = () => setCursors([null]);

  // Poll while any visible run is still live.
  let timer: ReturnType<typeof setInterval> | undefined;
  createEffect(() => {
    const live = items().some((r) => runIsLive(r));
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    if (live) timer = setInterval(() => void refetch(), POLL_MS);
  });
  onCleanup(() => {
    if (timer) clearInterval(timer);
  });

  const goNext = () => {
    const next = runsRes.latest?.nextCursor;
    if (next) setCursors((c) => [...c, next]);
  };
  const goPrev = () => setCursors((c) => (c.length > 1 ? c.slice(0, -1) : c));

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
          <Button variant="primary" onClick={() => setDispatchOpen(true)}>
            <Icons.Play class="h-4 w-4" /> Run workflow
          </Button>
        </div>
      </div>

      {/* Filter bar */}
      <div class="flex flex-wrap items-center gap-2">
        <label class="sr-only" for="filter-workflow">Filter by workflow</label>
        <Select
          id="filter-workflow"
          class="w-auto min-w-44"
          value={workflow()}
          onChange={(e) => {
            setWorkflow(e.currentTarget.value);
            resetPaging();
          }}
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
          onChange={(e) => {
            setStatus(e.currentTarget.value);
            resetPaging();
          }}
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
          onChange={(e) => {
            setEvent(e.currentTarget.value);
            resetPaging();
          }}
        >
          <For each={EVENT_OPTIONS}>
            {(o) => <option value={o.value}>{o.label}</option>}
          </For>
        </Select>

        <Show when={isFiltered()}>
          <Button
            variant="invisible"
            size="sm"
            onClick={() => {
              setWorkflow("");
              setStatus("");
              setEvent("");
              resetPaging();
            }}
          >
            <Icons.X class="h-3.5 w-3.5" /> Clear
          </Button>
        </Show>
      </div>

      <RunsList
        owner={repo.owner()}
        repo={repo.repo()}
        runs={items()}
        loading={runsRes.loading && !runsRes.latest}
        error={errorText()}
        filtered={isFiltered()}
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
