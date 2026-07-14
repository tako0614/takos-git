/**
 * Pull-requests feature entry. The router lazy-imports these two named exports:
 *
 *   /:owner/:repo/pulls             → PullsView       (list + open/closed filter)
 *   /:owner/:repo/pulls/:number     → PullDetailView  (conversation/commits/…)
 *   /:owner/:repo/pulls/:number/files → PullDetailView (files tab deep-link)
 *
 * Both render inside `RepoLayout` (which supplies `useRepo()` + the PageContainer
 * chrome), so the bodies own only their content. Ported/adapted from the takos
 * worker's PR components; the Takos shell/store/i18n and the AI-review UI are
 * dropped, rebound to takos-git's ui/ + api/ + shell.
 */
import { type JSX } from "solid-js";
import { PRList } from "./PRList.tsx";
import { PRDetail } from "./PRDetail.tsx";

export function PullsView(): JSX.Element {
  return <PRList />;
}

export function PullDetailView(): JSX.Element {
  return <PRDetail />;
}
