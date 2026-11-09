/**
 * Issues feature entry. The router (see `src/index.tsx`) resolves three exports
 * from this module to repo-scoped routes:
 *
 *   /:owner/:repo/issues          → IssuesView       (list + filters)
 *   /:owner/:repo/issues/new      → NewIssueView     (create form)
 *   /:owner/:repo/issues/:number  → IssueDetailView  (conversation)
 *
 * Each thin wrapper reads the repo owner/name from the shared `useRepo()` shell
 * context (and `:number` from the route params) and hands them to the screen
 * component. All data access is via `issuesApi` (+ best-effort `collaboratorsApi`
 * for assignee candidates); everything renders through the frozen design system.
 */
import { createMemo, Show, type JSX } from "solid-js";
import { useParams } from "@solidjs/router";
import { useRepo } from "../../app/RepoLayout.tsx";
import { IssueList } from "./IssueList.tsx";
import { IssueDetail } from "./IssueDetail.tsx";
import { NewIssueForm } from "./NewIssue.tsx";

/** `/:owner/:repo/issues` — the filterable, paginated issue list. */
export function IssuesView(): JSX.Element {
  const repo = useRepo();
  return <IssueList owner={repo.owner()} repo={repo.repo()} />;
}

/** `/:owner/:repo/issues/:number` — a single issue conversation. */
export function IssueDetailView(): JSX.Element {
  const repo = useRepo();
  const params = useParams();
  // Router reuses this route when only its params change. Give each issue its
  // own state and fixed request scope, including work still awaiting an ACK.
  const identity = createMemo(() => ({
    owner: repo.owner(),
    repo: repo.repo(),
    number: Number(params.number),
  }));
  return (
    <Show when={identity()} keyed>
      {(issue) => (
        <IssueDetail owner={issue.owner} repo={issue.repo} number={issue.number} />
      )}
    </Show>
  );
}

/** `/:owner/:repo/issues/new` — open a new issue. */
export function NewIssueView(): JSX.Element {
  const repo = useRepo();
  const identity = createMemo(() => ({ owner: repo.owner(), repo: repo.repo() }));
  return <Show when={identity()} keyed>{scope => <NewIssueForm owner={scope.owner} repo={scope.repo} />}</Show>;
}
