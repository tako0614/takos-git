import {
  createMemo,
  createResource,
  createSignal,
  Index,
  Show,
  Suspense,
  type JSX,
} from "solid-js";
import { A } from "@solidjs/router";
import { reposApi } from "../../api/repos.ts";
import { ApiError } from "../../api/client.ts";
import {
  Banner,
  Box,
  Button,
  CodeBlock,
  EmptyState,
  Icons,
  LoadingBlock,
  Spinner,
} from "../../ui/index.ts";
import { cn } from "../../lib/cn.ts";
import { PathBreadcrumb } from "./PathBreadcrumb.tsx";
import { CopyButton } from "./CopyButton.tsx";
import { fetchBlame, type BlameLine } from "./blame.ts";
import {
  commitsHref,
  decodeBase64Utf8,
  formatBytes,
  isImagePath,
  lineCount,
  looksBinary,
  mimeForName,
  treeHref,
} from "./helpers.ts";

/** Blame gutter: one row per line, commit chip shown when the commit changes. */
function BlameView(props: { lines: readonly BlameLine[] }): JSX.Element {
  return (
    <div class="overflow-x-auto rounded-md border border-border bg-canvas font-mono text-xs leading-5">
      <table class="w-full border-collapse">
        <tbody>
          <Index each={props.lines}>
            {(line, index) => {
              const prev = () => (index > 0 ? props.lines[index - 1] : undefined);
              const showCommit = () => prev()?.commitSha !== line().commitSha;
              const dateLabel = () => {
                const d = line().date;
                if (!d) return "";
                const parsed = new Date(d);
                return Number.isNaN(parsed.getTime()) ? "" : parsed.toLocaleDateString();
              };
              return (
                <tr class="hover:bg-canvas-subtle">
                  <td
                    class="max-w-[16rem] select-none truncate border-r border-border px-2 align-top text-subtle"
                    style={{ width: "1%" }}
                    title={`${line().commitSha.slice(0, 8)} · ${line().authorName} · ${line().message.split("\n")[0]}`}
                  >
                    <Show when={showCommit()}>
                      <span class="inline-flex items-center gap-1.5">
                        <span class="rounded bg-neutral-muted px-1 text-[10px] text-muted">
                          {line().commitSha.slice(0, 7)}
                        </span>
                        <span class="truncate text-muted">{line().authorName}</span>
                        <span class="shrink-0 text-subtle">{dateLabel()}</span>
                      </span>
                    </Show>
                  </td>
                  <td
                    class="select-none border-r border-border px-3 text-right align-top text-subtle"
                    style={{ width: "1%" }}
                  >
                    {line().line}
                  </td>
                  <td class="whitespace-pre px-3 align-top">{line().content || " "}</td>
                </tr>
              );
            }}
          </Index>
        </tbody>
      </table>
    </div>
  );
}

/**
 * Blob viewer. Loads a ≤1 MiB blob and renders it as source (line-numbered
 * `CodeBlock`), an inline image (`data:` URI from the blob's own bytes), or a
 * binary/too-large placeholder. Provides copy / client-side download / blame
 * affordances and a per-file history link. (The worker exposes no streamed raw
 * route, so raw/image/download are all served from the in-memory blob.)
 */
