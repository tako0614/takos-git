/**
 * Local asset-upload helper.
 *
 * The frozen `releasesApi.uploadAsset` posts the raw File body but does NOT
 * append the `?name=` query parameter the worker requires for raw (non
 * multipart) uploads — `readUpload` returns 422 `name_required` without it. So
 * this view drives the upload through the frozen low-level `api.upload` verb
 * (NOT hand-rolled fetch) with the correct URL + `?name=`.
 *
 * INTEGRATOR REQUEST: fold this into `releasesApi.uploadAsset` by appending
 * `?name=<encoded filename>` (or by sending multipart FormData) so the view can
 * drop this local shim.
 */
import { api, repoPath, type ReleaseAssetDto } from "../../api";

export function uploadReleaseAsset(
  owner: string,
  repo: string,
  tag: string,
  file: File,
): Promise<{ asset: ReleaseAssetDto }> {
  const name = file.name || "asset";
  const path = `${repoPath(owner, repo)}/releases/${encodeURIComponent(tag)}/assets?name=${encodeURIComponent(name)}`;
  return api.upload<{ asset: ReleaseAssetDto }>(path, file);
}
