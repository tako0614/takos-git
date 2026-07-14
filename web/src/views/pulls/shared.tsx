/**
 * Small presentational helpers shared across the pull-request screens: principal
 * display names, the open/merged/closed/draft derivation, and state icon/tone
 * mapping. Kept view-local so the frozen ui/ + api/ dirs stay untouched.
 */
import { type JSX } from "solid-js";
import { Icons } from "../../ui/index.ts";
import type { PullRequestDto } from "../../api/types.ts";

/** The common identity shape across `PrincipalLite` and `PrincipalRef`. */
interface NamedPrincipal {
  readonly subject: string;
  readonly displayName: string | null;
}

/** Best-effort display name for a severed principal (never leaks null). */
export function principalName(p: NamedPrincipal | null | undefined): string {
  if (!p) return "ghost";
  return p.displayName?.trim() || p.subject || "ghost";
}

export type PrDisplayState = "open" | "merged" | "closed" | "draft";

/** GitHub's four visible PR states, derived from the DTO booleans. */
export function prDisplayState(
  pr: Pick<PullRequestDto, "state" | "merged" | "draft">,
): PrDisplayState {
  if (pr.merged) return "merged";
  if (pr.state === "closed") return "closed";
  if (pr.draft) return "draft";
  return "open";
}

/** The colored glyph GitHub renders beside a PR title / row. */
export function PrStateIcon(props: {
  state: PrDisplayState;
  class?: string;
}): JSX.Element {
  const cls = props.class ?? "h-4 w-4";
  switch (props.state) {
    case "merged":
      return <Icons.GitMerge class={`${cls} text-done`} />;
    case "closed":
      return <Icons.X class={`${cls} text-danger`} />;
    case "draft":
      return <Icons.GitPullRequest class={`${cls} text-muted`} />;
    default:
      return <Icons.GitPullRequest class={`${cls} text-success`} />;
  }
}

/** Human label for the review verdict states persisted by the server. */
export function reviewStateLabel(state: string): string {
  switch (state) {
    case "approved":
      return "approved these changes";
    case "changes_requested":
      return "requested changes";
    case "commented":
      return "reviewed";
    case "dismissed":
      return "review dismissed";
    default:
      return state.replace(/_/g, " ");
  }
}
