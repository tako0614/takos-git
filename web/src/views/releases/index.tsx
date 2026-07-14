import { type JSX } from "solid-js";
import { useRepo } from "../../app/RepoLayout.tsx";
import { releasesApi } from "../../api/releases.ts";
import { Seam } from "../_seam.tsx";
import { Probe } from "../_probe.tsx";

export function ReleasesView(): JSX.Element {
  const repo = useRepo();
  return (
    <Seam
      feature="Releases"
      summary="List releases with tag/name/body (Markdown), assets download, create/edit/delete + asset upload (maintainer). Ported from takos release-crud/release-assets."
      apiModule="releasesApi (api/releases.ts): list, latest, get, assets, create, update, uploadAsset, assetDownloadUrl"
      components={["ReleaseList", "ReleaseDetail", "asset upload", "Markdown (ui)"]}
      routes={["/:owner/:repo/releases"]}
    >
      <Probe
        label="Releases"
        fetcher={() => releasesApi.list(repo.owner(), repo.repo())}
        render={(page) => `${page.items.length}${page.nextCursor ? "+" : ""}`}
      />
    </Seam>
  );
}
