import { type JSX } from "solid-js";
import { useParams } from "@solidjs/router";
import { useRepo } from "../../app/RepoLayout.tsx";
import { actionsApi } from "../../api/actions.ts";
import { Seam } from "../_seam.tsx";
import { Probe } from "../_probe.tsx";

export function ActionsView(): JSX.Element {
  const repo = useRepo();
  return (
    <Seam
      feature="Actions"
      summary="Workflows + runs list, run detail with jobs/steps/logs (live WS stream), dispatch/cancel/rerun, artifacts, secrets. Backed by the self-hosted in-worker runner."
      apiModule="actionsApi (api/actions.ts): workflows, runs, run, jobs, job, dispatch, cancel, rerun, secrets, jobLogsUrl, runStreamUrl"
      components={["ActionsTab", "RunsList", "RunDetail", "JobCard", "DispatchWorkflowForm"]}
      routes={["/:owner/:repo/actions", "/:owner/:repo/actions/runs/:runId"]}
    >
      <Probe
        label="Recent runs"
        fetcher={() => actionsApi.runs(repo.owner(), repo.repo())}
        render={(page) => `${page.items.length}${page.nextCursor ? "+" : ""}`}
      />
    </Seam>
  );
}

export function RunDetailView(): JSX.Element {
  const repo = useRepo();
  const params = useParams();
  return (
    <Seam
      feature={`Run ${params.runId}`}
      summary="Run header (status/conclusion), job graph, per-step logs streamed from actionsApi.runStreamUrl, cancel/rerun."
      apiModule="actionsApi.run / jobs / job / jobLogsUrl / runStreamUrl / artifacts"
      components={["RunDetail", "JobCard", "step log viewer (ui/CodeBlock)"]}
      routes={["/:owner/:repo/actions/runs/:runId"]}
    >
      <Probe
        label="Run"
        fetcher={() => actionsApi.run(repo.owner(), repo.repo(), params.runId ?? "")}
        render={(r) => `#${r.run.runNumber} ${r.run.status}`}
      />
    </Seam>
  );
}
