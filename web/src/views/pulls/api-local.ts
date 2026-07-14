/**
 * Local conflict-inspection reader.
 *
 * WHY THIS EXISTS (integrator note): the `GET …/pulls/:n/conflicts` route
 * returns **HTTP 409** together with a NON-envelope JSON body
 * (`{ mergeable, mergeBase, conflicts }`) whenever the PR is not mergeable —
 * i.e. exactly the case the conflict resolver needs. The frozen typed client
 * (`api/client.ts`) throws on any non-2xx and only recovers `body.error.*`, so
 * `pullsApi.conflicts()` discards the conflict list on 409. This shim reads the
 * body for both 200 (mergeable) and 409 (has conflicts) while reusing the
 * client's `repoPath` + `ApiError` + same-origin/cookie conventions. It should
 * be folded back into `pullsApi.conflicts` (or the endpoint changed to 200) by
 * the integrator; kept view-local per the seam rules until then.
 */
import { ApiError, repoPath } from "../../api/client.ts";
import type { ConflictsResponse } from "./types.ts";

export async function loadConflicts(
  owner: string,
  repo: string,
  number: number,
  signal?: AbortSignal,
): Promise<ConflictsResponse> {
  const res = await fetch(`${repoPath(owner, repo)}/pulls/${number}/conflicts`, {
    credentials: "same-origin",
    headers: { accept: "application/json" },
    signal,
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = {};
  }
  // 200 = mergeable, 409 = has conflicts; both carry the inspection payload.
  if (res.status === 200 || res.status === 409) {
    return {
      mergeable: body.mergeable === true,
      mergeBase: (body.mergeBase as string | null) ?? null,
      conflicts: (body.conflicts as ConflictsResponse["conflicts"]) ?? [],
      message: typeof body.message === "string" ? body.message : undefined,
    };
  }
  const err = body.error as { code?: string; message?: string; details?: Record<string, unknown> } | undefined;
  throw new ApiError(
    res.status,
    err?.code ?? "http_error",
    err?.message ?? res.statusText ?? `Request failed (${res.status})`,
    err?.details,
  );
}
