import { type JSX } from "solid-js";
import { useParams } from "@solidjs/router";
import { useRepo } from "../../app/RepoLayout.tsx";
import { pullsApi } from "../../api/pulls.ts";
import { Seam } from "../_seam.tsx";
import { Probe } from "../_probe.tsx";

const COMPONENTS = [
  "PRList",
  "PRDetail / PRHeader / PRActions / PRComments",
  "PRDiffView (ui/DiffView)",
  "ConflictResolver",
  "review submit + inline comments",
];

export function PullsView(): JSX.Element {
  const repo = useRepo();
  return (
    <Seam
      feature="Pull requests"
      summary="List + filter PRs, open detail with diff/files/commits/reviews, merge (merge/squash/rebase) honoring branch protection. Ported from takos, AI-review dropped."
      apiModule="pullsApi (api/pulls.ts): list, get, diff, files, commits, reviews, merge, review, comment, conflicts, resolve"
      components={COMPONENTS}
      routes={["/:owner/:repo/pulls", "/:owner/:repo/pulls/:number", "/:owner/:repo/pulls/:number/files"]}
    >
      <Probe
        label="Open pull requests"
        fetcher={() => pullsApi.list(repo.owner(), repo.repo(), { state: "open" })}
        render={(page) => `${page.items.length}${page.nextCursor ? "+" : ""}`}
      />
    </Seam>
  );
}

export function PullDetailView(): JSX.Element {
  const repo = useRepo();
  const params = useParams();
  return (
    <Seam
      feature={`Pull request #${params.number}`}
      summary="Conversation + diff/files/commits/reviews tabs, mergeability, merge/close/reopen, inline review comments anchored to the DiffView."
      apiModule="pullsApi.get / diff / files / reviews / merge / review / comment"
      components={COMPONENTS}
      routes={["/:owner/:repo/pulls/:number"]}
    >
      <Probe
        label={`PR #${params.number}`}
        fetcher={() => pullsApi.get(repo.owner(), repo.repo(), Number(params.number))}
        render={(r) => `${r.pull.title} (${r.pull.state})`}
      />
    </Seam>
  );
}
