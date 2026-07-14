/**
 * Actions client — workflows, runs, jobs, logs, artifacts, secrets. Backs the
 * Actions views. The runner is self-hosted inside takos-git (Container + DO);
 * these routes dispatch to the in-worker runner, not an external Interface.
 */
import { api, getPage, repoPath, downloadUrl, type Page } from "./client.ts";
import type {
  WorkflowArtifactDto,
  WorkflowDto,
  WorkflowJobDto,
  WorkflowRunDto,
  WorkflowSecretDto,
} from "./types.ts";

export interface RunListFilter {
  readonly workflow?: string;
  readonly status?: string;
  readonly branch?: string;
  readonly event?: string;
  readonly limit?: number;
  readonly cursor?: string | null;
}

export const actionsApi = {
  workflows(owner: string, repo: string, signal?: AbortSignal): Promise<Page<WorkflowDto>> {
    return getPage<WorkflowDto>(`${repoPath(owner, repo)}/workflows`, "workflows", {}, signal);
  },

  runs(owner: string, repo: string, filter: RunListFilter = {}, signal?: AbortSignal): Promise<Page<WorkflowRunDto>> {
    const { limit, cursor, ...rest } = filter;
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(rest)) if (v != null && v !== "") params.set(k, String(v));
    const qs = params.toString();
    return getPage<WorkflowRunDto>(`${repoPath(owner, repo)}/actions/runs${qs ? `?${qs}` : ""}`, "runs", { limit, cursor }, signal);
  },

  run(owner: string, repo: string, runId: string, signal?: AbortSignal): Promise<{ run: WorkflowRunDto }> {
    return api.get(`${repoPath(owner, repo)}/actions/runs/${encodeURIComponent(runId)}`, undefined, signal);
  },

  jobs(owner: string, repo: string, runId: string, signal?: AbortSignal): Promise<Page<WorkflowJobDto>> {
    return getPage<WorkflowJobDto>(`${repoPath(owner, repo)}/actions/runs/${encodeURIComponent(runId)}/jobs`, "jobs", {}, signal);
  },

  job(owner: string, repo: string, jobId: string, signal?: AbortSignal): Promise<{ job: WorkflowJobDto }> {
    return api.get(`${repoPath(owner, repo)}/actions/jobs/${encodeURIComponent(jobId)}`, undefined, signal);
  },

  jobLogsUrl(owner: string, repo: string, jobId: string): string {
    return downloadUrl(`${repoPath(owner, repo)}/actions/jobs/${encodeURIComponent(jobId)}/logs`);
  },

  /** Same-origin WS/SSE URL for a live run log/status stream. */
  runStreamUrl(owner: string, repo: string, runId: string): string {
    return downloadUrl(`${repoPath(owner, repo)}/actions/runs/${encodeURIComponent(runId)}/ws`);
  },

  artifacts(owner: string, repo: string, runId: string, signal?: AbortSignal): Promise<Page<WorkflowArtifactDto>> {
    return getPage<WorkflowArtifactDto>(`${repoPath(owner, repo)}/actions/runs/${encodeURIComponent(runId)}/artifacts`, "artifacts", {}, signal);
  },

  artifactDownloadUrl(owner: string, repo: string, artifactId: string): string {
    return downloadUrl(`${repoPath(owner, repo)}/actions/artifacts/${encodeURIComponent(artifactId)}`);
  },

  secrets(owner: string, repo: string, signal?: AbortSignal): Promise<Page<WorkflowSecretDto>> {
    return getPage<WorkflowSecretDto>(`${repoPath(owner, repo)}/actions/secrets`, "secrets", {}, signal);
  },

  // --- writes ---------------------------------------------------------------

  dispatch(owner: string, repo: string, path: string, input: { ref: string; inputs?: Record<string, string> }): Promise<{ run: WorkflowRunDto }> {
    return api.post(`${repoPath(owner, repo)}/workflows/${path.split("/").map(encodeURIComponent).join("/")}/dispatch`, input);
  },

  cancel(owner: string, repo: string, runId: string): Promise<{ run: WorkflowRunDto }> {
    return api.post(`${repoPath(owner, repo)}/actions/runs/${encodeURIComponent(runId)}/cancel`);
  },

  rerun(owner: string, repo: string, runId: string): Promise<{ run: WorkflowRunDto }> {
    return api.post(`${repoPath(owner, repo)}/actions/runs/${encodeURIComponent(runId)}/rerun`);
  },

  setSecret(owner: string, repo: string, name: string, value: string): Promise<void> {
    return api.put(`${repoPath(owner, repo)}/actions/secrets/${encodeURIComponent(name)}`, { value });
  },

  deleteSecret(owner: string, repo: string, name: string): Promise<void> {
    return api.del(`${repoPath(owner, repo)}/actions/secrets/${encodeURIComponent(name)}`);
  },
};
