import { createSignal, Index, Show, type JSX } from "solid-js";
import {
  ApiError,
  releasesApi,
  type ReleaseAssetDto,
} from "../../api";
import { Box, BoxHeader, BoxRow, Button, Icons, useToast } from "../../ui";
import { formatBytes } from "./helpers.ts";
import { uploadReleaseAsset } from "./upload.ts";

interface ReleaseAssetsProps {
  owner: string;
  repo: string;
  tag: string;
  assets: readonly ReleaseAssetDto[];
  /** Whether the viewer may upload (signed in + write access — server enforces). */
  canWrite: boolean;
  /** Refetch the parent release after a successful upload. */
  onChanged: () => void;
}

/** The "Assets" box on a release: downloadable files + an uploader for writers. */
export function ReleaseAssets(props: ReleaseAssetsProps): JSX.Element {
  const toast = useToast();
  const [uploading, setUploading] = createSignal(false);
  let fileInput: HTMLInputElement | undefined;

  const onPick = async (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    setUploading(true);
    try {
      await uploadReleaseAsset(props.owner, props.repo, props.tag, file);
      toast.success(`Uploaded ${file.name}.`);
      props.onChanged();
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.code === "asset_exists"
            ? "An asset with that name already exists."
            : err.message
          : "Upload failed.";
      toast.error(message);
    } finally {
      setUploading(false);
    }
  };

  const assetHref = (asset: ReleaseAssetDto) =>
    releasesApi.assetDownloadUrl(props.owner, props.repo, props.tag, asset.id);

  return (
    <Box>
      <BoxHeader class="justify-between">
        <span class="flex items-center gap-2">
          <Icons.Package class="h-4 w-4 text-muted" />
          Assets
          <span class="text-xs font-normal text-muted">({props.assets.length})</span>
        </span>
        <Show when={props.canWrite}>
          <span>
            <input
              ref={fileInput}
              type="file"
              class="hidden"
              aria-hidden="true"
              tabindex={-1}
              onChange={onPick}
            />
            <Button
              size="sm"
              disabled={uploading()}
              onClick={() => fileInput?.click()}
            >
              <Icons.Upload class="h-4 w-4" />
              {uploading() ? "Uploading…" : "Upload asset"}
            </Button>
          </span>
        </Show>
      </BoxHeader>

      <Show
        when={props.assets.length > 0}
        fallback={
          <BoxRow class="text-sm text-muted">No downloadable assets.</BoxRow>
        }
      >
        <Index each={props.assets}>
          {(asset) => (
            <BoxRow class="flex items-center gap-3">
              <Icons.Package class="h-4 w-4 shrink-0 text-muted" />
              <a
                href={assetHref(asset())}
                class="min-w-0 flex-1 truncate text-sm font-medium text-accent hover:underline"
                download={asset().name}
              >
                {asset().name}
              </a>
              <span class="shrink-0 text-xs text-muted">
                {formatBytes(asset().size)}
              </span>
              <Show when={asset().downloadCount > 0}>
                <span
                  class="hidden shrink-0 items-center gap-1 text-xs text-muted sm:flex"
                  title={`${asset().downloadCount} downloads`}
                >
                  <Icons.Download class="h-3 w-3" />
                  {asset().downloadCount}
                </span>
              </Show>
              <a
                href={assetHref(asset())}
                class="shrink-0 text-muted hover:text-accent"
                download={asset().name}
                aria-label={`Download ${asset().name}`}
                title="Download"
              >
                <Icons.Download class="h-4 w-4" />
              </a>
            </BoxRow>
          )}
        </Index>
      </Show>
    </Box>
  );
}
