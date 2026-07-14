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
import { type JSX } from "solid-js";
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
  return (
    <IssueDetail
      owner={repo.owner()}
      repo={repo.repo()}
      number={Number(params.number)}
    />
  );
}

/** `/:owner/:repo/issues/new` — open a new issue. */
export function NewIssueView(): JSX.Element {
  const repo = useRepo();
  return <NewIssueForm owner={repo.owner()} repo={repo.repo()} />;
}
