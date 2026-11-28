/**
 * Inline conflict resolver. Loads the per-path base/ours/theirs blob text (via
 * the local 409-tolerant reader), lets the user accept ours/theirs, delete, or
 * hand-edit the merged content per file, then submits every resolution through
 * `pullsApi.resolve`, which builds the merge commit and advances the base ref.
 */
import {
  createResource,
  createSignal,
  createUniqueId,
  onCleanup,
  ErrorBoundary,
  Index,
  Show,
  Suspense,
  type JSX,
} from "solid-js";
import { pullsApi, type MergeResponse } from "../../api/pulls.ts";
import { useSession } from "../../store/session.tsx";
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
import { hasUnappliedConflictEdit, type DetailedConflict, type Resolution } from "./types.ts";

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
  onResolved: (result: MergeResponse) => void;
  onCancel: () => void;
}): JSX.Element {
  const toast = useToast();
  const session = useSession();
  let live = true;
  onCleanup(() => { live = false; });
  const scope = () => JSON.stringify([props.owner, props.repo, props.pr.number, session.user()?.subject]);
  const [resolutions, setResolutions] = createSignal<Map<string, Resolution>>(new Map());
  const [selected, setSelected] = createSignal(props.conflicts[0]?.path ?? "");
  const [edit, setEdit] = createSignal(props.conflicts[0]?.ours ?? props.conflicts[0]?.theirs ?? "");
  const [editDirty, setEditDirty] = createSignal(false);
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const resolvedId = createUniqueId();

  const current = () => props.conflicts.find((c) => c.path === selected());
  const currentResolution = () => resolutions().get(selected());
  const hasUnappliedEdit = () =>
    hasUnappliedConflictEdit(currentResolution(), edit(), editDirty());

  const select = (path: string) => {
    setSelected(path);
    const res = resolutions().get(path);
    const conflict = props.conflicts.find((c) => c.path === path);
    setEdit(res?.content ?? conflict?.ours ?? conflict?.theirs ?? "");
    setEditDirty(false);
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
    if (c) {
      const content = c.ours ?? "";
      setEdit(content);
      setEditDirty(false);
      setResolution({ path: c.path, content, delete: false, source: "ours" });
    }
  };
  const acceptTheirs = () => {
    const c = current();
    if (c) {
      const content = c.theirs ?? "";
      setEdit(content);
      setEditDirty(false);
      setResolution({ path: c.path, content, delete: false, source: "theirs" });
    }
  };
  const acceptDelete = () => {
    const c = current();
    if (c) {
      setEditDirty(false);
      setResolution({ path: c.path, content: "", delete: true, source: "delete" });
    }
  };
  const applyEdit = () => {
    const c = current();
    if (c) {
      setEditDirty(false);
      setResolution({ path: c.path, content: edit(), delete: false, source: "manual" });
    }
  };

  const allResolved = () =>
    props.conflicts.length > 0 && props.conflicts.every((c) => resolutions().has(c.path));

  const submit = async () => {
    if (!allResolved() || submitting()) return;
    const captured = scope();
    setSubmitting(true);
    setError(null);
    try {
      const result = await pullsApi.resolve(props.owner, props.repo, props.pr.number, {
        resolutions: [...resolutions().values()].map((r) => ({
          path: r.path,
          content: r.content,
          delete: r.delete,
        })),
      });
      if (live && captured === scope()) props.onResolved(result);
    } catch (err) {
      if (!live || captured !== scope()) return;
      setError(err instanceof ApiError ? err.message : "Failed to submit resolutions.");
      toast.error("Failed to resolve conflicts.");
    } finally {
      if (live && captured === scope()) setSubmitting(false);
    }
  };

  return (
    <div class="space-y-3 rounded-md border border-border bg-canvas p-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 class="text-sm font-semibold text-fg">
            Resolve {props.conflicts.length} conflicting file{props.conflicts.length === 1 ? "" : "s"}
          </h3>
          <p class="mt-0.5 text-xs text-muted">
            <Mono>{props.pr.base.ref}</Mono> ← <Mono>{props.pr.head.ref}</Mono>
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
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

      <div class="flex flex-col gap-3 md:flex-row">
        <div class="w-full shrink-0 space-y-1 border-b border-border pb-2 md:w-52 md:border-b-0 md:border-r md:pb-0 md:pr-2">
          <Index each={props.conflicts}>
            {(conflict) => {
              const resolved = () => resolutions().has(conflict().path);
              const active = () => selected() === conflict().path;
              return (
                <button
                  type="button"
                  aria-current={active() ? "true" : undefined}
                  onClick={() => select(conflict().path)}
                  class={
                    "tg-focus flex min-h-11 w-full items-center gap-2 rounded px-2 py-1 text-left text-xs sm:min-h-0 " +
                    (active() ? "bg-canvas-inset font-semibold text-fg" : "hover:bg-canvas-subtle")
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
              <div class="flex flex-wrap items-center gap-2 text-xs text-muted">
                <Mono class="break-all text-fg">{conflict.path}</Mono>
                <span class="rounded bg-neutral-muted px-1.5 py-0.5 text-fg">{conflict.type}</span>
              </div>

              <div class="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  aria-pressed={currentResolution()?.source === "ours"}
                  variant={currentResolution()?.source === "ours" ? "primary" : "default"}
                  onClick={acceptOurs}
                >
                  Use {props.pr.base.ref} (ours)
                </Button>
                <Button
                  size="sm"
                  aria-pressed={currentResolution()?.source === "theirs"}
                  variant={currentResolution()?.source === "theirs" ? "primary" : "default"}
                  onClick={acceptTheirs}
                >
                  Use {props.pr.head.ref} (theirs)
                </Button>
                <Button
                  size="sm"
                  aria-pressed={currentResolution()?.source === "delete"}
                  variant={currentResolution()?.source === "delete" ? "danger" : "default"}
                  onClick={acceptDelete}
                >
                  <Icons.X class="h-3.5 w-3.5" /> Delete file
                </Button>
              </div>

              <div class="flex flex-col gap-2 sm:flex-row">
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
                <div class="flex flex-wrap items-center justify-between gap-2 rounded-t-md border border-border bg-canvas-subtle px-2 py-1 text-xs font-semibold text-fg">
                  <div class="flex min-w-0 items-center gap-2">
                    <label for={resolvedId} class="truncate">Resolved content for {conflict.path}</label>
                    <Show when={currentResolution() && hasUnappliedEdit()}>
                      <span class="shrink-0 rounded-full bg-attention-subtle px-2 py-0.5 text-[11px] font-medium text-attention">
                        Unapplied edits
                      </span>
                    </Show>
                  </div>
                  <button
                    type="button"
                    onClick={applyEdit}
                    class={
                      "tg-focus min-h-11 shrink-0 rounded border px-2.5 py-0.5 text-xs sm:min-h-0 sm:px-2 " +
                      (hasUnappliedEdit()
                        ? "border-accent-emphasis bg-accent-emphasis font-medium text-white hover:brightness-110"
                        : "border-border bg-canvas text-fg hover:bg-canvas-inset")
                    }
                  >
                    {currentResolution()?.source === "manual" && !hasUnappliedEdit() ? "Edit applied" : "Apply edit"}
                  </button>
                </div>
                <Textarea
                  id={resolvedId}
                  rows={5}
                  class={
                    "rounded-t-none " +
                    (currentResolution()?.source === "manual" ? "bg-accent-subtle" : "")
                  }
                  value={edit()}
                  onInput={(e) => {
                    setEdit(e.currentTarget.value);
                    setEditDirty(true);
                  }}
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
  onResolved: (result: MergeResponse) => void;
  onCancel: () => void;
}): JSX.Element {
  const [data, { refetch }] = createResource(
    () => [props.owner, props.repo, props.pr.number] as const,
    ([owner, repo, number]) => loadConflicts(owner, repo, number),
  );

  return (
    <ErrorBoundary
      fallback={(err, reset) => (
        <Banner
          tone="danger"
          title="Could not load conflicts"
          action={
            <Button size="sm" onClick={() => { void refetch(); reset(); }}>
              Retry
            </Button>
          }
        >
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
