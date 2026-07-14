import { createResource, For, Show, Suspense, type JSX } from "solid-js";
import { useLocation, useParams } from "@solidjs/router";
import { useRepo } from "../../app/RepoLayout.tsx";
import { reposApi } from "../../api/repos.ts";
import { Seam } from "../_seam.tsx";
import {
  Box,
  BoxHeader,
  Icons,
  LoadingBlock,
  Mono,
  Sha,
} from "../../ui/index.ts";

/**
 * Code tab placeholder. Serves the whole code browser route family; a 4b agent
 * replaces the body with the ported FileTree / FileViewer / CommitList /
 * PRDiffView components while keeping `useRepo()` + `reposApi` as the seam.
 */
export function CodeView(): JSX.Element {
  const repo = useRepo();
  const params = useParams();
  const loc = useLocation();

  // The active sub-route (for the placeholder header). 4b splits these into
  // dedicated views; here one view proves each route resolves + data is live.
  const mode = (): string => {
    if (params.sha) return `commit ${params.sha.slice(0, 7)}`;
    if (params.spec) return `compare ${decodeURIComponent(params.spec)}`;
    if (loc.pathname.includes("/blob/")) return `blob ${params.path ?? ""}`;
    if (loc.pathname.includes("/commits")) return "commit history";
    if (loc.pathname.includes("/tree/")) return `tree ${params.path ?? ""}`;
    return "code";
  };

  const branch = () => params.branch || repo.detail()?.defaultBranch || "main";
  const [tree] = createResource(
    () => [repo.owner(), repo.repo(), branch(), params.path ?? ""] as const,
    ([o, r, b, p]) => reposApi.tree(o, r, { ref: b, path: p }).catch(() => null),
  );

  return (
    <Seam
      feature="Code browser"
      summary={`Active route: ${mode()} on ${repo.owner()}/${repo.repo()} @ ${branch()}. Port the takos code-browser components into web/src/views/code/.`}
      apiModule="reposApi (api/repos.ts): tree, blob, commits, commit, compare, branches, tags, rawUrl"
      components={[
        "RepoDetailFiles / RepoDetailReadme",
        "FileTree",
        "FileViewer / CodeViewer / FileContentRenderer",
        "CommitList",
        "BranchesTab",
        "PRDiffView (reused for /commit/:sha)",
      ]}
      routes={[
        "/:owner/:repo",
        "/:owner/:repo/tree/:branch/*path",
        "/:owner/:repo/blob/:branch/*path",
        "/:owner/:repo/commits/:branch?",
        "/:owner/:repo/commit/:sha",
        "/:owner/:repo/compare/*spec",
      ]}
    >
      <Suspense fallback={<LoadingBlock label="Reading tree…" />}>
        <Show
          when={tree()}
          fallback={<p class="text-sm text-muted">Empty repository or unreadable tree.</p>}
        >
          {(t) => (
            <div class="space-y-2 text-sm">
              <div class="flex items-center gap-2 text-muted">
                <Icons.GitBranch class="h-4 w-4" /> <Mono>{t().branch}</Mono>
                <Sha value={t().commit} />
              </div>
              <ul class="divide-y divide-border rounded border border-border">
                <For each={t().entries.slice(0, 8)}>
                  {(entry) => (
                    <li class="flex items-center gap-2 px-3 py-1.5">
                      <Show when={entry.kind === "tree"} fallback={<Icons.File class="h-4 w-4 text-muted" />}>
                        <Icons.Folder class="h-4 w-4 text-accent" />
                      </Show>
                      <span class="font-mono text-xs">{entry.name}</span>
                    </li>
                  )}
                </For>
              </ul>
              <Show when={t().entries.length > 8}>
                <p class="text-xs text-subtle">+{t().entries.length - 8} more entries</p>
              </Show>
            </div>
          )}
        </Show>
      </Suspense>
    </Seam>
  );
}

/** A standalone commit/compare diff placeholder (also reachable inside CodeView). */
export function CommitView(): JSX.Element {
  const repo = useRepo();
  const params = useParams();
  return (
    <Box>
      <BoxHeader>
        <Icons.GitCommit class="h-4 w-4" /> Commit {params.sha?.slice(0, 7)} — {repo.owner()}/{repo.repo()}
      </BoxHeader>
      <div class="p-4 text-sm text-muted">
        Phase 4b renders the ported <code>PRDiffView</code> here from{" "}
        <code>reposApi.commit()</code> / <code>reposApi.compare()</code>.
      </div>
    </Box>
  );
}
