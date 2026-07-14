import { type JSX } from "solid-js";
import { useParams } from "@solidjs/router";
import { useRepo } from "../../app/RepoLayout.tsx";
import { issuesApi } from "../../api/issues.ts";
import { Seam } from "../_seam.tsx";
import { Probe } from "../_probe.tsx";

const COMPONENTS = ["IssueList (fresh)", "IssueDetail + comments (fresh)", "NewIssueForm", "LabelPicker / MilestonePicker", "Markdown (ui) for bodies"];

export function IssuesView(): JSX.Element {
  const repo = useRepo();
  return (
    <Seam
      feature="Issues"
      summary="List + filter issues (state/label/assignee/milestone), open and edit. Issues are built fresh (no Takos source)."
      apiModule="issuesApi (api/issues.ts): list, get, comments, labels, milestones, create, update, comment"
      components={COMPONENTS}
      routes={["/:owner/:repo/issues", "/:owner/:repo/issues/:number", "/:owner/:repo/issues/new"]}
    >
      <Probe
        label="Open issues"
        fetcher={() => issuesApi.list(repo.owner(), repo.repo(), { state: "open" })}
        render={(page) => `${page.items.length}${page.nextCursor ? "+" : ""}`}
      />
    </Seam>
  );
}

export function IssueDetailView(): JSX.Element {
  const repo = useRepo();
  const params = useParams();
  return (
    <Seam
      feature={`Issue #${params.number}`}
      summary="Issue conversation: title/body (Markdown), labels, assignees, milestone, comment thread, close/reopen."
      apiModule="issuesApi.get / issuesApi.comments / issuesApi.comment / issuesApi.update"
      components={COMPONENTS}
      routes={["/:owner/:repo/issues/:number"]}
    >
      <Probe
        label={`Issue #${params.number}`}
        fetcher={() => issuesApi.get(repo.owner(), repo.repo(), Number(params.number))}
        render={(r) => r.issue.title}
      />
    </Seam>
  );
}

export function NewIssueView(): JSX.Element {
  return (
    <Seam
      feature="New issue"
      summary="Title + Markdown body + labels/assignees/milestone, POST to create."
      apiModule="issuesApi.create"
      components={["NewIssueForm", "Field / TextInput / Textarea (ui)", "Markdown preview"]}
      routes={["/:owner/:repo/issues/new"]}
    />
  );
}
