import type { RepositoryDto } from "../../api/types.ts";

/** Case-insensitive match against repo name, owner, description, visibility, or default branch. */
export function filterRepositories(
  repos: readonly RepositoryDto[],
  rawQuery: string,
): readonly RepositoryDto[] {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return repos;
  return repos.filter(
    (repo) =>
      `${repo.owner}/${repo.name}`.toLowerCase().includes(q) ||
      (repo.description ?? "").toLowerCase().includes(q) ||
      repo.visibility.toLowerCase().includes(q) ||
      repo.defaultBranch.toLowerCase().includes(q),
  );
}
