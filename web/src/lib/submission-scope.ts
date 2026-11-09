import { createMemo } from "solid-js";
import { useRepo } from "../app/RepoLayout.tsx";
import { useSession } from "../store/session.tsx";

/** Current authenticated metadata, never the previous route's `detail.latest`. */
export function useSubmissionScope(owner?: () => string, name?: () => string) {
  const repo = useRepo(), session = useSession();
  return createMemo(() => {
    const o = owner?.() ?? repo.owner(), r = name?.() ?? repo.repo(), detail = repo.detail(), state = session.state();
    return detail?.id && detail.owner.toLowerCase() === o.toLowerCase() && detail.name.toLowerCase() === r.toLowerCase()
      && state?.authenticated && /^[A-Za-z0-9_-]{43}$/u.test(state.recoveryScope)
      ? { owner: o, repo: r, repositoryId: detail.id, recoveryScope: state.recoveryScope } : null;
  }, undefined, { equals: (a, b) => a?.owner === b?.owner && a?.repo === b?.repo
    && a?.repositoryId === b?.repositoryId && a?.recoveryScope === b?.recoveryScope });
}
