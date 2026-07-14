/**
 * Code browser view family.
 *
 * The router points the whole code-browser route set at two exports:
 *   - `CodeView`   → `/:owner/:repo`, `/tree/:branch/*path`,
 *                    `/blob/:branch/*path`, `/commits/:branch?`, `/compare/*spec`
 *   - `CommitView` → `/:owner/:repo/commit/:sha`
 *
 * `CodeView` is a thin dispatcher: it derives the active mode from the location
 * and renders the matching screen, threading the repo owner/name (from
 * `useRepo()`), the resolved ref, and the path/spec through as REACTIVE props
 * (Solid compiles `foo={sig()}` prop expressions into getters, so screens stay
 * live as the params change without remounting). Every screen owns its own
 * `createResource` + loading/empty/error states and talks only to `reposApi`
 * (plus the local `blame` wrapper), keeping the frozen shell/ui/api seam intact.
 */
import { createMemo, Match, Switch, type JSX } from "solid-js";
import { useLocation, useParams } from "@solidjs/router";
import { useRepo } from "../../app/RepoLayout.tsx";
import { DirectoryScreen } from "./DirectoryScreen.tsx";
import { BlobScreen } from "./BlobScreen.tsx";
import { CommitsScreen } from "./CommitsScreen.tsx";
import { CompareScreen } from "./CompareScreen.tsx";
import { CommitDetailScreen } from "./CommitDetailScreen.tsx";

export function CodeView(): JSX.Element {
  const repo = useRepo();
  const params = useParams();
  const loc = useLocation();

  const owner = () => repo.owner();
  const name = () => repo.repo();
  const defaultBranch = () => repo.detail()?.defaultBranch || "main";
  const cloneUrl = () => repo.detail()?.cloneUrl || "";
  const branch = () => params.branch || defaultBranch();
  const treePath = () => params.path || "";
  const spec = () => params.spec || "";

  const mode = createMemo<"blob" | "compare" | "commits" | "dir">(() => {
    const p = loc.pathname;
    if (p.includes("/blob/")) return "blob";
    if (p.includes("/compare/")) return "compare";
    if (p.includes("/commits")) return "commits";
    return "dir"; // overview (path === "") + tree browsing
  });

  return (
    <Switch fallback={
      <DirectoryScreen
        owner={owner()}
        repo={name()}
        refName={branch()}
        path={treePath()}
        defaultBranch={defaultBranch()}
        cloneUrl={cloneUrl()}
      />
    }>
      <Match when={mode() === "blob"}>
        <BlobScreen
          owner={owner()}
          repo={name()}
          refName={branch()}
          path={treePath()}
          defaultBranch={defaultBranch()}
        />
      </Match>
      <Match when={mode() === "compare"}>
        <CompareScreen owner={owner()} repo={name()} spec={spec()} />
      </Match>
      <Match when={mode() === "commits"}>
        <CommitsScreen
          owner={owner()}
          repo={name()}
          refName={branch()}
          defaultBranch={defaultBranch()}
        />
      </Match>
    </Switch>
  );
}

/** Standalone commit detail (`/:owner/:repo/commit/:sha`). */
export function CommitView(): JSX.Element {
  const repo = useRepo();
  const params = useParams();
  return <CommitDetailScreen owner={repo.owner()} repo={repo.repo()} sha={params.sha || ""} />;
}
