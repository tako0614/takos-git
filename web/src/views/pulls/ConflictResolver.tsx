/**
 * Inline conflict resolver. Loads the per-path base/ours/theirs blob text (via
 * the local 409-tolerant reader), lets the user accept ours/theirs, delete, or
 * hand-edit the merged content per file, then submits every resolution through
 * `pullsApi.resolve`, which builds the merge commit and advances the base ref.
 */
import {
  createResource,
  createSignal,
  ErrorBoundary,
  Index,
  Show,
  Suspense,
  type JSX,
} from "solid-js";
import { pullsApi } from "../../api/pulls.ts";
import { ApiError } from "../../api/client.ts";
import type { PullRequestDto } from "../../api/types.ts";
import {
  Banner,
  Button,
  Icons,
  LoadingBlock,
  Mono,
  Textarea,
  useToast,
} from "../../ui/index.ts";
import { loadConflicts } from "./api-local.ts";
import type { DetailedConflict, Resolution } from "./types.ts";

function Pane(props: { title: JSX.Element; body: string | null; active: boolean }): JSX.Element {
  return (
    <div class="flex min-w-0 flex-1 flex-col">
      <div class="rounded-t-md border border-border bg-canvas-subtle px-2 py-1 text-xs font-semibold text-fg">
        {props.title}
      </div>
      <pre
        class={
          "m-0 max-h-64 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-b-md border border-t-0 border-border p-2 font-mono text-xs " +
          (props.active ? "bg-accent-subtle" : "bg-canvas")
        }
      >
        {props.body ?? "(file does not exist on this side)"}
      </pre>
    </div>
  );
}

