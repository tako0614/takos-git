import { createSignal, onCleanup, onMount, Show, type JSX } from "solid-js";
import { createLifecycleOwner, createPolling } from "../../lib/lifecycle.ts";
import { Icons, Spinner } from "../../ui/index.ts";
import { actionsApi } from "../../api/actions.ts";
import { ApiError } from "../../api/client.ts";

const POLL_MS = 4000;

/**
 * Step/job log viewer. Fetches the job's log text through the typed Actions
 * client and, while the job is still live, polls for appended output.
 */
export function LogViewer(props: {
  owner: string;
  repo: string;
  jobId: string;
  live: boolean;
}): JSX.Element {
  const [text, setText] = createSignal<string>("");
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [notReady, setNotReady] = createSignal(false);
  const [copied, setCopied] = createSignal(false);
  let disposed = false;
  let copyVersion = 0;
  // Named `timers` because `owner` is already a repo-owner prop in this view.
  const timers = createLifecycleOwner();

  const load = async (initial: boolean) => {
    if (initial) setLoading(true);
    try {
      const res = await actionsApi.jobLogs(
        props.owner,
        props.repo,
        props.jobId,
      );
      if (disposed) return;
      setText(res.logs ?? "");
      setNotReady(false);
      setError(null);
    } catch (err) {
      if (disposed) return;
      if (err instanceof ApiError && err.isNotFound) {
        setNotReady(true);
      } else if (initial) {
        setError(err instanceof ApiError ? err.message : "Failed to load logs");
      }
    } finally {
      if (!disposed && initial) setLoading(false);
    }
  };

  onMount(() => {
    void load(true);
  });

  // `props.live` is read through the accessor, so a job that finishes while the
  // viewer stays open stops the poll instead of hammering the logs endpoint
  // forever (the viewer is not re-mounted when the job's state changes).
  createPolling({
    active: () => props.live,
    intervalMs: POLL_MS,
    tick: () => load(false),
  });

  onCleanup(() => {
    disposed = true;
  });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text());
      setCopied(true);
      const version = ++copyVersion;
      timers.timeout(1500, () => {
        if (version === copyVersion) setCopied(false);
      });
    } catch {
      /* clipboard may be unavailable — non-fatal */
    }
  };

  return (
    <div class="mt-2 overflow-hidden rounded-md border border-border">
      <div class="flex items-center justify-between gap-2 border-b border-border bg-canvas-subtle px-3 py-1.5 text-xs text-muted">
        <span class="inline-flex items-center gap-1.5">
          <Icons.Terminal class="h-3.5 w-3.5" /> Logs
          <Show when={props.live && !notReady()}>
            <span class="inline-flex items-center gap-1 text-accent">
              <Icons.Loader class="h-3 w-3 animate-spin" /> live
            </span>
          </Show>
        </span>
        <div>
          <button
            type="button"
            class="tg-focus inline-flex items-center gap-1 rounded hover:text-fg"
            onClick={() => void copy()}
            disabled={!text()}
          >
            <Icons.Copy class="h-3.5 w-3.5" /> {copied() ? "Copied" : "Copy"}
          </button>
        </div>
      </div>

      <Show
        when={!loading()}
        fallback={
          <div class="flex items-center gap-2 px-3 py-4 text-xs text-muted">
            <Spinner size={14} /> Loading logs…
          </div>
        }
      >
        <Show when={error()}>
          <div class="px-3 py-4 text-xs text-danger">{error()}</div>
        </Show>
        <Show when={!error() && notReady()}>
          <div class="px-3 py-4 text-xs text-muted">
            No logs yet — they appear once the runner starts this job.
          </div>
        </Show>
        <Show when={!error() && !notReady()}>
          <pre class="max-h-96 overflow-auto bg-neutral-muted px-3 py-2 font-mono text-xs leading-5 text-fg whitespace-pre-wrap break-words">
            {text() || "(empty)"}
          </pre>
        </Show>
      </Show>
    </div>
  );
}
