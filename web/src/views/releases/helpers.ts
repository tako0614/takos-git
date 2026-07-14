/**
 * Small pure helpers for the Releases view. No shell / api coupling.
 */
import type { ReleaseDto } from "../../api";

/** Human-readable byte size (GitHub-style: "1.2 MB"). */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exp;
  const rounded = exp === 0 ? value : Math.round(value * 10) / 10;
  return `${rounded} ${units[exp]}`;
}

/** The display heading for a release: its name, falling back to the tag. */
export function releaseTitle(release: ReleaseDto): string {
  return release.name?.trim() || release.tag;
}

/**
 * GitHub marks exactly one release as "Latest": the newest published
 * (non-draft, non-prerelease) release. The list arrives newest-first, so the
 * first qualifying tag wins.
 */
export function latestTagOf(releases: readonly ReleaseDto[]): string | null {
  for (const r of releases) {
    if (!r.isDraft && !r.isPrerelease) return r.tag;
  }
  return null;
}

/** Total download count across a release's assets. */
export function totalDownloads(release: ReleaseDto): number {
  return release.assets.reduce((sum, a) => sum + (a.downloadCount || 0), 0);
}
