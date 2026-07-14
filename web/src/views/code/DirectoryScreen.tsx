import {
  createMemo,
  createResource,
  For,
  Show,
  Suspense,
  type JSX,
} from "solid-js";
import { A, useNavigate } from "@solidjs/router";
import { reposApi } from "../../api/repos.ts";
import { ApiError } from "../../api/client.ts";
import type { TreeEntry } from "../../api/types.ts";
import {
  Banner,
  Box,
  BoxHeader,
  EmptyState,
  Icons,
  LoadingBlock,
  Markdown,
  RelativeTime,
  Sha,
  CodeBlock,
} from "../../ui/index.ts";
import { RefSelector } from "./RefSelector.tsx";
import { CloneMenu } from "./CloneMenu.tsx";
import { PathBreadcrumb } from "./PathBreadcrumb.tsx";
import { CopyButton } from "./CopyButton.tsx";
import {
  blobHref,
  commitsHref,
  commitTitle,
  decodeBase64Utf8,
  extOf,
  findReadme,
  parentPath,
  sortEntries,
  treeHref,
} from "./helpers.ts";

function entryIcon(entry: TreeEntry): JSX.Element {
  if (entry.kind === "tree") return <Icons.Folder class="h-4 w-4 text-accent" />;
  if (entry.kind === "gitlink") return <Icons.Package class="h-4 w-4 text-muted" />;
  const ext = extOf(entry.name);
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs", "go", "rs", "py", "rb", "java", "c", "h", "cpp"].includes(ext)) {
    return <Icons.Code class="h-4 w-4 text-muted" />;
  }
  if (["md", "markdown", "txt", "rst"].includes(ext)) return <Icons.FileText class="h-4 w-4 text-muted" />;
  if (["json", "yaml", "yml", "toml", "ini", "env"].includes(ext)) return <Icons.Settings class="h-4 w-4 text-muted" />;
  if (["png", "jpg", "jpeg", "gif", "svg", "webp", "ico"].includes(ext)) return <Icons.Image class="h-4 w-4 text-muted" />;
  return <Icons.File class="h-4 w-4 text-muted" />;
}

/** The rendered README block below the file listing. */
function ReadmePanel(props: { owner: string; repo: string; refName: string; entry: TreeEntry }): JSX.Element {
  const [blob] = createResource(
    () => [props.owner, props.repo, props.refName, props.entry.path] as const,
    ([o, r, ref, path]) => reposApi.blob(o, r, path, ref).catch(() => null),
  );
  const text = createMemo(() => {
    const b = blob();
    if (!b) return "";
    return b.encoding === "base64" ? decodeBase64Utf8(b.content) : b.content;
  });
  const isMarkdown = () => /\.(md|markdown|mdown)$/i.test(props.entry.name);
  return (
    <Box class="mt-4">
      <BoxHeader class="justify-between">
        <span class="flex items-center gap-2">
          <Icons.FileText class="h-4 w-4 text-muted" /> {props.entry.name}
        </span>
        <A
          href={blobHref(props.owner, props.repo, props.refName, props.entry.path)}
          class="text-xs font-normal text-accent hover:underline"
        >
          View file
        </A>
      </BoxHeader>
      <div class="p-6">
        <Suspense fallback={<LoadingBlock label="Rendering README…" />}>
          <Show when={blob()} fallback={<p class="text-sm text-muted">Could not load {props.entry.name}.</p>}>
            <Show when={isMarkdown()} fallback={<CodeBlock content={text()} wrap />}>
              <Markdown source={text()} />
            </Show>
          </Show>
        </Suspense>
      </div>
    </Box>
  );
}

/** Latest commit that touched the current path, shown above the listing. */
function LatestCommitBar(props: { owner: string; repo: string; refName: string; path: string }): JSX.Element {
  const [latest] = createResource(
    () => [props.owner, props.repo, props.refName, props.path] as const,
    async ([o, r, ref, path]) => {
      const res = await reposApi
        .commits(o, r, { ref, path: path || undefined, limit: 1 })
        .catch(() => null);
      return res?.commits[0] ?? null;
    },
  );
  return (
    <Suspense fallback={null}>
      <Show when={latest()}>
        {(commit) => (
          <div class="flex items-center gap-2 border-b border-border bg-canvas-subtle px-4 py-2 text-xs">
            <Icons.GitCommit class="h-3.5 w-3.5 shrink-0 text-muted" />
            <span class="min-w-0 flex-1 truncate text-fg" title={commit().message}>
              {commitTitle(commit().message)}
            </span>
            <Sha value={commit().sha} />
            <span class="hidden shrink-0 text-muted sm:inline">
              <RelativeTime epochMs={commit().author.date} />
            </span>
          </div>
        )}
      </Show>
    </Suspense>
  );
}

/**
 * The repo overview + directory browser. Renders the ref switcher + clone menu
 * toolbar, an optional path breadcrumb, the latest-commit bar, the file listing,
 * and (for the current directory) a rendered README. Serves both `/:owner/:repo`
 * (root, `path === ""`) and `/tree/:branch/*path`.
 */
