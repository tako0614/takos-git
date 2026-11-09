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
import { useSession } from "../../store/session.tsx";
import { useSubmissionScope } from "../../lib/submission-scope.ts";
import { Banner } from "../../ui/index.ts";
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
  const repo = useRepo(), session = useSession(), scope = useSubmissionScope();
  const identity = createMemo(() => scope() ?? (!session.authenticated()
    ? { owner: repo.owner(), repo: repo.repo(), repositoryId: "", recoveryScope: "" } : null));
  return <Show when={identity()} keyed fallback={<Banner tone="warning">Safe Issue recovery is unavailable. Refresh after the server has been updated.</Banner>}>
    {context => <NewIssueForm owner={context.owner} repo={context.repo} repositoryId={context.repositoryId} recoveryScope={context.recoveryScope} />}
  </Show>;
}
