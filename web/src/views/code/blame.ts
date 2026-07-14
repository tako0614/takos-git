/**
 * Local blame client for the blob viewer.
 *
 * The frozen `reposApi` (api/repos.ts) does not (yet) expose the `blame` route,
 * so per the view-partitioning contract this small typed wrapper lives inside
 * the code view and is layered on the FROZEN low-level `api` verb helper +
 * `repoPath` from `api/client.ts` (consuming, not editing, the shared client).
 * If promoted, move `blame()` onto `reposApi` and delete this file.
 *
 * Backend: `GET /api/v1/repos/:owner/:repo/blame?ref=&path=` →
 * `code-browser.ts` `handleBlame`.
 */
import { api, repoPath, type Query } from "../../api/client.ts";

export interface BlameLine {
  readonly line: number;
  readonly content: string;
  readonly commitSha: string;
  readonly authorName: string;
  readonly authorEmail: string;
  /** ISO 8601, or null when unavailable. */
  readonly date: string | null;
  readonly message: string;
}

export interface BlameResponse {
  readonly repository: string;
  readonly ref: string;
  readonly path: string;
  readonly resolvedCommitSha: string;
  readonly truncated: boolean;
  readonly lines: readonly BlameLine[];
}

export function fetchBlame(
  owner: string,
  repo: string,
  path: string,
  ref: string,
  signal?: AbortSignal,
): Promise<BlameResponse> {
  return api.get<BlameResponse>(`${repoPath(owner, repo)}/blame`, { path, ref } as Query, signal);
}
