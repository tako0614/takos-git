import { createResource, createSignal, Index, Show, type JSX } from "solid-js";
import { useSearchParams } from "@solidjs/router";
import { useRepo } from "../../app/RepoLayout.tsx";
import { useSession } from "../../store/session.tsx";
import {
  ApiError,
  releasesApi,
  type ReleaseDto,
} from "../../api";
import {
  Banner,
  Box,
  Button,
  EmptyState,
  Icons,
  Label,
  LoadingBlock,
  Pagination,
  RelativeTime,
  Sha,
  useConfirmDialog,
  useToast,
} from "../../ui";
import { ReleaseDetail } from "./ReleaseDetail.tsx";
import { ReleaseForm } from "./ReleaseForm.tsx";
import { latestTagOf, releaseTitle, totalDownloads } from "./helpers.ts";

const PAGE_SIZE = 20;

/**
 * Releases feature view. A single repo route (`/:owner/:repo/releases`) hosts
 * three screens, switched by the `?tag=` search param (deep-linkable):
 *   - no `tag`  → the releases list
 *   - `?tag=X`  → the detail for release X
 * Create/edit is an overlay dialog on top of either screen.
 */
export function ReleasesView(): JSX.Element {
  const repo = useRepo();
  const session = useSession();
  const toast = useToast();
  const { confirm } = useConfirmDialog();
  const [params, setParams] = useSearchParams();

  const owner = () => repo.owner();
  const name = () => repo.repo();
  const canWrite = () => session.authenticated();

  const selectedTag = (): string | null => {
    const t = params.tag;
    return typeof t === "string" && t ? t : null;
  };

  // --- create / edit dialog --------------------------------------------------
  const [formOpen, setFormOpen] = createSignal(false);
  const [editing, setEditing] = createSignal<ReleaseDto | null>(null);
  const [detailReload, setDetailReload] = createSignal(0);

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };
  const openEdit = (release: ReleaseDto) => {
    setEditing(release);
    setFormOpen(true);
  };

  // --- list with cursor pagination -------------------------------------------
  const [cursor, setCursor] = createSignal<string | null>(null);
  const [stack, setStack] = createSignal<(string | null)[]>([]);

  const [page, { refetch }] = createResource(
    () => [owner(), name(), cursor()] as const,
    ([o, r, c]) => releasesApi.list(o, r, { limit: PAGE_SIZE, cursor: c }),
  );

  const goNext = () => {
    const next = page.latest?.nextCursor;
    if (!next) return;
    setStack((s) => [...s, cursor()]);
    setCursor(next);
  };
  const goPrev = () => {
    setStack((s) => {
      const copy = [...s];
      const prev = copy.pop() ?? null;
      setCursor(prev);
      return copy;
    });
  };

  const openDetail = (tag: string) => setParams({ tag });
  const backToList = () => setParams({ tag: undefined });

  const onSaved = (tag: string) => {
    setFormOpen(false);
    const wasEditing = editing() !== null;
    setEditing(null);
    void refetch();
    if (wasEditing) {
      setDetailReload((n) => n + 1);
    } else {
      openDetail(tag);
    }
  };

  const removeFromList = async (release: ReleaseDto) => {
    const ok = await confirm({
      title: "Delete release",
      message: `Delete the release for ${release.tag}? The git tag itself is kept. This cannot be undone.`,
      confirmText: "Delete release",
      danger: true,
    });
    if (!ok) return;
    try {
      await releasesApi.remove(owner(), name(), release.tag);
      toast.success("Release deleted.");
      void refetch();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to delete the release.");
    }
  };

  const newButton = (label: string) => (
    <Show when={canWrite()}>
      <Button size="sm" variant="primary" onClick={openCreate}>
        <Icons.Plus class="h-4 w-4" /> {label}
      </Button>
    </Show>
  );

  return (
    <>
      <Show
        when={selectedTag()}
        fallback={
          <div class="flex flex-col gap-4">
            <div class="flex items-center justify-between gap-2">
              <h2 class="flex items-center gap-2 text-lg font-semibold text-fg">
                <Icons.Tag class="h-5 w-5 text-muted" /> Releases
              </h2>
              {newButton("Draft a new release")}
            </div>

            <Show
              when={!page.loading || page.latest}
              fallback={<LoadingBlock label="Loading releases…" />}
            >
              <Show
                when={!page.error}
                fallback={
                  <Banner
                    tone="danger"
                    title="Couldn't load releases"
                    action={<Button size="sm" onClick={() => void refetch()}>Retry</Button>}
                  >
                    {page.error instanceof Error ? page.error.message : "Unknown error."}
                  </Banner>
                }
              >
                <Show
                  when={(page.latest?.items.length ?? 0) > 0}
                  fallback={
                    <EmptyState
                      icon={<Icons.Tag class="h-8 w-8" />}
                      title="No releases published"
                      description="Releases let you package software, release notes, and binaries for download. Draft one from a git tag."
                      action={newButton("Create a new release")}
                    />
                  }
                >
                  <ReleaseTable
                    items={page.latest?.items ?? []}
                    canWrite={canWrite()}
                    onOpen={openDetail}
                    onEdit={openEdit}
                    onDelete={removeFromList}
                  />
                  <Pagination
                    hasNext={!!page.latest?.nextCursor}
                    hasPrev={stack().length > 0}
                    onNext={goNext}
                    onPrev={goPrev}
                    loading={page.loading}
                  />
                </Show>
              </Show>
            </Show>
          </div>
        }
      >
        {(tag) => (
          <ReleaseDetail
            owner={owner()}
            repo={name()}
            tag={tag()}
            canWrite={canWrite()}
            reloadKey={detailReload()}
            onBack={backToList}
            onEdit={openEdit}
            onDeleted={() => {
              void refetch();
              backToList();
            }}
          />
        )}
      </Show>

      <ReleaseForm
        open={formOpen()}
        owner={owner()}
        repo={name()}
        editing={editing()}
        onClose={() => setFormOpen(false)}
        onSaved={onSaved}
      />
    </>
  );
}