export function BlobScreen(props: {
  owner: string;
  repo: string;
  refName: string;
  path: string;
  defaultBranch: string;
}): JSX.Element {
  const [blameOn, setBlameOn] = createSignal(false);

  const fileName = () => props.path.split("/").pop() ?? props.path;

  const [blob] = createResource(
    () => [props.owner, props.repo, props.refName, props.path] as const,
    async ([o, r, ref, path]) => {
      try {
        return { data: await reposApi.blob(o, r, path, ref), error: null as ApiError | null };
      } catch (err) {
        return { data: null, error: err instanceof ApiError ? err : new ApiError(500, "unknown", "Failed to read file") };
      }
    },
  );

  const decoded = createMemo(() => {
    const b = blob()?.data;
    if (!b) return "";
    return b.encoding === "base64" ? decodeBase64Utf8(b.content) : b.content;
  });

  const isImage = () => isImagePath(fileName());
  const isBinary = createMemo(() => {
    const b = blob()?.data;
    if (!b || isImage()) return false;
    return b.encoding === "base64" || looksBinary(decoded());
  });
  const isText = () => !!blob()?.data && !isImage() && !isBinary();

  const [blame] = createResource(
    () => (blameOn() && isText() ? ([props.owner, props.repo, props.refName, props.path] as const) : false),
    ([o, r, ref, path]) => fetchBlame(o, r, path, ref),
  );

  const tooLarge = () => blob()?.error?.code === "blob_too_large";

  // Images render from the blob's own bytes as a `data:` URI (CSP allows
  // `img-src 'self' data:`) — the worker exposes no streamed raw route.
  const imageDataUri = createMemo(() => {
    const b = blob()?.data;
    if (!b || !isImage()) return "";
    const b64 = b.encoding === "base64" ? b.content : btoa(unescape(encodeURIComponent(b.content)));
    return `data:${mimeForName(fileName())};base64,${b64}`;
  });

  /** Client-side download (no raw endpoint) from the in-memory ≤1 MiB blob. */
  const download = () => {
    const b = blob()?.data;
    if (!b) return;
    let bytes: Uint8Array;
    if (b.encoding === "base64") {
      const bin = atob(b.content);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    } else {
      bytes = new TextEncoder().encode(b.content);
    }
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeForName(fileName()) }));
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName();
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div class="space-y-4">
      <div class="flex flex-wrap items-center gap-2">
        <A
          href={treeHref(props.owner, props.repo, props.refName)}
          class="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-canvas-subtle px-3 text-sm text-fg hover:bg-canvas-inset"
        >
          <Icons.GitBranch class="h-4 w-4 text-muted" />
          <span class="font-mono">{props.refName}</span>
        </A>
        <PathBreadcrumb
          owner={props.owner}
          repo={props.repo}
          refName={props.refName}
          path={props.path}
          isFile
          class="min-w-0"
        />
      </div>

      <Suspense fallback={<LoadingBlock label="Loading file…" />}>
        <Show when={blob()} keyed fallback={<LoadingBlock label="Loading file…" />}>
          {(result) => (
            <Show
              when={result.data}
              fallback={
                <Show
                  when={tooLarge()}
                  fallback={
                    <Show
                      when={result.error?.isNotFound}
                      fallback={
                        <Banner tone="danger" title="Could not load this file">
                          {result.error?.message}
                        </Banner>
                      }
                    >
                      <EmptyState
                        icon={<Icons.File class="h-8 w-8" />}
                        title="File not found"
                        description={<code class="font-mono">{props.path}</code>}
                      />
                    </Show>
                  }
                >
                  <Box>
                    <div class="flex flex-col items-center gap-3 px-6 py-12 text-center">
                      <Icons.File class="h-8 w-8 text-subtle" />
                      <p class="text-sm text-muted">
                        This file is too large to display in the browser (over 1 MiB).
                      </p>
                      <p class="text-xs text-subtle">Clone the repository to view it locally.</p>
                    </div>
                  </Box>
                </Show>
              }
            >
              {(data) => (
                <Box>
                  {/* Toolbar */}
                  <div class="flex flex-wrap items-center gap-2 border-b border-border bg-canvas-subtle px-3 py-2 text-xs">
                    <span class="text-muted">
                      <Show when={isText()} fallback={formatBytes(data().size)}>
                        {lineCount(decoded())} lines · {formatBytes(data().size)}
                      </Show>
                    </span>
                    <div class="ml-auto flex items-center gap-1">
                      <Show when={isText()}>
                        <Button
                          size="sm"
                          variant={blameOn() ? "primary" : "default"}
                          onClick={() => setBlameOn((v) => !v)}
                          aria-pressed={blameOn()}
                          title="Toggle blame"
                        >
                          <Icons.Users class="h-3.5 w-3.5" /> Blame
                        </Button>
                        <A
                          href={`${commitsHref(props.owner, props.repo, props.refName)}?path=${encodeURIComponent(props.path)}`}
                          class="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-canvas-subtle px-2.5 text-xs text-fg hover:bg-canvas-inset"
                        >
                          <Icons.Clock class="h-3.5 w-3.5 text-muted" /> History
                        </A>
                        <CopyButton
                          value={decoded()}
                          label="File contents"
                          title="Copy file contents"
                          class="h-7 w-7 border border-border bg-canvas-subtle hover:bg-canvas-inset"
                        />
                      </Show>
                      <button
                        type="button"
                        onClick={download}
                        class="tg-focus inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-canvas-subtle text-fg hover:bg-canvas-inset"
                        title="Download"
                        aria-label="Download file"
                      >
                        <Icons.Download class="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* Body */}
                  <div class="p-0">
                    <Show
                      when={isImage()}
                      fallback={
                        <Show
                          when={isText()}
                          fallback={
                            <div class="flex flex-col items-center gap-3 px-6 py-12 text-center">
                              <Icons.File class="h-8 w-8 text-subtle" />
                              <p class="text-sm text-muted">Binary file not shown.</p>
                              <button type="button" onClick={download} class="text-accent hover:underline">
                                Download file
                              </button>
                            </div>
                          }
                        >
                          <Show
                            when={blameOn()}
                            fallback={<CodeBlock class="rounded-none border-0" content={decoded()} />}
                          >
                            <Suspense fallback={<div class="flex justify-center py-8"><Spinner label="Loading blame" /></div>}>
                              <Show
                                when={blame()}
                                fallback={
                                  <Show when={blame.error}>
                                    <div class="px-4 py-6 text-center text-sm text-muted">
                                      Blame is unavailable for this file.
                                    </div>
                                  </Show>
                                }
                              >
                                {(b) => <div class={cn("p-0")}><BlameView lines={b().lines} /></div>}
                              </Show>
                            </Suspense>
                          </Show>
                        </Show>
                      }
                    >
                      <div class="flex justify-center bg-canvas-subtle p-6">
                        {/* Rendered from the blob's own bytes via a data: URI (CSP: img-src 'self' data:). */}
                        <img
                          src={imageDataUri()}
                          alt={fileName()}
                          class="max-h-[70vh] max-w-full rounded border border-border bg-canvas"
                        />
                      </div>
                    </Show>
                  </div>
                </Box>
              )}
            </Show>
          )}
        </Show>
      </Suspense>
    </div>
  );
}
