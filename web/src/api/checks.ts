/**
 * Check runs + commit statuses client. Backs status badges on commits/PRs and
 * the checks surface. Producers (the self-hosted runner, external automation)
 * publish through the same routes.
 */
import { api, repoPath } from "./client.ts";
import type { CheckRunDto, CombinedStatusDto, CommitStatusDto } from "./types.ts";

export const checksApi = {
  combinedStatus(owner: string, repo: string, sha: string, signal?: AbortSignal): Promise<CombinedStatusDto> {
    return api.get<CombinedStatusDto>(`${repoPath(owner, repo)}/commits/${encodeURIComponent(sha)}/status`, undefined, signal);
  },

  statuses(owner: string, repo: string, sha: string, signal?: AbortSignal): Promise<{ statuses: readonly CommitStatusDto[] }> {
    return api.get(`${repoPath(owner, repo)}/commits/${encodeURIComponent(sha)}/statuses`, undefined, signal);
  },

  checkRuns(owner: string, repo: string, sha: string, signal?: AbortSignal): Promise<{ checkRuns: readonly CheckRunDto[] }> {
    return api.get(`${repoPath(owner, repo)}/commits/${encodeURIComponent(sha)}/check-runs`, undefined, signal);
  },

  checkRun(owner: string, repo: string, id: string, signal?: AbortSignal): Promise<{ checkRun: CheckRunDto }> {
    return api.get(`${repoPath(owner, repo)}/check-runs/${encodeURIComponent(id)}`, undefined, signal);
  },
};
