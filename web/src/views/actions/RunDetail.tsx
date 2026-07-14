import {
  createEffect,
  createResource,
  createSignal,
  Index,
  onCleanup,
  Show,
  type JSX,
} from "solid-js";
import { useNavigate } from "@solidjs/router";
import {
  Avatar,
  Banner,
  Box,
  Button,
  EmptyState,
  Icons,
  Link,
  LoadingBlock,
  RelativeTime,
  Sha,
  useConfirmDialog,
  useToast,
} from "../../ui/index.ts";
import { actionsApi } from "../../api/actions.ts";
import { ApiError } from "../../api/client.ts";
import { RunStatusBadge } from "./StatusBadge.tsx";
import { JobCard } from "./JobCard.tsx";
import { ArtifactsList } from "./ArtifactsList.tsx";
import { formatDuration, isTerminal, runIsLive, shortRef } from "./helpers.tsx";
import type { WorkflowJobDto, WorkflowRunDto } from "../../api/types.ts";

const POLL_MS = 5000;

/** Full run detail: header, job graph, per-job steps/logs, artifacts. */
export function RunDetail(props: {
  owner: string;
  repo: string;
  runId: string;
}): JSX.Element {
  const toast = useToast();
  const { confirm } = useConfirmDialog();
  const navigate = useNavigate();
  const [busy, setBusy] = createSignal<null | "cancel" | "rerun">(null);

  const key = () => [props.owner, props.repo, props.runId] as const;

  const [runRes, { refetch: refetchRun, mutate: mutateRun }] = createResource(
    key,
    async ([o, r, id]) => (await actionsApi.run(o, r, id)).run,
  );
  const [jobsRes, { refetch: refetchJobs }] = createResource(
    key,
    async ([o, r, id]) => (await actionsApi.jobs(o, r, id)).items,
  );

  const run = (): WorkflowRunDto | undefined => runRes.latest;
  const jobs = (): readonly WorkflowJobDto[] => jobsRes.latest ?? [];
  const notFound = () => runRes.error instanceof ApiError && runRes.error.isNotFound;

  // Poll while the run is live.
  let timer: ReturnType<typeof setInterval> | undefined;
  createEffect(() => {
    const r = run();
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    if (r && runIsLive(r)) {
      timer = setInterval(() => {
        void refetchRun();
        void refetchJobs();
      }, POLL_MS);
    }
  });
  onCleanup(() => {
    if (timer) clearInterval(timer);
  });

  const refetchAll = () => {
    void refetchRun();
    void refetchJobs();
  };

  const doRerun = async () => {
    setBusy("rerun");
    try {
      const res = await actionsApi.rerun(props.owner, props.repo, props.runId);
      toast.success("Re-run queued");
      const newId = res.run?.id;
      if (newId && newId !== props.runId) {
        navigate(`/${props.owner}/${props.repo}/actions/runs/${newId}`);
      } else {
        if (res.run) mutateRun(res.run);
        refetchAll();
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to re-run");
    } finally {
      setBusy(null);
    }
  };

  const doCancel = async () => {
    const ok = await confirm({
      title: "Cancel workflow run",
      message: "This stops the run and any in-progress jobs. This can't be undone.",
      confirmText: "Cancel run",
      cancelText: "Keep running",
      danger: true,
    });
    if (!ok) return;
    setBusy("cancel");
    try {
      const res = await actionsApi.cancel(props.owner, props.repo, props.runId);
      toast.success("Run cancelled");
      if (res.run) mutateRun(res.run);
      refetchAll();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to cancel run");
    } finally {
      setBusy(null);
    }
  };

  const title = () => {
    const r = run();
    if (!r) return "";
    return r.workflowPath.split("/").pop() ?? r.workflowPath;
  };

  return (
    <div class="flex flex-col gap-4">
      <div>
        <Link href={`/${props.owner}/${props.repo}/actions`} class="inline-flex items-center gap-1 text-sm">
          <Icons.ArrowLeft class="h-4 w-4" /> All workflows
        </Link>
      </div>

      <Show
        when={!notFound()}
        fallback={
          <EmptyState
            icon={<Icons.AlertTriangle class="h-8 w-8" />}
            title="Run not found"
            description="This workflow run doesn't exist or is no longer visible to you."
          />
        }
      >
        <Show when={run()} fallback={<LoadingBlock label="Loading run…" />}>
          {(r) => (
            <>
              <Box class="p-4">
                <div class="flex flex-wrap items-start justify-between gap-3">
                  <div class="min-w-0">
                    <div class="flex flex-wrap items-center gap-2">
                      <h1 class="text-lg font-semibold text-fg">{title()}</h1>
                      <span class="text-sm text-muted">#{r().runNumber}</span>
                      <RunStatusBadge status={r().status} conclusion={r().conclusion} />
                      <Show when={r().runAttempt > 1}>
                        <span class="text-xs text-muted">attempt {r().runAttempt}</span>
                      </Show>
                    </div>
                    <div class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
                      <span class="inline-flex items-center gap-1">
                        <Icons.Zap class="h-3.5 w-3.5" /> {r().event}
                      </span>
                      <Show when={shortRef(r().ref)}>
                        <span class="inline-flex items-center gap-1">
                          <Icons.GitBranch class="h-3.5 w-3.5" /> {shortRef(r().ref)}
                        </span>
                      </Show>
                      <Show when={r().sha}>
                        {(sha) => (
                          <span class="inline-flex items-center gap-1">
                            <Icons.GitCommit class="h-3.5 w-3.5" /> <Sha value={sha()} />
                          </span>
                        )}
                      </Show>
                      <Show when={r().actor}>
                        {(actor) => (
                          <span class="inline-flex items-center gap-1">
                            <Avatar name={actor().displayName ?? actor().subject} src={actor().avatarUrl} size={16} />
                            {actor().displayName ?? actor().subject}
                          </span>
                        )}
                      </Show>
                      <span class="inline-flex items-center gap-1">
                        <Icons.Clock class="h-3.5 w-3.5" /> started{" "}
                        <RelativeTime epochMs={r().startedAt ?? r().createdAt} />
                      </span>
                      <Show when={formatDuration(r().startedAt, r().completedAt)}>
                        {(d) => <span>in {d()}</span>}
                      </Show>
                    </div>
                  </div>

                  <div class="flex shrink-0 items-center gap-2">
                    <Button variant="default" onClick={() => void doRerun()} disabled={busy() !== null}>
                      <Show when={busy() === "rerun"} fallback={<><Icons.Refresh class="h-4 w-4" /> Re-run</>}>
                        <Icons.Loader class="h-4 w-4 animate-spin" /> Re-running…
                      </Show>
                    </Button>
                    <Show when={!isTerminal(r().status)}>
                      <Button variant="danger" onClick={() => void doCancel()} disabled={busy() !== null}>
                        <Show when={busy() === "cancel"} fallback={<><Icons.Square class="h-4 w-4" /> Cancel</>}>
                          <Icons.Loader class="h-4 w-4 animate-spin" /> Cancelling…
                        </Show>
                      </Button>
                    </Show>
                  </div>
                </div>
              </Box>

              <section class="flex flex-col gap-2">
                <h2 class="text-sm font-semibold text-fg">
                  Jobs <span class="font-normal text-muted">{jobs().length}</span>
                </h2>
                <Show when={jobsRes.error}>
                  <Banner tone="danger">Couldn't load jobs for this run.</Banner>
                </Show>
                <Show
                  when={jobs().length > 0}
                  fallback={
                    <Show when={!jobsRes.loading}>
                      <Box class="px-4 py-6 text-center text-sm text-muted">
                        No jobs have been recorded for this run yet.
                      </Box>
                    </Show>
                  }
                >
                  <div class="flex flex-col gap-2">
                    <Index each={jobs()}>
                      {(job, i) => (
                        <JobCard
                          owner={props.owner}
                          repo={props.repo}
                          job={job()}
                          defaultOpen={jobs().length === 1 || (i === 0 && !isTerminal(job().status))}
                        />
                      )}
                    </Index>
                  </div>
                </Show>
              </section>

              <ArtifactsList owner={props.owner} repo={props.repo} runId={props.runId} />
            </>
          )}
        </Show>
      </Show>
    </div>
  );
}
