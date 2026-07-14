import { createResource, For, Show, type JSX } from "solid-js";
import { Box, BoxHeader, Icons, RelativeTime, Spinner } from "../../ui/index.ts";
import { actionsApi } from "../../api/actions.ts";
import type { WorkflowArtifactDto } from "../../api/types.ts";

function formatBytes(bytes: number | null): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`;
}

/** Artifacts produced by a run, each a same-origin download link. */
export function ArtifactsList(props: {
  owner: string;
  repo: string;
  runId: string;
}): JSX.Element {
  const [artifacts] = createResource(
    () => [props.owner, props.repo, props.runId] as const,
    ([o, r, id]) => actionsApi.artifacts(o, r, id),
  );

  return (
    <Box>
      <BoxHeader>
        <Icons.Package class="h-4 w-4" /> Artifacts
        <Show when={artifacts()?.items.length}>
          <span class="ml-1 text-xs font-normal text-muted">{artifacts()!.items.length}</span>
        </Show>
      </BoxHeader>

      <Show
        when={!artifacts.loading}
        fallback={
          <div class="flex items-center gap-2 px-4 py-4 text-sm text-muted">
            <Spinner size={14} /> Loading artifacts…
          </div>
        }
      >
        <Show
          when={(artifacts()?.items.length ?? 0) > 0}
          fallback={<div class="px-4 py-6 text-center text-sm text-muted">No artifacts were uploaded by this run.</div>}
        >
          <ul class="divide-y divide-border">
            <For each={artifacts()!.items}>
              {(artifact: WorkflowArtifactDto) => (
                <li class="flex items-center justify-between gap-3 px-4 py-3">
                  <div class="min-w-0">
                    <a
                      href={actionsApi.artifactDownloadUrl(props.owner, props.repo, artifact.id)}
                      class="tg-focus inline-flex items-center gap-2 truncate text-sm font-medium text-accent hover:underline"
                      rel="noopener"
                    >
                      <Icons.Archive class="h-4 w-4 shrink-0" />
                      <span class="truncate">{artifact.name}</span>
                    </a>
                    <div class="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-muted">
                      <span>{formatBytes(artifact.sizeBytes)}</span>
                      <span>
                        uploaded <RelativeTime epochMs={artifact.createdAt} />
                      </span>
                      <Show when={artifact.expiresAt}>
                        <span>
                          expires <RelativeTime epochMs={artifact.expiresAt} />
                        </span>
                      </Show>
                    </div>
                  </div>
                  <a
                    href={actionsApi.artifactDownloadUrl(props.owner, props.repo, artifact.id)}
                    class="tg-focus inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-canvas-subtle px-2.5 py-1 text-xs font-medium text-fg hover:bg-canvas-inset"
                    rel="noopener"
                    aria-label={`Download ${artifact.name}`}
                  >
                    <Icons.Download class="h-3.5 w-3.5" /> Download
                  </a>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Show>
    </Box>
  );
}