// ---------------------------------------------------------------------------

function ReleaseTable(props: {
  items: readonly ReleaseDto[];
  canWrite: boolean;
  onOpen: (tag: string) => void;
  onEdit: (release: ReleaseDto) => void;
  onDelete: (release: ReleaseDto) => void;
}): JSX.Element {
  const latest = () => latestTagOf(props.items);
  return (
    <Box>
      <Index each={props.items}>
        {(release) => (
          <ReleaseRow
            release={release()}
            isLatest={release().tag === latest()}
            canWrite={props.canWrite}
            onOpen={props.onOpen}
            onEdit={props.onEdit}
            onDelete={props.onDelete}
          />
        )}
      </Index>
    </Box>
  );
}

function ReleaseRow(props: {
  release: ReleaseDto;
  isLatest: boolean;
  canWrite: boolean;
  onOpen: (tag: string) => void;
  onEdit: (release: ReleaseDto) => void;
  onDelete: (release: ReleaseDto) => void;
}): JSX.Element {
  const r = () => props.release;
  return (
    <div class="flex items-start gap-3 border-b border-border px-4 py-4 last:border-b-0">
      <div class="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border bg-canvas-subtle text-muted">
        <Icons.Tag class="h-4 w-4" />
      </div>

      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-2">
          <button
            type="button"
            class="tg-focus truncate rounded text-base font-semibold text-fg hover:text-accent hover:underline"
            onClick={() => props.onOpen(r().tag)}
          >
            {releaseTitle(r())}
          </button>
          <Show when={props.isLatest}>
            <Label tone="success">Latest</Label>
          </Show>
          <Show when={r().isPrerelease}>
            <Label tone="attention">Pre-release</Label>
          </Show>
          <Show when={r().isDraft}>
            <Label tone="default">Draft</Label>
          </Show>
        </div>

        <div class="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted">
          <span class="font-mono">{r().tag}</span>
          <Show when={r().targetSha}>
            {(sha) => <Sha value={sha()} />}
          </Show>
          <span>
            <RelativeTime epochMs={r().publishedAt ?? r().createdAt} />
          </span>
          <Show when={r().assets.length > 0}>
            <span class="inline-flex items-center gap-1">
              <Icons.Package class="h-3 w-3" />
              {r().assets.length} {r().assets.length === 1 ? "asset" : "assets"}
            </span>
          </Show>
          <Show when={totalDownloads(r()) > 0}>
            <span class="inline-flex items-center gap-1">
              <Icons.Download class="h-3 w-3" />
              {totalDownloads(r())}
            </span>
          </Show>
        </div>

        <Show when={r().body?.trim()}>
          <p class="mt-2 line-clamp-2 text-sm text-muted">{r().body}</p>
        </Show>
      </div>

      <Show when={props.canWrite}>
        <div class="flex shrink-0 items-center gap-1">
          <button
            type="button"
            class="tg-focus rounded p-1.5 text-muted hover:bg-canvas-subtle hover:text-fg"
            aria-label={`Edit ${r().tag}`}
            title="Edit"
            onClick={() => props.onEdit(r())}
          >
            <Icons.Edit class="h-4 w-4" />
          </button>
          <button
            type="button"
            class="tg-focus rounded p-1.5 text-muted hover:bg-canvas-subtle hover:text-danger"
            aria-label={`Delete ${r().tag}`}
            title="Delete"
            onClick={() => props.onDelete(r())}
          >
            <Icons.Trash class="h-4 w-4" />
          </button>
        </div>
      </Show>
    </div>
  );
}