function ResolverBody(props: {
  owner: string;
  repo: string;
  pr: PullRequestDto;
  conflicts: readonly DetailedConflict[];
  onResolved: () => void;
  onCancel: () => void;
}): JSX.Element {
  const toast = useToast();
  const [resolutions, setResolutions] = createSignal<Map<string, Resolution>>(new Map());
  const [selected, setSelected] = createSignal(props.conflicts[0]?.path ?? "");
  const [edit, setEdit] = createSignal(props.conflicts[0]?.ours ?? props.conflicts[0]?.theirs ?? "");
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const current = () => props.conflicts.find((c) => c.path === selected());
  const currentResolution = () => resolutions().get(selected());

  const select = (path: string) => {
    setSelected(path);
    const res = resolutions().get(path);
    const conflict = props.conflicts.find((c) => c.path === path);
    setEdit(res?.content ?? conflict?.ours ?? conflict?.theirs ?? "");
  };

  const setResolution = (r: Resolution) => {
    setResolutions((prev) => {
      const next = new Map(prev);
      next.set(r.path, r);
      return next;
    });
  };

  const acceptOurs = () => {
    const c = current();
    if (c) setResolution({ path: c.path, content: c.ours ?? "", delete: false, source: "ours" });
  };
  const acceptTheirs = () => {
    const c = current();
    if (c) setResolution({ path: c.path, content: c.theirs ?? "", delete: false, source: "theirs" });
  };
  const acceptDelete = () => {
    const c = current();
    if (c) setResolution({ path: c.path, content: "", delete: true, source: "delete" });
  };
  const applyEdit = () => {
    const c = current();
    if (c) setResolution({ path: c.path, content: edit(), delete: false, source: "manual" });
  };

  const allResolved = () =>
    props.conflicts.length > 0 && props.conflicts.every((c) => resolutions().has(c.path));

  const submit = async () => {
    if (!allResolved() || submitting()) return;
    setSubmitting(true);
    setError(null);
    try {
      await pullsApi.resolve(props.owner, props.repo, props.pr.number, {
        resolutions: [...resolutions().values()].map((r) => ({
          path: r.path,
          content: r.content,
          delete: r.delete,
        })),
      });
      props.onResolved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to submit resolutions.");
      toast.error("Failed to resolve conflicts.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div class="space-y-3 rounded-md border border-border bg-canvas p-3">
      <div class="flex items-center justify-between">
        <div>
          <h3 class="text-sm font-semibold text-fg">
            Resolve {props.conflicts.length} conflicting file{props.conflicts.length === 1 ? "" : "s"}
          </h3>
          <p class="mt-0.5 text-xs text-muted">
            <Mono>{props.pr.base.ref}</Mono> ← <Mono>{props.pr.head.ref}</Mono>
          </p>
        </div>
        <div class="flex items-center gap-2">
          <Button size="sm" onClick={props.onCancel} disabled={submitting()}>Cancel</Button>
          <Button size="sm" variant="primary" onClick={submit} disabled={!allResolved() || submitting()}>
            {submitting()
              ? "Merging…"
              : `Mark resolved & merge (${resolutions().size}/${props.conflicts.length})`}
          </Button>
        </div>
      </div>

      <Show when={error()}>
        <Banner tone="danger">{error()}</Banner>
      </Show>

      <div class="flex gap-3">
        <div class="w-52 shrink-0 space-y-1 border-r border-border pr-2">
          <Index each={props.conflicts}>
            {(conflict) => {
              const resolved = () => resolutions().has(conflict().path);
              const active = () => selected() === conflict().path;
              return (
                <button
                  type="button"
                  onClick={() => select(conflict().path)}
                  class={
                    "flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs " +
                    (active() ? "bg-canvas-inset" : "hover:bg-canvas-subtle")
                  }
                >
                  <Show
                    when={resolved()}
                    fallback={<Icons.AlertTriangle class="h-3.5 w-3.5 shrink-0 text-attention" />}
                  >
                    <Icons.Check class="h-3.5 w-3.5 shrink-0 text-success" />
                  </Show>
                  <span class="truncate font-mono" title={conflict().path}>
                    {conflict().path.split("/").pop()}
                  </span>
                </button>
              );
            }}
          </Index>
        </div>

        <Show when={current()} keyed>
          {(conflict) => (
            <div class="min-w-0 flex-1 space-y-2">
              <div class="flex items-center gap-2 text-xs text-muted">
                <Mono class="text-fg">{conflict.path}</Mono>
                <span class="rounded bg-neutral-muted px-1.5 py-0.5">{conflict.type}</span>
              </div>

              <div class="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant={currentResolution()?.source === "ours" ? "primary" : "default"}
                  onClick={acceptOurs}
                >
                  Use {props.pr.base.ref} (ours)
                </Button>
                <Button
                  size="sm"
                  variant={currentResolution()?.source === "theirs" ? "primary" : "default"}
                  onClick={acceptTheirs}
                >
                  Use {props.pr.head.ref} (theirs)
                </Button>
                <Button
                  size="sm"
                  variant={currentResolution()?.source === "delete" ? "danger" : "default"}
                  onClick={acceptDelete}
                >
                  <Icons.X class="h-3.5 w-3.5" /> Delete file
                </Button>
              </div>

              <div class="flex gap-2">
                <Pane
                  title={<>{props.pr.base.ref} (ours)</>}
                  body={conflict.ours}
                  active={currentResolution()?.source === "ours"}
                />
                <Pane
                  title={<>{props.pr.head.ref} (theirs)</>}
                  body={conflict.theirs}
                  active={currentResolution()?.source === "theirs"}
                />
              </div>

              <div>
                <div class="flex items-center justify-between rounded-t-md border border-border bg-canvas-subtle px-2 py-1 text-xs font-semibold text-fg">
                  <span>Resolved content</span>
                  <button
                    type="button"
                    onClick={applyEdit}
                    class="tg-focus rounded border border-border bg-canvas px-2 py-0.5 text-xs hover:bg-canvas-inset"
                  >
                    Apply edit
                  </button>
                </div>
                <Textarea
                  rows={5}
                  class={
                    "rounded-t-none " +
                    (currentResolution()?.source === "manual" ? "bg-accent-subtle" : "")
                  }
                  value={edit()}
                  onInput={(e) => setEdit(e.currentTarget.value)}
                />
              </div>
            </div>
          )}
        </Show>
      </div>
    </div>
  );
}

export function ConflictResolver(props: {
  owner: string;
  repo: string;
  pr: PullRequestDto;
  onResolved: () => void;
  onCancel: () => void;
}): JSX.Element {
  const [data] = createResource(
    () => [props.owner, props.repo, props.pr.number] as const,
    ([owner, repo, number]) => loadConflicts(owner, repo, number),
  );

  return (
    <ErrorBoundary
      fallback={(err) => (
        <Banner tone="danger" title="Could not load conflicts">
          {err instanceof ApiError ? err.message : "Unexpected error."}
        </Banner>
      )}
    >
      <Suspense fallback={<LoadingBlock label="Inspecting conflicts…" />}>
        <Show
          when={data() && !data()!.mergeable && data()!.conflicts.length > 0}
          fallback={
            <Banner tone="info">
              {data()?.mergeable
                ? "This branch is now mergeable — reload to merge."
                : data()?.message ?? "No resolvable conflicts were reported."}
            </Banner>
          }
        >
          <ResolverBody
            owner={props.owner}
            repo={props.repo}
            pr={props.pr}
            conflicts={data()!.conflicts}
            onResolved={props.onResolved}
            onCancel={props.onCancel}
          />
        </Show>
      </Suspense>
    </ErrorBoundary>
  );
}
