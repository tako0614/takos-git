import {
  createSignal,
  onCleanup,
  createEffect,
  Index,
  Show,
  type JSX,
} from "solid-js";
import { Icons } from "../../ui/index.ts";
import { actionsApi } from "../../api/actions.ts";
import { ApiError } from "../../api/client.ts";
import {
  RunStatusBadge,
  StepStatusBadge,
  RunStatusGlyph,
  StepStatusGlyph,
} from "./StatusBadge.tsx";
import { LogViewer } from "./LogViewer.tsx";
import { formatDuration, isTerminal, stepProgress } from "./helpers.tsx";
import type { WorkflowJobDto, WorkflowStepDto } from "../../api/types.ts";

const POLL_MS = 4000;

/**
 * An expandable job row. The summary (status, timing, runner) comes from
 * `props.job`, which the parent keeps fresh by polling the run's job list.
 * Expanding fetches the full job (with steps) from `actionsApi.job` — the list
 * endpoint omits steps — and re-polls it while the job is live. Rendered under
 * `<Index>` by the parent so the instance (and its expand state) survives each
 * poll's array replacement.
 */
export function JobCard(props: {
  owner: string;
  repo: string;
  job: WorkflowJobDto;
  defaultOpen?: boolean;
}): JSX.Element {
  const [open, setOpen] = createSignal(props.defaultOpen ?? false);
  const [detailSteps, setDetailSteps] = createSignal<readonly WorkflowStepDto[] | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let timer: ReturnType<typeof setInterval> | undefined;
  let disposed = false;

  const live = () => !isTerminal(props.job.status);
  // Prefer freshly-fetched steps; fall back to any the summary happened to carry.
  const steps = () => detailSteps() ?? props.job.steps ?? [];
  const duration = () => formatDuration(props.job.startedAt, props.job.completedAt);

  const fetchDetail = async (initial: boolean) => {
    if (initial) setLoading(true);
    try {
      const res = await actionsApi.job(props.owner, props.repo, props.job.id);
      if (disposed) return;
      setDetailSteps(res.job.steps ?? []);
      setError(null);
    } catch (err) {
      if (disposed) return;
      if (initial) setError(err instanceof ApiError ? err.message : "Failed to load job steps");
    } finally {
      if (!disposed && initial) setLoading(false);
    }
  };

  const stopPolling = () => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  // Load + poll steps only while expanded.
  createEffect(() => {
    if (open()) {
      if (detailSteps() === null) void fetchDetail(true);
      stopPolling();
      if (live()) timer = setInterval(() => void fetchDetail(false), POLL_MS);
    } else {
      stopPolling();
    }
  });

  onCleanup(() => {
    disposed = true;
    stopPolling();
  });

  return (
    <div class="overflow-hidden rounded-md border border-border bg-canvas">
      <button
        type="button"
        class="tg-focus flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-canvas-subtle"
        aria-expanded={open()}
        onClick={() => setOpen((v) => !v)}
      >
        <Icons.ChevronDown
          class={`h-4 w-4 shrink-0 text-muted transition-transform ${open() ? "" : "-rotate-90"}`}
        />
        <RunStatusGlyph status={props.job.status} conclusion={props.job.conclusion} class="shrink-0" />
        <span class="min-w-0 flex-1">
          <span class="block truncate text-sm font-semibold text-fg">{props.job.name}</span>
          <span class="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted">
            <Show when={stepProgress(props.job)}>{(p) => <span>{p()}</span>}</Show>
            <Show when={props.job.runnerName}>
              {(r) => (
                <span class="inline-flex items-center gap-1">
                  <Icons.Server class="h-3 w-3" /> {r()}
                </span>
              )}
            </Show>
            <Show when={props.job.needs.length > 0}>
              <span class="inline-flex items-center gap-1">
                <Icons.GitMerge class="h-3 w-3" /> needs {props.job.needs.join(", ")}
              </span>
            </Show>
            <Show when={duration()}>
              {(d) => (
                <span class="inline-flex items-center gap-1">
                  <Icons.Clock class="h-3 w-3" /> {d()}
                </span>
              )}
            </Show>
          </span>
        </span>
        <span class="shrink-0">
          <RunStatusBadge status={props.job.status} conclusion={props.job.conclusion} />
        </span>
      </button>

      <Show when={open()}>
        <div class="border-t border-border px-3 py-3">
          <Show when={error()}>
            <div class="mb-2 text-xs text-danger">{error()}</div>
          </Show>

          <Show when={steps().length > 0}>
            <ul class="mb-2 flex flex-col gap-1">
              <Index each={steps()}>
                {(step) => (
                  <li class="flex items-center justify-between gap-2 rounded px-2 py-1 text-sm hover:bg-canvas-subtle">
                    <span class="inline-flex min-w-0 items-center gap-2">
                      <StepStatusGlyph status={step().status} conclusion={step().conclusion} class="shrink-0" />
                      <span class="truncate text-fg">
                        <span class="text-muted">{step().number}.</span> {step().name}
                      </span>
                      <Show when={step().errorMessage}>
                        {(m) => <span class="truncate text-xs text-danger">— {m()}</span>}
                      </Show>
                    </span>
                    <StepStatusBadge status={step().status} conclusion={step().conclusion} />
                  </li>
                )}
              </Index>
            </ul>
          </Show>

          <Show when={loading() && steps().length === 0}>
            <div class="mb-2 text-xs text-muted">Loading steps…</div>
          </Show>

          <LogViewer owner={props.owner} repo={props.repo} jobId={props.job.id} live={live()} />
        </div>
      </Show>
    </div>
  );
}