export function DirectoryScreen(props: {
  owner: string;
  repo: string;
  refName: string;
  path: string;
  defaultBranch: string;
  cloneUrl: string;
}): JSX.Element {
  const navigate = useNavigate();

  const [tree] = createResource(
    () => [props.owner, props.repo, props.refName, props.path] as const,
    async ([o, r, ref, path]) => {
      try {
        return { data: await reposApi.tree(o, r, { ref, path }), error: null as ApiError | null };
      } catch (err) {
        return { data: null, error: err instanceof ApiError ? err : new ApiError(500, "unknown", "Failed to read tree") };
      }
    },
  );

  const entries = createMemo(() => {
    const t = tree()?.data;
    return t ? sortEntries(t.entries) : [];
  });
  const readmeEntry = createMemo(() => {
    const t = tree()?.data;
    return t ? findReadme(t.entries) : undefined;
  });

  const pickRef = (ref: string) => navigate(treeHref(props.owner, props.repo, ref, props.path));

  return (
    <div class="space-y-4">
      <div class="flex flex-wrap items-center gap-2">
        <RefSelector
          owner={props.owner}
          repo={props.repo}
          currentRef={props.refName}
          defaultBranch={props.defaultBranch}
          onPick={pickRef}
        />
        <Show when={props.path}>
          <PathBreadcrumb
            owner={props.owner}
            repo={props.repo}
            refName={props.refName}
            path={props.path}
            class="min-w-0"
          />
        </Show>
        <div class="ml-auto flex items-center gap-2">
          <A
            href={commitsHref(props.owner, props.repo, props.refName)}
            class="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-canvas-subtle px-3 text-sm text-fg hover:bg-canvas-inset"
          >
            <Icons.Clock class="h-4 w-4 text-muted" />
            <span class="hidden sm:inline">History</span>
          </A>
          <CloneMenu cloneUrl={props.cloneUrl} />
        </div>
      </div>

      <Suspense fallback={<LoadingBlock label="Reading tree…" />}>
        <Show
          when={tree()}
          keyed
          fallback={<LoadingBlock label="Reading tree…" />}
        >
          {(result) => (
            <Show
              when={!result.error}
              fallback={
                <Show
                  when={result.error?.isNotFound}
                  fallback={
                    <Banner tone="danger" title="Could not read this location">
                      {result.error?.message}
                    </Banner>
                  }
                >
                  <Show
                    when={props.path}
                    fallback={
                      <EmptyState
                        icon={<Icons.GitBranch class="h-8 w-8" />}
                        title="This repository is empty"
                        description="Push a first commit over HTTPS to get started."
                        action={
                          <div class="flex items-center gap-2 rounded-md border border-border bg-canvas-subtle px-2 py-1.5">
                            <code class="font-mono text-xs text-fg">git clone {props.cloneUrl}</code>
                            <CopyButton value={`git clone ${props.cloneUrl}`} label="Command" class="h-6 w-6" />
                          </div>
                        }
                      />
                    }
                  >
                    <EmptyState
                      icon={<Icons.Folder class="h-8 w-8" />}
                      title="Path not found"
                      description={
                        <>
                          <code class="font-mono">{props.path}</code> does not exist on{" "}
                          <code class="font-mono">{props.refName}</code>.
                        </>
                      }
                      action={
                        <A href={treeHref(props.owner, props.repo, props.refName)} class="text-accent hover:underline">
                          Back to root
                        </A>
                      }
                    />
                  </Show>
                </Show>
              }
            >
              <div>
                <Box>
                  <LatestCommitBar
                    owner={props.owner}
                    repo={props.repo}
                    refName={props.refName}
                    path={props.path}
                  />
                  <Show when={props.path}>
                    <A
                      href={treeHref(props.owner, props.repo, props.refName, parentPath(props.path))}
                      class="flex items-center gap-2 border-b border-border px-4 py-2.5 text-sm text-muted hover:bg-canvas-subtle"
                    >
                      <Icons.ArrowLeft class="h-4 w-4" /> ..
                    </A>
                  </Show>
                  <Show
                    when={entries().length > 0}
                    fallback={<div class="px-4 py-10 text-center text-sm text-muted">This directory is empty.</div>}
                  >
                    <ul class="divide-y divide-border">
                      <For each={entries()}>
                        {(entry) => (
                          <li>
                            <Show
                              when={entry.kind !== "gitlink"}
                              fallback={
                                <div class="flex items-center gap-2.5 px-4 py-2.5 text-sm">
                                  <span class="shrink-0">{entryIcon(entry)}</span>
                                  <span class="truncate text-fg">{entry.name}</span>
                                  <span class="text-xs text-subtle">@ submodule</span>
                                </div>
                              }
                            >
                              <A
                                href={
                                  entry.kind === "tree"
                                    ? treeHref(props.owner, props.repo, props.refName, entry.path)
                                    : blobHref(props.owner, props.repo, props.refName, entry.path)
                                }
                                class="flex items-center gap-2.5 px-4 py-2.5 text-sm hover:bg-canvas-subtle"
                              >
                                <span class="shrink-0">{entryIcon(entry)}</span>
                                <span class="min-w-0 flex-1 truncate text-fg hover:text-accent hover:underline">
                                  {entry.name}
                                </span>
                              </A>
                            </Show>
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                </Box>

                <Show when={readmeEntry()}>
                  {(entry) => (
                    <ReadmePanel
                      owner={props.owner}
                      repo={props.repo}
                      refName={props.refName}
                      entry={entry()}
                    />
                  )}
                </Show>
              </div>
            </Show>
          )}
        </Show>
      </Suspense>
    </div>
  );
}
