import { createResource, Show, type JSX } from "solid-js";
import {
  ApiError,
  releasesApi,
  type ReleaseDto,
} from "../../api";
import {
  Avatar,
  Banner,
  Box,
  Button,
  EmptyState,
  Icons,
  Label,
  LoadingBlock,
  Markdown,
  RelativeTime,
  Sha,
  useConfirmDialog,
  useToast,
} from "../../ui";
import { ReleaseAssets } from "./ReleaseAssets.tsx";
import { releaseTitle } from "./helpers.ts";

interface ReleaseDetailProps {
  owner: string;
  repo: string;
  tag: string;
  canWrite: boolean;
  /** Bump to force a refetch (e.g. after an edit committed by the parent). */
  reloadKey: number;
  onBack: () => void;
  onEdit: (release: ReleaseDto) => void;
  onDeleted: () => void;
}

/** A single release: header (badges + metadata), Markdown notes, and assets. */
export function ReleaseDetail(props: ReleaseDetailProps): JSX.Element {
  const toast = useToast();
  const { confirm } = useConfirmDialog();

  const [release, { refetch }] = createResource(
    () => [props.owner, props.repo, props.tag, props.reloadKey] as const,
    ([owner, repo, tag]) => releasesApi.get(owner, repo, tag).then((r) => r.release),
  );

  const remove = async (r: ReleaseDto) => {
    const ok = await confirm({
      title: "Delete release",
      message: `Delete the release for ${r.tag}? The git tag itself is kept. This cannot be undone.`,
      confirmText: "Delete release",
      danger: true,
    });
    if (!ok) return;
    try {
      await releasesApi.remove(props.owner, props.repo, r.tag);
      toast.success("Release deleted.");
      props.onDeleted();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to delete the release.");
    }
  };

  return (
    <div class="flex flex-col gap-4">
      <button
        type="button"
        class="tg-focus inline-flex w-fit items-center gap-1 rounded text-sm text-accent hover:underline"
        onClick={() => props.onBack()}
      >
        <Icons.ArrowLeft class="h-4 w-4" /> All releases
      </button>

      <Show
        when={!release.loading || release.latest}
        fallback={<LoadingBlock label="Loading release…" />}
      >
        <Show
          when={!release.error}
          fallback={
            <Show
              when={release.error instanceof ApiError && release.error.isNotFound}
              fallback={
                <Banner
                  tone="danger"
                  title="Couldn't load this release"
                  action={<Button size="sm" onClick={() => void refetch()}>Retry</Button>}
                >
                  {release.error instanceof Error ? release.error.message : "Unknown error."}
                </Banner>
              }
            >
              <EmptyState
                icon={<Icons.Tag class="h-8 w-8" />}
                title="Release not found"
                description={`No release is tagged ${props.tag} in this repository.`}
                action={<Button onClick={() => props.onBack()}>Back to releases</Button>}
              />
            </Show>
          }
        >
          <Show when={release.latest}>
            {(r) => (
              <>
                <div class="flex flex-wrap items-start justify-between gap-3">
                  <div class="min-w-0">
                    <div class="flex flex-wrap items-center gap-2">
                      <h1 class="text-xl font-semibold text-fg">{releaseTitle(r())}</h1>
                      <Show when={r().isDraft}>
                        <Label tone="default">Draft</Label>
                      </Show>
                      <Show when={r().isPrerelease}>
                        <Label tone="attention">Pre-release</Label>
                      </Show>
                    </div>
                    <div class="mt-2 flex flex-wrap items-center gap-3 text-sm text-muted">
                      <span class="inline-flex items-center gap-1">
                        <Icons.Tag class="h-4 w-4" />
                        <span class="font-mono">{r().tag}</span>
                      </span>
                      <Show when={r().targetSha}>
                        {(sha) => (
                          <span class="inline-flex items-center gap-1">
                            <Icons.GitCommit class="h-4 w-4" />
                            <Sha value={sha()} />
                          </span>
                        )}
                      </Show>
                      <Show when={r().author}>
                        {(author) => (
                          <span class="inline-flex items-center gap-1.5">
                            <Avatar name={author().displayName || author().subject} size={18} />
                            {author().displayName || author().subject}
                          </span>
                        )}
                      </Show>
                      <span>
                        {r().isDraft ? "created " : "released "}
                        <RelativeTime epochMs={r().publishedAt ?? r().createdAt} />
                      </span>
                    </div>
                  </div>

                  <Show when={props.canWrite}>
                    <div class="flex shrink-0 items-center gap-2">
                      <Button size="sm" onClick={() => props.onEdit(r())}>
                        <Icons.Edit class="h-4 w-4" /> Edit
                      </Button>
                      <Button size="sm" variant="danger" onClick={() => void remove(r())}>
                        <Icons.Trash class="h-4 w-4" /> Delete
                      </Button>
                    </div>
                  </Show>
                </div>

                <Box class="p-5">
                  <Markdown source={r().body} />
                </Box>

                <ReleaseAssets
                  owner={props.owner}
                  repo={props.repo}
                  tag={r().tag}
                  assets={r().assets}
                  canWrite={props.canWrite}
                  onChanged={() => void refetch()}
                />
              </>
            )}
          </Show>
        </Show>
      </Show>
    </div>
  );
}
