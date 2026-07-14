/**
 * Releases + assets client. Backs the Releases view.
 */
import { api, getPage, repoPath, downloadUrl, type Page } from "./client.ts";
import type { ReleaseAssetDto, ReleaseDto } from "./types.ts";

export const releasesApi = {
  list(owner: string, repo: string, params: { limit?: number; cursor?: string | null } = {}, signal?: AbortSignal): Promise<Page<ReleaseDto>> {
    return getPage<ReleaseDto>(`${repoPath(owner, repo)}/releases`, "releases", params, signal);
  },

  latest(owner: string, repo: string, signal?: AbortSignal): Promise<{ release: ReleaseDto }> {
    return api.get(`${repoPath(owner, repo)}/releases/latest`, undefined, signal);
  },

  get(owner: string, repo: string, tag: string, signal?: AbortSignal): Promise<{ release: ReleaseDto }> {
    return api.get(`${repoPath(owner, repo)}/releases/${encodeURIComponent(tag)}`, undefined, signal);
  },

  assets(owner: string, repo: string, tag: string, signal?: AbortSignal): Promise<Page<ReleaseAssetDto>> {
    return getPage<ReleaseAssetDto>(`${repoPath(owner, repo)}/releases/${encodeURIComponent(tag)}/assets`, "assets", {}, signal);
  },

  assetDownloadUrl(owner: string, repo: string, tag: string, assetId: string): string {
    return downloadUrl(`${repoPath(owner, repo)}/releases/${encodeURIComponent(tag)}/assets/${encodeURIComponent(assetId)}/download`);
  },

  // --- writes ---------------------------------------------------------------

  create(owner: string, repo: string, input: { tag: string; name?: string; body?: string; targetSha?: string; draft?: boolean; prerelease?: boolean }): Promise<{ release: ReleaseDto }> {
    return api.post(`${repoPath(owner, repo)}/releases`, input);
  },

  update(owner: string, repo: string, tag: string, patch: Partial<{ name: string; body: string; draft: boolean; prerelease: boolean }>): Promise<{ release: ReleaseDto }> {
    return api.patch(`${repoPath(owner, repo)}/releases/${encodeURIComponent(tag)}`, patch);
  },

  remove(owner: string, repo: string, tag: string): Promise<void> {
    return api.del(`${repoPath(owner, repo)}/releases/${encodeURIComponent(tag)}`);
  },

  uploadAsset(owner: string, repo: string, tag: string, file: Blob): Promise<{ asset: ReleaseAssetDto }> {
    return api.upload(`${repoPath(owner, repo)}/releases/${encodeURIComponent(tag)}/assets`, file);
  },
};
